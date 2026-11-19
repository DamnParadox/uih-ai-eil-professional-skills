import path from 'node:path';
import { mkdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { initProject, loadProject, readJson, writeJson, addSource, commit } from './workspace.mjs';
import { importAnalysis } from './tables.mjs';
import { findAnalysisHeader } from './vendor/urra-measures-input.mjs';
import { createCliRunner, identityFailure } from './lark-cli-runner.mjs';

const refs = sourceId => sourceId ? [sourceId] : [];
export function noteOps(notes = [], sourceId) {
  return notes.map(({ key, ...fields }) => {
    if (!/^\$n[\w-]+$/.test(key)) throw Error('新依据 key 使用唯一的 $n... 别名');
    return { collection: 'notes', id: key, set: { sourceIds: refs(sourceId), ...fields } };
  });
}

// CLI typed sheets use an actual A1 range; do not assume the used region starts at A1.
export function grid(sheet, noHeader = true) {
  if (sheet.truncated || sheet.has_more || sheet.complete === false || !Array.isArray(sheet.data)) throw Error('子表数据不完整');
  const m = (sheet.range || sheet.start_cell || 'A1').match(/^(?:[^!]+!)?([A-Z]+)(\d+)(?::[A-Z]+\d+)?$/);
  if (!m) throw Error('无法确定原表范围');
  const column = [...m[1]].reduce((n, c) => n * 26 + c.charCodeAt(0) - 64, 0) - 1;
  const row = +m[2] - 1;
  const data = noHeader ? sheet.data : [sheet.columns, ...sheet.data];
  return [...Array.from({ length: row }, () => []), ...data.map(r => [...Array(column).fill(''), ...r])];
}

export function mergesFromLayout(layout) {
  if (!Array.isArray(layout.merged_cells)) throw Error('缺少实际合并范围');
  const col = v => [...v].reduce((n, c) => n * 26 + c.charCodeAt(0) - 64, 0) - 1;
  return layout.merged_cells.map(({ range }) => {
    const m = range?.match(/^([A-Z]+)(\d+):([A-Z]+)(\d+)$/);
    if (!m) throw Error('无法识别合并范围');
    return { start_row_index: +m[2] - 1, end_row_index: +m[4] - 1, start_column_index: col(m[1]), end_column_index: col(m[3]) };
  });
}

// Only the published audit schema is decoded automatically. Other reference text
// remains in the source snapshot for semantic interpretation; it is not promoted to fact.
function auditContext(snapshot, ops) {
  const notes = [], aliases = new Map(), links = new Map(), positions = new Map();
  const rows = [];
  for (const sheet of snapshot.auxiliary ?? []) {
    const rs = sheet.rows ?? [];
    const header = rs.findIndex(r => ['类型', '稳定编号', '内容/位置', '来源/关联', '说明'].every((c, i) => r[i] === c));
    if (header >= 0) rows.push(...rs.slice(header + 1));
  }
  for (const [kind, id, text, , reason] of rows) {
    if (!['fact', 'assumption', 'decision'].includes(kind) || !id || !text) continue;
    if (aliases.has(id)) throw Error('辅助依据中存在重复编号，请先确定版本');
    const key = '$nImport' + notes.length;
    aliases.set(id, key);
    notes.push({ key, kind, text, reason: reason || '继承来源分析的依据类型，未额外验证' });
  }
  for (const [kind, id, text, associated] of rows) {
    if (kind === '行映射') {
      const m = String(text).match(/^(.+)!(\d+)$/);
      if (m && m[1] === snapshot.sheetName) positions.set(id, +m[2]);
    }
    if (kind === '依据') links.set(id, { basis: String(text || ''), noteIds: String(associated || '').split(/[,，]\s*/).map(v => aliases.get(v)).filter(Boolean) });
  }
  for (const [id, row] of positions) {
    const error = ops.find(op => op.collection === 'errors' && op.set.sourceRow === row);
    const step = error && ops.find(op => op.id === error.set.stepId);
    const link = links.get(id);
    if (step && link) Object.assign(step.set, link);
  }
  return noteOps(notes, snapshot.sourceId);
}

export async function prepare(dir, input, decisions = {}) {
  const state = await loadProject(dir);
  if (state.tasks.length || state.steps.length || state.errors.length) throw Error('项目已有输入；使用 context 继续，输入修订按稳定 ID 提交补丁');
  let result;
  if (Array.isArray(input.steps)) {
    if (input.complete !== true) throw Error('文本提取须确认 complete:true，保持原步骤及使用错误完整');
    const ops = noteOps(input.notes, input.sourceId);
    let previous, taskId;
    for (const step of input.steps) {
      if (!Array.isArray(step.errors)) throw Error('每步需要明确 errors 数组；缺少使用错误时不能补造');
      const key = JSON.stringify([step.purpose, step.task]);
      if (key !== previous) {
        taskId = '$t' + ops.length; previous = key;
        ops.push({ collection: 'tasks', id: taskId, set: { purpose: step.purpose || '来源未填写使用目的', name: step.task || '来源未填写关键任务', sourceIds: refs(input.sourceId) } });
      }
      const { errors, purpose, task, ...fields } = step;
      const stepId = '$s' + ops.length;
      ops.push({ collection: 'steps', id: stepId, set: { ...fields, taskId, sourceIds: fields.sourceIds || refs(input.sourceId) } });
      for (const error of errors) ops.push({ collection: 'errors', id: '$e' + ops.length,
        set: { ...(typeof error === 'string' ? { text: error } : error), stepId, sourceIds: refs(input.sourceId) } });
    }
    if (!ops.some(op => op.collection === 'errors')) throw Error('资料中没有已列出的使用错误，请确认输入或先做任务分析');
    result = { ready: true, patch: { baseRevision: state.revision, reason: '接入已明确步骤与错误的文字资料', ops }, skipped: [] };
  } else {
    result = importAnalysis(state, input, decisions);
    if (!result.ready) return result;
    result.patch.ops.unshift(...auditContext(input, result.patch.ops));
  }
  const saved = await commit(dir, result.patch);
  return { ready: true, revision: saved.state.revision, steps: saved.state.steps.length, errors: saved.state.errors.length,
    notes: saved.state.notes.length, skipped: result.skipped };
}

export async function readAnalysis(dir, url, selected, run = createCliRunner()) {
  const parsed = new URL(url);
  const initial = await loadProject(dir).catch(error => {
    if (error.code !== 'ENOENT' || path.resolve(error.path || '') !== path.resolve(dir, 'project.json')) throw error;
    return initProject(dir, 'URRA措施');
  });
  if (initial.errors.length) throw Error('项目已有任务分析。接续时核对 inputs/current.json 的文件和目标子表，再用 context；分析新链接或最新内容时使用新的项目目录。');
  const hinted = selected || parsed.searchParams.get('sheet');
  parsed.search = ''; parsed.hash = '';
  const relative = 'inputs/' + randomUUID();
  await mkdir(path.join(dir, relative), { recursive: true });
  let prior;
  for (const identity of ['user', 'bot']) {
    const cli = args => run([...args, '--as', identity], { cwd: dir, timeoutMs: 0 });
    try {
      const inspected = await cli(['drive', '+inspect', '--url', parsed.href]);
      if (inspected.data?.type !== 'sheet' || !inspected.data.token) throw Error('链接不是电子表格。请读取实际文档内容，确认含步骤与使用错误后按文字输入接入。');
      const token = inspected.data.token;
      const rawPath = relative + '/workbook.json';
      const receipt = await cli(['sheets', '+table-get', '--spreadsheet-token', token, '--no-header', '--output-path', rawPath]);
      if (receipt.data?.complete !== true || receipt.identity !== identity) throw Error('读取未完成或身份不一致，不能导入部分表格');
      const book = await readJson(path.join(dir, rawPath));
      if (book.complete === false || book.truncated || book.has_more || book.unread_sheets?.length || !Array.isArray(book.sheets)) throw Error('工作簿读取不完整');
      const candidates = book.sheets.map(sheet => ({ sheet, rows: grid(sheet) })).filter(s => findAnalysisHeader(s.rows));
      let chosen = hinted && candidates.find(s => s.sheet.sheet_id === hinted || s.sheet.name === hinted);
      if (selected && !chosen) throw Error('指定子表未找到步骤与使用错误，请核对目标');
      if (!chosen && candidates.length === 1) chosen = candidates[0];
      if (!chosen) throw Error(candidates.length ? '有多个任务分析子表，请指定：' + candidates.map(s => s.sheet.name).join('、') : '所给文件没有任务分析的步骤和使用错误，请确认');
      const layout = await cli(['sheets', '+sheet-info', '--spreadsheet-token', token, '--sheet-name', chosen.sheet.name, '--include', 'merges']);
      const sheetId = layout.data?.sheet_id || chosen.sheet.sheet_id;
      if (!sheetId) throw Error('缺少真实子表 ID');
      const snapshot = { complete: true, sheetId, sheetName: chosen.sheet.name, rows: chosen.rows, merges: mergesFromLayout(layout.data),
        auxiliary: book.sheets.filter(s => s !== chosen.sheet).map(s => ({ name: s.name, rows: grid(s) })) };
      const file = path.join(dir, relative, 'snapshot.json');
      await writeJson(file, snapshot);
      const old = initial.sources.find(s => s.url === url);
      const registered = await addSource(dir, file, { ...(old ? { id: old.id } : {}), url, label: chosen.sheet.name });
      snapshot.sourceId = old?.id || registered.sources.at(-1).id;
      await writeJson(file, snapshot);
      const input = { identity, url, sourceId: snapshot.sourceId, sheetId, file };
      await writeJson(path.join(dir, 'inputs/current.json'), input);
      return { ...input, ...await prepare(dir, snapshot) };
    } catch (error) {
      if (!identityFailure(error)) throw error;
      if (identity === 'bot') throw Error('用户与应用身份均无法访问。user: ' + prior.message + '；bot: ' + error.message);
      prior = error;
    }
  }
}
