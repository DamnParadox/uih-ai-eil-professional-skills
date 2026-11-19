import path from 'node:path';
import { mkdir, open, rename, unlink, readdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { readJson, writeJson, loadProject } from './workspace.mjs';
import { exportTable, column } from './tables.mjs';
import { createCliRunner, identityFailure } from './lark-cli-runner.mjs';

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const values = rows => rows.map(row => row.map(v => v ?? ''));
function identityRejectedBeforeCreate(error) {
  return ['token_missing', 'identity_unavailable'].includes(error.response?.error?.subtype) ||
    (identityFailure(error) && error.response?.data?.created === false);
}
async function checkpoint(file, data) {
  const temp = file + '.' + randomUUID() + '.tmp';
  await writeJson(temp, data);
  // A Windows indexer can briefly hold the previous checkpoint. Keep it intact while retrying.
  for (let attempt = 0; ; attempt++) {
    try { await rename(temp, file); return; }
    catch (e) {
      if (!['EPERM', 'EBUSY', 'EACCES'].includes(e.code) || attempt >= 4) throw e;
      await delay(50 * (attempt + 1));
    }
  }
}

// Feishu can coalesce adjacent dimensions of the same size in a single span.
function checkLayout(style, layout) {
  if (!style.freeze) return; // Older exports did not specify fixed headers.
  if (layout.frozen_rows !== style.freeze.rows || layout.frozen_columns !== style.freeze.cols)
    throw Error(style.name + '：冻结行列与导出不符');
  const columnNumber = letters => Array.from(letters).reduce((n, c) => n * 26 + c.charCodeAt(0) - 64, 0);
  for (const expected of style.col_sizes || []) {
    const index = columnNumber(expected.range.split(':')[0]);
    const found = layout.column_widths?.some(span => {
      const [first, last] = span.cols.split(':').map(columnNumber);
      return first <= index && index <= last && span.width === expected.size;
    });
    if (!found) throw Error(style.name + '：' + expected.range + ' 列宽与导出不符');
  }
  const heights = (layout.row_heights || []).map(span => {
    const [first, last] = span.rows.split(':').map(Number);
    return { ...span, first, last };
  }).sort((a, b) => a.first - b.first);
  for (const expected of style.row_sizes || []) {
    let [next, end] = expected.range.split(':').map(Number);
    for (const span of heights) {
      if (span.first <= next && next <= span.last && (expected.type === 'auto' ? span.type === 'auto' : span.height === expected.size))
        next = span.last + 1;
    }
    if (next <= end) throw Error(style.name + '：' + expected.range + ' 行高与导出不符');
  }
}

export function verifySheets(expected, remote, layouts) {
  if (remote.has_more || remote.truncated || !Array.isArray(remote.sheets)) throw Error('表格回读不完整');
  return expected.sheets.sheets.map((sheet, index) => {
    const actual = remote.sheets.find(r => r.name === sheet.name);
    if (!actual || actual.truncated || actual.has_more || !same(sheet.columns, actual.columns) ||
        !same(values(sheet.data), values(actual.data))) throw Error(sheet.name + '：回读值或行列不一致');
    const layout = layouts[index];
    if (!Array.isArray(layout?.merged_cells) || (layout.sheet_name && layout.sheet_name !== sheet.name)) throw Error(sheet.name + '：缺少对应的合并回读');
    const style = expected.styles.styles[index];
    const merges = style.cell_merges || [];
    if (!same(merges.map(m => m.range).sort(), layout.merged_cells.map(m => m.range).sort())) throw Error(sheet.name + '：合并范围不一致');
    checkLayout(style, layout);
    return { sheet: sheet.name, rows: actual.data.length, merges: merges.length, layoutVerified: Boolean(style.freeze) };
  });
}

export function verifyStyleSample(style, sample, data) {
  const actual = data.ranges?.find(r => r.actual_range === sample.range);
  if (data.has_more || data.truncated || !actual || actual.truncated || actual.has_more ||
      !same(actual.row_indices, sample.rows) || !same(actual.col_indices, sample.columns) ||
      actual.cells?.length !== sample.rows.length) throw Error(style.name + '：样式抽查范围不完整');
  for (const [i, row] of actual.cells.entries()) {
    if (row.length !== sample.columns.length) throw Error(style.name + '：样式抽查列不完整');
    const expected = { ...style.cell_styles[0], ...(sample.rows[i] === 1 ? style.cell_styles[1] : {}) };
    delete expected.range;
    for (const cell of row) for (const [key, value] of Object.entries(expected))
      if (cell.cell_styles?.[key] !== value) throw Error(style.name + '：样式抽查不符 ' + sample.range + ' / ' + key);
  }
  return { sheet: style.name, range: sample.range };
}

async function verifyRecipient(record, state, editor, cli, persist) {
  const needsRecipient = () => Error('已建表 ' + record.url + '。主资料由应用所有或无法确定接收人；请指定已授权接收人的 openid:ou_...，在原项目补授编辑权限。');
  // Metadata uses open_id even when the owner's ACL entry uses appid.
  if (!record.botOpenId || !record.resultOwner || (!editor && !record.recipient && !record.sourceOwner)) {
    const bot = await cli(['api', 'GET', '/open-apis/bot/v3/info']);
    const botId = bot.data?.open_id;
    if (!/^ou_[\w-]+$/.test(botId || '')) throw Error('已建表 ' + record.url + '。未能核实当前应用身份，保留原表后重试。');
    let sourceResource = editor ? undefined : record.sourceResource;
    const sourceUrl = state.sources.find(s => s.id === record.source)?.url;
    if (!sourceResource && sourceUrl && !editor) {
      const { data } = await cli(['drive', '+inspect', '--url', sourceUrl]);
      if (!data?.token || !data.type) throw Error('主资料资源标识不完整');
      sourceResource = { doc_token: data.token, doc_type: data.type };
    }
    const resultResource = { doc_token: record.token, doc_type: 'sheet' };
    const docs = [resultResource, ...(sourceResource ? [sourceResource] : [])];
    const meta = await cli(['drive', 'metas', 'batch_query', '--user-id-type', 'open_id', '--data', JSON.stringify({ request_docs: docs })]);
    const owner = resource => meta.data?.metas?.find(m => m.doc_token === resource.doc_token && m.doc_type === resource.doc_type)?.owner_id;
    const resultOwner = owner(resultResource), sourceOwner = sourceResource && owner(sourceResource);
    if (!/^ou_[\w-]+$/.test(resultOwner || '') || (sourceResource && !/^ou_[\w-]+$/.test(sourceOwner || '')))
      throw Error('已建表 ' + record.url + '。文件所有者元数据不完整，保留原表后重试。');
    Object.assign(record, { botOpenId: botId, resultOwner });
    if (sourceResource) Object.assign(record, { sourceOwner, sourceResource });
    record.ownerVerified = resultOwner === botId ? botId : undefined;
    await persist();
  }
  // Old receipts may have incorrectly recorded the bot owner as the editor.
  const prior = record.recipient || record.requesterEditorVerified ||
    [record.editor, record.editorVerified].find(id => id && id !== record.botOpenId);
  if (editor && prior && editor !== prior) throw Error('续做时协作者须与原授权对象一致。');
  const recipient = editor || prior || (record.sourceOwner !== record.botOpenId ? record.sourceOwner : undefined);
  if (!/^ou_[\w-]+$/.test(recipient || '') || recipient === record.botOpenId) throw needsRecipient();
  record.recipient = recipient;
  record.editor = recipient;
  await persist(); // A failed grant is resumed by reading the current ACL first.
  if (recipient !== record.resultOwner) {
    const target = ['--token', record.token, '--type', 'sheet'];
    const editable = async () => {
      const list = await cli(['drive', '+member-list', ...target]);
      if (!Array.isArray(list.data?.items) || list.data.has_more || list.data.truncated) throw Error('协作者列表不完整');
      return list.data.items.some(m => m.member_type === 'openid' && m.member_id === recipient && ['edit', 'full_access'].includes(m.perm));
    };
    if (!await editable()) {
      await cli(['drive', '+member-add', ...target, '--member-id', recipient, '--member-type', 'openid', '--perm', 'edit', '--yes']);
      if (!await editable()) throw Error('未回读到目标协作者的编辑权限。');
    }
  }
  Object.assign(record, { recipientVerified: recipient, editorVerified: recipient, permissionsVersion: 2 });
}

export async function publishSheets(kind, dir, identity, sourceOrEditor, run = createCliRunner(), requestedTitle) {
  if (!['analysis', 'measures'].includes(kind)) throw Error('未知交付类型');
  const title = kind === 'analysis' ? 'URRA任务分析' : 'URRA措施';
  if (!['user', 'bot'].includes(identity)) throw Error('指定已成功读取的身份 user 或 bot；本地输入先用 user。');
  const explicitEditor = sourceOrEditor?.startsWith('openid:');
  const editor = explicitEditor ? sourceOrEditor.slice(7) : undefined;
  if (explicitEditor && !/^ou_[\w-]+$/.test(editor)) throw Error('指定协作者须提供有效的 openid:ou_...。');
  const source = explicitEditor ? undefined : sourceOrEditor;
  const bindings = path.join(dir, 'bindings');
  await mkdir(bindings, { recursive: true });
  const lock = path.join(bindings, kind + '-publish.lock');
  const handle = await open(lock, 'wx').catch(e => {
    if (e.code === 'EEXIST') throw Error('正在交付；异常退出时，确认无运行进程后再移除 对应 publish.lock。');
    throw e;
  });
  try {
    const state = await loadProject(dir);
    const defaultTitle = state.name.endsWith(title) ? state.name : state.name + '-' + title;
    const file = path.join(bindings, kind + '-delivery.json');
    let record = await readJson(file).catch(e => { if (e.code !== 'ENOENT') throw e; return null; });
    if (record && (record.projectId !== state.id || record.revision !== state.revision))
      throw Error('已有其他项目版本的交付记录，请按局部同步流程核对原表。');
    if (!record && (await readdir(bindings)).some(f => /^(?:workbook|create|baseline|verification)(?:[.-]|$)/.test(f)))
      throw Error('已有旧版飞书交付记录，请从原回执继续或按局部同步流程更新。');
    // Older receipts stored either a source ID or an explicit collaborator in source.
    const legacyEditor = record?.source?.startsWith('openid:') ? record.source.slice(7) : undefined;
    const previousEditor = record?.recipient;
    if (source && !state.sources.some(s => s.id === source)) throw Error('主资料来源 ID 无效，请使用项目已登记的来源。');
    if (source && record?.source && !legacyEditor && record.source !== source) throw Error('续做时主资料须与原交付记录一致。');
    if (editor && previousEditor && editor !== previousEditor) throw Error('续做时协作者须与原授权对象一致。');
    if (record?.phase === 'verified') {
      if (record.identity !== 'bot' || (record.permissionsVersion === 2 && !editor)) return record;
      // An explicit repair can follow a later permission change on the remote sheet.
      if (!record.editor && record.editorVerified) record.editor = record.editorVerified;
      delete record.editorVerified;
      delete record.recipientVerified;
      record.phase = 'content-verified';
      await checkpoint(file, record);
    }
    const output = 'exports/' + kind + '/r' + state.revision;
    let report;
    if (record?.phase !== 'content-verified') {
      report = record ? await readJson(path.join(dir, output, 'export.json')) : exportTable(state, kind);
      if (report.projectId !== state.id || report.projectRevision !== state.revision) throw Error('导出快照与项目版本不一致');
    }
    const cli = (args, as = record?.identity || identity) => run([...args, '--as', as], { cwd: dir, timeoutMs: 0 });
    if (!record) {
      for (const [name, data] of Object.entries({ export: report, sheets: report.sheets, styles: report.styles }))
        await writeJson(path.join(dir, output, name + '.json'), data);
      record = { projectId: state.id, revision: state.revision, identity, phase: 'ready' };
      await checkpoint(file, record);
    }
    if (legacyEditor || (source && !record.source) || (editor && !record.editor)) {
      if (legacyEditor) delete record.source;
      if (source) record.source = source;
      if (legacyEditor) record.editor = legacyEditor;
      await checkpoint(file, record);
    }
    const receiptFile = path.join(bindings, kind + '-create.json');
    let receipt;
    if (record.phase === 'creating') {
      receipt = await readJson(receiptFile).catch(e => {
        if (e.code !== 'ENOENT') throw e;
        throw Error('上次创建结果未知。先用 CLI 核对已建文档及回执，再在原表续做；禁止重复创建。');
      });
    }
    if (record.phase === 'ready') {
      record.title = requestedTitle || record.title || defaultTitle;
      // Keep the data actually sent to the CLI identical to this revision's verified snapshot.
      for (const name of ['sheets', 'styles']) {
        if (!same(await readJson(path.join(dir, output, name + '.json')), report[name]))
          throw Error('交付载荷已变更：' + name);
      }
      const create = async () => {
        record.phase = 'creating';
        await checkpoint(file, record);
        try {
          return await cli(['sheets', '+workbook-create', '--title', record.title,
            '--sheets', '@./' + output + '/sheets.json', '--styles', '@./' + output + '/styles.json']);
        } catch (e) {
          if (e.code === 'CLI_UNAVAILABLE' || identityRejectedBeforeCreate(e)) {
            record.phase = 'ready';
            await checkpoint(file, record);
          }
          throw e;
        }
      };
      try { receipt = await create(); } catch (e) {
        // A later write inside +workbook-create can fail after the workbook exists.
        if (record.identity !== 'user' || !identityRejectedBeforeCreate(e)) throw e;
        record.identity = 'bot';
        receipt = await create();
      }
      await checkpoint(receiptFile, receipt);
    }
    if (receipt) {
      const book = receipt.data?.spreadsheet;
      if (!receipt.ok || receipt.identity !== record.identity || !book?.spreadsheet_token || !book.url) throw Error('创建回执缺少结果标识或身份不符，请核对原回执。');
      Object.assign(record, { token: book.spreadsheet_token, url: book.url, sheets: receipt.data.sheets, phase: 'created' });
      await checkpoint(file, record);
    }
    const tokenArg = ['--spreadsheet-token', record.token];
    if (record.phase === 'created') {
      const valuesPath = './bindings/' + kind + '-readback.json';
      const r = await cli(['sheets', '+table-get', ...tokenArg, '--output-path', valuesPath]);
      if (r.data?.complete !== true) throw Error('回读文件不完整');
      const layouts = [];
      for (const s of report.sheets.sheets) {
        const result = record.sheets?.find(item => item.name === s.name);
        if (!result?.sheet_id) throw Error('回执缺少子表编号：' + s.name);
        const info = await cli(['sheets', '+sheet-info', ...tokenArg, '--sheet-id', result.sheet_id, '--include', 'merges,row_heights,col_widths,frozen']);
        layouts.push(info.data);
      }
      const checks = verifySheets(report, await readJson(path.join(dir, valuesPath)), layouts);
      const samples = report.sheets.sheets.flatMap((sheet, index) => {
        const last = sheet.data.length + 1;
        const columns = sheet.columns.map((_, i) => column(i));
        const ranges = [[1, Math.min(2, last)], ...[...new Set([Math.ceil(last / 2), last])].filter(r => r > 2).map(r => [r, r])];
        return ranges.map(([first, end]) => ({ index, range: `A${first}:${columns.at(-1)}${end}`,
          rows: Array.from({ length: end - first + 1 }, (_, i) => first + i), columns }));
      });
      const results = await Promise.allSettled(samples.map(async sample => {
        const sheet = record.sheets.find(s => s.name === report.sheets.sheets[sample.index].name);
        const response = await cli(['sheets', '+cells-get', ...tokenArg, '--sheet-id', sheet.sheet_id, '--range', sample.range, '--include', 'style']);
        return verifyStyleSample(report.styles.styles[sample.index], sample, response.data);
      }));
      const errors = results.filter(r => r.status === 'rejected');
      if (errors.length) throw Error(errors.map(r => r.reason.message).join('；'));
      const styleSamples = results.map(r => r.value);
      await checkpoint(path.join(bindings, kind + '-layouts.json'), layouts);
      await checkpoint(path.join(bindings, 'baseline-' + kind + '.json'), report);
      Object.assign(record, { checks, styleSamples, visualAndClippingVerified: false, phase: 'content-verified' });
      await checkpoint(file, record);
    }
    if (record.identity === 'bot') await verifyRecipient(record, state, editor, cli, () => checkpoint(file, record));
    record.phase = 'verified';
    await checkpoint(file, record);
    return record;
  } finally { await handle.close(); await unlink(lock); }
}
