import path from 'node:path';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { loadProject, commit, readJson, writeJson, resume } from './workspace.mjs';
import { exportTable } from './tables.mjs';
import { publishSheets } from './sheets-delivery.mjs';
import { prepare, readAnalysis, noteOps } from './measures-input.mjs';

const unique = xs => [...new Set(xs)];
function inherited(state, error) {
  const step = state.steps.find(s => s.id === error.stepId);
  const task = state.tasks.find(t => t.id === step.taskId);
  return { step, task, sourceIds: unique([task, step, error].flatMap(r => r.sourceIds || [])),
    noteIds: unique([task, step, error].flatMap(r => r.noteIds || [])) };
}

export function context(state, ratings = false) {
  const records = state.errors.map(e => {
    const { step, task, sourceIds, noteIds } = inherited(state, e);
    const measure = state.measures.find(m => m.errorId === e.id);
    if (ratings) return measure && { errorId: e.id, step: step.action, error: e.text,
      condition: [task.condition, step.condition].filter(Boolean),
      noteIds: unique([...noteIds, ...(measure.noteIds || [])]), basis: measure.basis,
      conclusion: measure.conclusion, paths: measure.paths.map(({ severity, severityReason, ...p }) => p),
      stale: Boolean(measure.stale), rated: measure.paths.every(p => Number.isInteger(p.severity) && p.severityReason) };
    return { errorId: e.id, purpose: task.purpose, task: task.name, step: step.action,
      condition: [task.condition, step.condition].filter(Boolean), pca: step.pca || { p: step.p, c: step.c, a: step.action }, ui: step.ui,
      error: e.text, cause: e.cause, consequence: e.consequence, sourceText: e.sourceText, sourceRow: e.sourceRow,
      sourceIds, noteIds, basis: step.basis, analysis: measure || null };
  }).filter(Boolean);
  return { baseRevision: state.revision, name: state.name, sources: state.sources, notes: state.notes, records,
    missing: state.errors.filter(e => !state.measures.some(m => m.errorId === e.id)).map(e => e.id) };
}

export async function save(dir, draft) {
  const state = await loadProject(dir);
  if (!Array.isArray(draft.records) || !draft.records.length) throw Error('records 不能为空');
  const ops = noteOps(draft.notes);
  const seen = new Set();
  for (const { errorId, ...fields } of draft.records) {
    const error = state.errors.find(e => e.id === errorId);
    if (!error || seen.has(errorId)) throw Error('错误 ID 不存在或重复：' + errorId);
    seen.add(errorId);
    const old = state.measures.find(m => m.errorId === errorId);
    const inheritedRefs = inherited(state, error);
    if (fields.paths) fields.paths = fields.paths.map(({ severity, severityReason, ...p }) => p);
    if (fields.controls) fields.controls = fields.controls.map(c => ({ ...c,
      pathIndices: c.pathIndices ?? ((fields.paths || old?.paths)?.length === 1 ? [0] : (fields.paths || old?.paths)?.length === 0 ? [] : undefined) }));
    // A controls-only edit neither certifies stale causal inputs nor changes grades.
    const fullAnalysis = Object.hasOwn(fields, 'paths') && Object.hasOwn(fields, 'controls') && Object.hasOwn(fields, 'conclusion');
    ops.push({ collection: 'measures', id: old?.id || '$measure' + ops.length,
      set: { ...fields, errorId,
        sourceIds: unique([...inheritedRefs.sourceIds, ...(old?.sourceIds || []), ...(fields.sourceIds || [])]),
        noteIds: unique([...inheritedRefs.noteIds, ...(old?.noteIds || []), ...(fields.noteIds || [])]),
        ...(fullAnalysis ? { stale: false } : {}) } });
  }
  const result = await commit(dir, { baseRevision: draft.baseRevision, reason: draft.reason || '保存使用错误的路径与措施', ops });
  return { revision: result.state.revision, saved: seen.size, measures: result.state.measures.length, errors: result.state.errors.length };
}

export async function rate(dir, draft) {
  const state = await loadProject(dir);
  if (!Array.isArray(draft.records) || !draft.records.length) throw Error('records 不能为空');
  const ops = draft.records.map(r => {
    const m = state.measures.find(m => m.errorId === r.errorId);
    if (!m || m.stale) throw Error('缺少当前有效的伤害分析：' + r.errorId);
    if (!Array.isArray(r.paths) || r.paths.length !== m.paths.length) throw Error('评级与伤害路径数量不一致');
    const paths = m.paths.map((p, i) => {
      const rating = r.paths[i];
      if (!Number.isInteger(rating.severity) || rating.severity < 1 || rating.severity > 5 || !rating.severityReason?.trim()) throw Error('需要1～5整数评级和判级理由');
      return { ...p, severity: rating.severity, severityReason: rating.severityReason };
    });
    return { collection: 'measures', id: m.id, set: { paths } };
  });
  const result = await commit(dir, { baseRevision: draft.baseRevision, reason: draft.reason || '按既有伤害独立评级', ops });
  return { revision: result.state.revision, rated: ops.length };
}

export async function exportLocal(dir) {
  const state = await loadProject(dir), table = exportTable(state, 'measures');
  const output = path.join(dir, 'exports/measures/r' + state.revision);
  for (const [name, data] of Object.entries({ export: table, sheets: table.sheets, styles: table.styles }))
    await writeJson(path.join(output, name + '.json'), data);
  return { output, rows: table.rows.length, merges: table.merges.length, revision: state.revision };
}

export async function main([cmd, directory, ...args], run) {
  if (!directory) throw Error('用法：read|prepare|context|save|ratings|rate|export|publish PROJECT ...');
  const dir = path.resolve(directory);
  if (cmd === 'read' && args[0]) return readAnalysis(dir, args[0], args[1], run);
  if (cmd === 'prepare' && args[0]) return prepare(dir, await readJson(args[0]), args[1] ? await readJson(args[1]) : {});
  if (cmd === 'save' && args[0]) return save(dir, await readJson(args[0]));
  if (cmd === 'rate' && args[0]) return rate(dir, await readJson(args[0]));
  if (cmd === 'export') return exportLocal(dir);
  if (cmd === 'publish') {
    const input = await readJson(path.join(dir, 'inputs/current.json')).catch(e => { if (e.code !== 'ENOENT') throw e; return {}; });
    const { positionals, values } = parseArgs({ args, allowPositionals: true, options: { title: { type: 'string' } } });
    if (positionals.length > 2 || (values.title !== undefined && !values.title.trim())) throw Error('用法：publish PROJECT [user或bot] [来源ID或openid:ou_...] [--title 最终标题]');
    return publishSheets('measures', dir, positionals[0] || input.identity || 'user', positionals[1] || input.sourceId, run, values.title?.trim());
  }
  const state = await loadProject(dir);
  if (cmd === 'context' || cmd === 'ratings') {
    const value = context(state, cmd === 'ratings');
    if (!args[0]) return value;
    const file = path.resolve(args[0]); await writeJson(file, value);
    return { output: file, revision: state.revision, records: value.records.length, missing: value.missing.length };
  }
  if (cmd === 'resume') return resume(state);
  throw Error('未知命令');
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { console.log(JSON.stringify(await main(process.argv.slice(2)), null, 2)); }
  catch (e) { console.error(e.message); process.exitCode = 1; }
}
