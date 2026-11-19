import { randomUUID, createHash } from 'node:crypto';
import { access, mkdir, readFile, readdir, writeFile, rename, open, unlink, rm } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createFinalScoreCalculator, normalizeFinalScoreConfig } from './vendor/final-score.mjs';

export const collections = ['notes', 'tasks', 'steps', 'errors', 'measures', 'issues'];
const prefixes = { notes: 'N', tasks: 'T', steps: 'S', errors: 'E', measures: 'M', issues: 'I' };
const common = ['sourceIds', 'noteIds', 'basis', 'status', 'lockedFields', 'stale'];
const fields = {
  notes: ['text', 'kind', 'reason'],
  tasks: ['purpose', 'name', 'scope', 'actor', 'condition', 'start', 'end'],
  steps: ['taskId', 'action', 'p', 'c', 'ui', 'condition', 'risk', 'riskReason', 'recovery', 'riskStale'],
  errors: ['stepId', 'text', 'cause', 'consequence', 'sourceText', 'sourceRow'],
  measures: ['errorId', 'paths', 'controls', 'conclusion'],
  issues: ['text', 'category', 'sourceRecordId', 'severity', 'severityReason', 'occurrence', 'occurrenceReason', 'recovery', 'recoveryReason'],
};
export const hash = value => createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value)).digest('hex');
export const readJson = async file => JSON.parse((await readFile(file, 'utf8')).replace(/^\uFEFF/u, ''));
export const writeJson = async (file, value) => { await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, JSON.stringify(value, null, 2) + '\n', 'utf8'); };
const requireText = (value, name) => { if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} 必须是非空文字`); };
const score = value => Number.isInteger(value) && value >= 1 && value <= 5;

async function renameWithRetry(from, to) {
  for (let attempt = 0; ; attempt++) {
    try { await rename(from, to); return; }
    catch (e) {
      if (!['EPERM', 'EBUSY', 'EACCES'].includes(e.code) || attempt >= 4) throw e;
      await delay(50 * (attempt + 1));
    }
  }
}

function snapshotPaths(dir, revision) {
  const number = String(revision).padStart(6, '0');
  return { pending: path.join(dir, `.history-${number}.pending`), final: path.join(dir, 'history', number + '.json') };
}

async function finishSnapshot({ pending, final }) {
  try { await renameWithRetry(pending, final); }
  catch (e) {
    if (e.code !== 'ENOENT') throw e;
    await access(final); // A concurrent reader can finish the same committed snapshot.
  }
}

export async function loadProject(dir) {
  const s = await readJson(path.join(dir, 'project.json'));
  validate(s);
  const paths = snapshotPaths(dir, s.revision);
  try { await access(paths.pending); } catch (e) { if (e.code === 'ENOENT') return s; throw e; }
  await finishSnapshot(paths);
  return s;
}

async function locked(dir, action) {
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, '.write.lock');
  let handle;
  try { handle = await open(file, 'wx'); } catch (e) { if (e.code === 'EEXIST') throw new Error('项目正在写入；若上次进程崩溃，先确认没有写入进程，再移除 .write.lock'); throw e; }
  try { return await action(); } finally { await handle.close(); await unlink(file); }
}

async function persist(dir, state, event) {
  const paths = snapshotPaths(dir, state.revision);
  const history = path.dirname(paths.final);
  await mkdir(history, { recursive: true });
  // A pre-fix failure could leave UUID-named snapshots ahead of the committed head.
  // Preserve those attempts separately when retrying that exact revision.
  const prefix = path.basename(paths.final, '.json') + '-';
  const existing = await readdir(history);
  if (existing.includes(path.basename(paths.final))) throw Error('目标版本已有正式快照，请核对项目正文与历史。');
  for (const name of existing) {
    if (!name.startsWith(prefix) || !/^[\da-f]{8}(-[\da-f]{4}){3}-[\da-f]{12}\.json$/i.test(name.slice(prefix.length))) continue;
    const old = await readJson(path.join(history, name));
    if (old.state?.revision !== state.revision || (state.revision > 0 && old.state.id !== state.id))
      throw Error('历史快照与项目不匹配：' + name);
    const archive = path.join(dir, 'uncommitted-history');
    await mkdir(archive, { recursive: true });
    await renameWithRetry(path.join(history, name), path.join(archive, name));
  }
  const tmp = path.join(dir, '.project-next.tmp'); // Only the writer holding .write.lock uses this file.
  try {
    await writeJson(paths.pending, { state, event, savedAt: new Date().toISOString() });
    await writeJson(tmp, state);
    await renameWithRetry(tmp, path.join(dir, 'project.json')); // Commit point.
  } catch (e) {
    await Promise.all([rm(tmp, { force: true }), rm(paths.pending, { force: true })]);
    throw e;
  }
  try { await finishSnapshot(paths); }
  catch (e) { throw Error(`第 ${state.revision} 版正文已保存，历史快照待归档。恢复文件访问后运行 resume。`, { cause: e }); }
  return state;
}

export async function initProject(dir, name, finalScore = {}) {
  requireText(name, '项目名称');
  return locked(dir, async () => {
    try { await readFile(path.join(dir, 'project.json')); throw new Error('项目已存在，请使用 resume'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    const state = { schemaVersion: 1, id: randomUUID(), name, revision: 0, createdAt: new Date().toISOString(),
      finalScore: normalizeFinalScoreConfig(finalScore), sources: [], ...Object.fromEntries(collections.map(c => [c, []])) };
    return persist(dir, state, { action: 'init' });
  });
}

export function validate(s, complete) {
  if (s.schemaVersion !== 1 || !Number.isInteger(s.revision)) throw new Error('不支持的项目格式');
  requireText(s.name, '项目名称'); normalizeFinalScoreConfig(s.finalScore);
  const ids = new Set();
  for (const c of ['sources', ...collections]) {
    if (!Array.isArray(s[c])) throw new Error(`缺少集合 ${c}`);
    for (const r of s[c]) { requireText(r.id, `${c}.id`); if (ids.has(r.id)) throw new Error(`重复 ID ${r.id}`); ids.add(r.id); }
  }
  const has = (c, id) => s[c].some(r => r.id === id);
  for (const c of collections) for (const r of s[c]) {
    for (const key of ['sourceIds', 'noteIds']) if (r[key] !== undefined && !Array.isArray(r[key])) throw new Error(`${r.id}.${key} 必须为数组`);
    for (const id of r.sourceIds ?? []) if (!has('sources', id)) throw new Error(`${r.id} 来源不存在 ${id}`);
    for (const id of r.noteIds ?? []) if (!has('notes', id)) throw new Error(`${r.id} 依据不存在 ${id}`);
    if (r.lockedFields && (!Array.isArray(r.lockedFields) || r.lockedFields.some(f => !fields[c].includes(f) && !common.includes(f)))) throw new Error(`${r.id} 锁定字段无效`);
  }
  for (const r of s.notes) { requireText(r.text, r.id); if (!['fact', 'assumption', 'decision'].includes(r.kind)) throw new Error(`${r.id} note.kind 无效`); }
  for (const r of s.tasks) { requireText(r.name, r.id); requireText(r.purpose, r.id); }
  for (const r of s.steps) { requireText(r.action, r.id); if (!has('tasks', r.taskId)) throw new Error(`${r.id} taskId 无效`); if (r.risk !== undefined && !['高', '中', '低'].includes(r.risk)) throw new Error(`${r.id} 操作影响只能为高中低`); }
  for (const r of s.errors) { requireText(r.text, r.id); if (!has('steps', r.stepId)) throw new Error(`${r.id} stepId 无效`); }
  const measured = new Set();
  for (const r of s.measures) {
    if (!has('errors', r.errorId) || measured.has(r.errorId)) throw new Error(`${r.id} errorId 不存在或重复分析`);
    measured.add(r.errorId);
    if (!Array.isArray(r.paths) || !Array.isArray(r.controls)) throw new Error(`${r.id} 需要 paths 和 controls 数组`);
    for (const p of r.paths) {
      if (!['health', 'property', 'environment', 'service'].includes(p.domain)) throw new Error(`${r.id} domain 无效`);
      for (const key of ['situation', 'harm', 'mechanism']) requireText(p[key], `${r.id}.${key}`);
      if (p.severity !== undefined && (!score(p.severity) || (p.domain !== 'health' && p.severity !== 1))) throw new Error(`${r.id} 伤害严重程度无效`);
    }
  }
  for (const r of s.issues) { requireText(r.text, r.id); for (const k of ['severity', 'occurrence', 'recovery']) if (r[k] !== undefined && !score(r[k])) throw new Error(`${r.id}.${k} 必须为 1～5 整数`); }
  if (!complete) return;
  if (!['fmea', 'analysis', 'measures'].includes(complete)) throw new Error('导出类型无效');
  const relevant = complete === 'fmea' ? ['issues'] : complete === 'analysis' ? ['tasks', 'steps', 'errors'] : ['tasks', 'steps', 'errors', 'measures'];
  for (const c of relevant) for (const r of s[c]) if (r.stale) throw new Error(`${r.id} 受上游修改影响，需要检查后解除 stale`);
  if (complete === 'fmea') {
    if (!s.issues.length) throw new Error('没有待评分问题');
    for (const r of s.issues) for (const k of ['severity', 'occurrence', 'recovery']) { if (!score(r[k])) throw new Error(`${r.id} 缺少 ${k}`); requireText(r[`${k}Reason`], `${r.id}.${k}Reason`); }
  } else if (complete === 'analysis') {
    if (!s.steps.length) throw new Error('没有步骤');
    for (const t of s.tasks) if (!s.steps.some(r => r.taskId === t.id)) throw new Error(`${t.id} 尚无步骤`);
    for (const r of s.steps) { if (r.riskStale) throw new Error(`${r.id} 使用错误已变化，需要更新综合操作影响`); for (const k of ['p', 'c', 'ui', 'risk', 'riskReason']) requireText(r[k], `${r.id}.${k}`); }
    for (const r of s.errors) for (const k of ['cause', 'consequence']) requireText(r[k], `${r.id}.${k}`);
  } else {
    if (!s.errors.length || measured.size !== s.errors.length) throw new Error('每条使用错误必须恰好对应一条措施记录');
    for (const r of s.measures) {
      requireText(r.conclusion, `${r.id}.conclusion`);
      for (const p of r.paths) { if (!score(p.severity)) throw new Error(`${r.id} 路径缺少严重程度`); requireText(p.severityReason, `${r.id}.severityReason`); }
      if (!r.controls.length) throw new Error(`${r.id} 缺少措施`);
      for (const control of r.controls) {
        for (const k of ['target', 'proposal', 'mechanism', 'verification']) requireText(control[k], `${r.id}.controls.${k}`);
        if (!Array.isArray(control.pathIndices) || control.pathIndices.some(i => !Number.isInteger(i) || i < 0 || i >= r.paths.length)) throw new Error(`${r.id} 措施路径索引无效`);
      }
      if (r.paths.some((_, i) => !r.controls.some(c => c.pathIndices.includes(i)))) throw new Error(`${r.id} 存在未覆盖的伤害路径`);
    }
  }
}

function invalidate(state, changed, refreshed = new Set()) {
  const dirty = new Set(changed);
  let added = true;
  while (added) {
    added = false;
    for (const c of collections) for (const r of state[c]) {
      const deps = [...(r.sourceIds ?? []), ...(r.noteIds ?? []), r.taskId, r.stepId, r.errorId].filter(Boolean);
      if (deps.some(id => dirty.has(id)) && !dirty.has(r.id)) { dirty.add(r.id); added = true; }
    }
  }
  for (const c of collections) for (const r of state[c]) if (dirty.has(r.id) && !refreshed.has(r.id)) r.stale = true;
}

export function applyPatch(current, patch) {
  if (patch.baseRevision !== current.revision) throw new Error('项目版本已变化，请重新读取后生成补丁');
  requireText(patch.reason, '修改原因');
  if (!Array.isArray(patch.ops) || !patch.ops.length) throw new Error('ops 不能为空');
  const s = structuredClone(current), aliases = {}, changed = new Set(), refreshed = new Set(), seen = new Set();
  for (const op of patch.ops) if (op.id?.startsWith('$')) {
    if (!collections.includes(op.collection) || aliases[op.id]) throw new Error(`新记录别名无效或重复 ${op.id}`);
    aliases[op.id] = `${prefixes[op.collection]}-${randomUUID()}`;
  }
  const resolve = value => Array.isArray(value) ? value.map(resolve) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([k,v]) => [k,resolve(v)])) : typeof value === 'string' && aliases[value] ? aliases[value] : value;
  for (const original of patch.ops) {
    const op = resolve(original), c = op.collection;
    if (!collections.includes(c)) throw new Error(`未知集合 ${c}`);
    if (seen.has(op.id)) throw new Error(`补丁重复修改 ${op.id}`); seen.add(op.id);
    const index = s[c].findIndex(r => r.id === op.id), before = s[c][index];
    if (!before && !original.id?.startsWith('$')) throw new Error(`记录不存在 ${op.id}；新记录请使用 $别名`);
    if (op.delete) { if (!before) throw new Error('不能删除新记录'); if (before.lockedFields?.length) throw new Error(`${op.id} 含锁定字段，请先针对用户明确修改解锁`); s[c].splice(index, 1); changed.add(op.id); continue; }
    if (!op.set || typeof op.set !== 'object' || Array.isArray(op.set)) throw new Error('set 必须为对象');
    for (const key of Object.keys(op.set)) {
      if (![...fields[c], ...common].includes(key)) throw new Error(`${c} 不支持字段 ${key}`);
      if (before?.lockedFields?.includes(key) && hash(before[key] ?? null) !== hash(op.set[key])) throw new Error(`${op.id}.${key} 已锁定；用户要求修改时先单独解锁`);
    }
    const after = { ...before, ...op.set, id: op.id };
    if (index < 0) s[c].push(after); else s[c][index] = after;
    const administrative = ['stale', 'status', 'lockedFields', ...(c === 'steps' ? ['risk', 'riskReason', 'recovery', 'riskStale'] : [])];
    if (!before || Object.keys(op.set).some(k => !administrative.includes(k) && hash(before[k] ?? null) !== hash(op.set[k]))) changed.add(op.id);
    if (!before || op.set.stale === false) refreshed.add(op.id);
  }
  // Directly edited rows remain current; dependent rows need an explicit current re-analysis.
  for (const op of patch.ops) if (op.set && changed.has(aliases[op.id] ?? op.id) && !current[op.collection].find(r => r.id === op.id)?.stale) refreshed.add(aliases[op.id] ?? op.id);
  invalidate(s, changed, refreshed);
  // Editing the assessed input does not implicitly certify its retained assessments.
  for (const op of patch.ops) {
    if (!op.set || op.set.stale === false) continue;
    const before = current[op.collection].find(r => r.id === op.id);
    const after = s[op.collection].find(r => r.id === op.id);
    if (!before || !after) continue;
    if (op.collection === 'issues' && op.set.text !== undefined && op.set.text !== before.text && !['severity', 'severityReason', 'occurrence', 'occurrenceReason', 'recovery', 'recoveryReason'].every(k => Object.hasOwn(op.set, k))) after.stale = true;
    if (op.collection === 'steps' && op.set.action !== undefined && op.set.action !== before.action && !['p', 'c', 'ui', 'risk', 'riskReason'].every(k => Object.hasOwn(op.set, k))) after.stale = true;
  }
  // Error changes also invalidate the parent step's integrated operational-impact assessment.
  for (const id of changed) {
    const e = current.errors.find(r => r.id === id) ?? s.errors.find(r => r.id === id);
    if (e) for (const sid of new Set([e.stepId, s.errors.find(r => r.id === id)?.stepId])) {
      const step = s.steps.find(r => r.id === sid);
      const assessment = patch.ops.find(op => (aliases[op.id] ?? op.id) === sid)?.set;
      if (step && !(assessment?.risk && assessment?.riskReason && assessment.riskStale === false)) step.riskStale = true;
    }
  }
  for (const [c, rawIds] of Object.entries(patch.order ?? {})) {
    const ordered = resolve(rawIds);
    if (!collections.includes(c) || !Array.isArray(ordered) || ordered.length !== s[c].length || new Set(ordered).size !== ordered.length || ordered.some(id => !s[c].some(r => r.id === id))) throw new Error(`order.${c} 必须恰好包含该集合全部 ID`);
    const byId = new Map(s[c].map(r => [r.id, r])); s[c] = ordered.map(id => byId.get(id));
  }
  s.revision++;
  validate(s);
  return { state: s, aliases, changed: [...changed] };
}

export async function commit(dir, patch, complete) {
  return locked(dir, async () => {
    const result = applyPatch(await loadProject(dir), patch);
    if (complete) validate(result.state, complete);
    await persist(dir, result.state, { action: 'patch', reason: patch.reason, changed: result.changed, aliases: result.aliases });
    return result;
  });
}

export async function addSource(dir, file, { id, url = '', label = '' } = {}) {
  return locked(dir, async () => {
    const s = await loadProject(dir), bytes = await readFile(file), checksum = hash(bytes);
    const old = id ? s.sources.find(r => r.id === id) : undefined;
    if (id && !old) throw new Error('更新的 source ID 不存在');
    if (old?.sha256 === checksum) return s;
    const sourceId = id ?? `D-${randomUUID()}`, ext = path.extname(file).replace(/[^.a-zA-Z0-9]/g, '').slice(0, 12);
    const relative = `sources/${sourceId}/${checksum}${ext}`;
    await mkdir(path.dirname(path.join(dir, relative)), { recursive: true }); await writeFile(path.join(dir, relative), bytes);
    const source = { id: sourceId, label: label || old?.label || path.basename(file), url: url || old?.url || '', path: relative, sha256: checksum, version: (old?.version ?? 0) + 1 };
    if (old) { s.sources[s.sources.indexOf(old)] = source; invalidate(s, [id]); } else s.sources.push(source);
    s.revision++; validate(s); return persist(dir, s, { action: 'source', sourceId });
  });
}

export function resume(s) {
  return { id: s.id, name: s.name, revision: s.revision, sources: s.sources, notes: s.notes,
    counts: Object.fromEntries(collections.map(c => [c, s[c].length])),
    stale: collections.flatMap(c => s[c].filter(r => r.stale).map(r => ({ collection: c, id: r.id }))),
    riskStale: s.steps.filter(r => r.riskStale).map(r => r.id),
    locked: collections.flatMap(c => s[c].filter(r => r.lockedFields?.length).map(r => ({ id: r.id, fields: r.lockedFields }))) };
}

export function finalScore(s, issue) { return createFinalScoreCalculator(s.finalScore)(issue.severity, issue.occurrence, issue.recovery); }
