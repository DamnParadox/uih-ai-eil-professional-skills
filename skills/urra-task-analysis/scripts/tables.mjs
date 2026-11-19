import { hash, validate, finalScore } from './workspace.mjs';
import { normalizeMeasuresInput, validateErrorParts, flattenUseErrors } from './vendor/urra-measures-input.mjs';
import { FMEA_COLUMNS } from './fmea-base.mjs';

export const column = index => { let out = ''; for (let n = index + 1; n; n = Math.floor((n - 1) / 26)) out = String.fromCharCode(65 + (n - 1) % 26) + out; return out; };
const line = text => String(text ?? '').replace(/\r?\n/g, ' ').trim();
const numbered = values => values.map((v, i) => `${i + 1}. ${v}`).join('\n');

export function exportTable(s, kind) {
  validate(s, kind);
  let columns, rows = [], keys = [], groups = [], anchors, name;
  const stepMap = new Map(s.steps.map(r => [r.id, r])), taskMap = new Map(s.tasks.map(r => [r.id, r]));
  if (kind === 'fmea') {
    name = 'FMEA评分'; anchors = [0, 1];
    columns = [...FMEA_COLUMNS];
    s.issues.forEach((r, i) => { rows.push([r.text, r.category || `${s.name}-问题${i + 1}`, r.severity, r.severityReason, r.occurrence, r.occurrenceReason, r.recovery, r.recoveryReason, finalScore(s, r)]); keys.push(r.id); });
  } else if (kind === 'analysis') {
    name = 'URRA任务分析'; anchors = [2];
    columns = ['预期使用目的', '关键任务', '步骤', '用户操作（PCA模型）', 'UI界面/物料', '潜在Use Error', '风险等级'];
    for (const t of s.tasks) for (const r of s.steps.filter(r => r.taskId === t.id)) {
      const errors = s.errors.filter(e => e.stepId === r.id);
      rows.push([t.purpose, t.name, r.action, `P：${r.p}\nC：${r.c}\nA：${r.action}`, r.ui,
        numbered(errors.map(e => `${line(e.text)}；可能原因：${line(e.cause)}；直接后果：${line(e.consequence)}`)) || '未识别到潜在使用错误', r.risk]);
      keys.push(r.id); groups.push([t.purpose, t.id]);
    }
  } else {
    name = 'URRA措施'; anchors = [0, 1];
    columns = ['用户任务', '潜在使用错误', '潜在的危险情况', '潜在的伤害', '严重程度', '风险缓释措施'];
    const byError = new Map(s.measures.map(r => [r.errorId, r]));
    // Task/step order is stable, and multiple errors remain adjacent under their source step.
    for (const t of s.tasks) for (const step of s.steps.filter(r => r.taskId === t.id)) for (const e of s.errors.filter(r => r.stepId === step.id)) {
      const r = byError.get(e.id);
      const controls = r.controls.map(c => `${c.target}：${c.proposal}；作用：${c.mechanism}；验证：${c.verification}${c.conditions ? `；前提：${c.conditions}` : ''}（建议，未验证）`);
      rows.push([step.action, e.text, numbered(r.paths.map(p => p.situation)) || `未识别可信危险情况；${r.conclusion}`,
        numbered(r.paths.map(p => p.harm)) || `未识别实际健康伤害；${r.conclusion}`, Math.max(1, ...r.paths.map(p => p.severity)), numbered(controls)]);
      keys.push(r.id); groups.push([step.id]);
    }
  }
  const merges = [];
  if (groups.length) for (let c = 0; c < groups[0].length; c++) {
    for (let start = 0; start < rows.length;) {
      let end = start + 1; while (end < rows.length && groups[end][c] === groups[start][c]) end++;
      if (end - start > 1) { merges.push({ range: `${column(c)}${start + 2}:${column(c)}${end + 1}`, merge_type: 'all' }); for (let r = start + 1; r < end; r++) rows[r][c] = ''; }
      start = end;
    }
  }
  const audit = [];
  if (kind === 'analysis') audit.push(['字段说明', '', '关键任务 / 风险等级', '', '关键任务是按用户目标划分的核心操作任务。风险等级仅表示本步全部潜在使用错误对操作完成及现场恢复的影响。涉及严重伤害的关键任务需结合伤害分析识别；各等级的使用错误均保留供下游分析。']);
  for (const r of s.sources) audit.push(['来源', r.id, r.label, r.url || r.path, `版本 ${r.version}；SHA256 ${r.sha256}`]);
  for (const r of s.notes) audit.push([r.kind, r.id, r.text, (r.sourceIds ?? []).join(', '), r.reason ?? '']);
  for (let i = 0; i < keys.length; i++) {
    const id = keys[i];
    let r = (kind === 'fmea' ? s.issues : kind === 'analysis' ? s.steps : s.measures).find(x => x.id === id);
    const e = kind === 'measures' ? s.errors.find(e => e.id === r.errorId) : null;
    const step = kind === 'analysis' ? r : e ? stepMap.get(e.stepId) : null;
    audit.push(['行映射', id, `${name}!${i + 2}`, [step?.id, e?.id, step ? taskMap.get(step.taskId)?.id : null].filter(Boolean).join(', '), '行号仅为本次导出位置，稳定 ID 保留在本地项目']);
    audit.push(['依据', id, r.basis || '见项目来源及假设', [...(r.sourceIds ?? []), ...(r.noteIds ?? [])].join(', '), r.riskReason || r.conclusion || '']);
    if (kind === 'measures') r.paths.forEach((p,j) => audit.push(['伤害路径', `${id}:${j + 1}`, `${p.situation} → ${p.harm}`, p.mechanism, `严重程度 ${p.severity}：${p.severityReason}${p.domain !== 'health' ? '；非健康后果，本级仅代表健康维度' : ''}`]));
  }
  const numeric = kind === 'fmea' ? [2, 4, 6, 8] : kind === 'measures' ? [4] : [];
  const typed = { name, start_cell: 'A1', header: true, columns, data: rows,
    dtypes: Object.fromEntries(columns.map((c,i) => [c, numeric.includes(i) ? 'float64' : 'object'])) };
  const auditColumns = ['类型', '稳定编号', '内容/位置', '来源/关联', '说明'];
  const styles = [
    { name, cell_styles: [{ range: `A1:${column(columns.length - 1)}${rows.length + 1}`, vertical_alignment: 'top', word_wrap: 'auto-wrap' }, { range: `A1:${column(columns.length - 1)}1`, font_weight: 'bold', background_color: '#DCE8F5' }], cell_merges: merges,
      col_sizes: columns.map((_, i) => ({ range: `${column(i)}:${column(i)}`, size: numeric.includes(i) || (kind === 'analysis' && i === 6) ? 110 : i < 2 ? 200 : 340 })), row_sizes: [{ range: `1:${rows.length + 1}`, type: 'auto' }] },
    { name: '分析依据', cell_styles: [{ range: `A1:E${audit.length + 1}`, vertical_alignment: 'top', word_wrap: 'auto-wrap' }, { range: 'A1:E1', font_weight: 'bold' }] },
  ];
  if (kind === 'analysis') {
    const widths = [[240, 250, 320, 420, 330, 560, 100], [100, 310, 420, 360, 420]];
    for (const [i, style] of styles.entries()) {
      style.freeze = { rows: 1, cols: i === 0 ? 2 : 1 };
      style.col_sizes = widths[i].map((size, j) => ({ range: `${column(j)}:${column(j)}`, size }));
      style.row_sizes = [{ range: '1:1', size: 36 }, { range: `2:${(i === 0 ? rows : audit).length + 1}`, type: 'auto' }];
      Object.assign(style.cell_styles[1], { background_color: '#1E3A5F', font_color: '#FFFFFF', horizontal_alignment: 'center' });
    }
  }
  return { schemaVersion: 1, kind, projectId: s.id, projectRevision: s.revision, name, columns, rows, rowKeys: keys, anchors, merges,
    sheets: { sheets: [typed, { name: '分析依据', columns: auditColumns, data: audit, dtypes: Object.fromEntries(auditColumns.map(c => [c, 'object'])) }] }, styles: { styles } };
}

export function importAnalysis(s, snapshot, splits = {}) {
  if (s.tasks.length || s.steps.length || s.errors.length) throw new Error('整表导入仅用于空项目；已有项目请按稳定 ID 提交局部补丁');
  if (snapshot.complete !== true || !snapshot.sheetId || !Array.isArray(snapshot.merges)) throw new Error('快照需 complete:true、真实 sheetId、rows 和 merges；不接受截断数据');
  if (snapshot.sourceId && !s.sources.some(r => r.id === snapshot.sourceId)) throw new Error('sourceId 不存在');
  const source = normalizeMeasuresInput(snapshot), ambiguous = [];
  for (const c of source.cells) if (!c.parts) { if (splits[c.id]) c.parts = validateErrorParts(c.raw, splits[c.id]); else ambiguous.push({ id: c.id, step: c.step, raw: c.raw }); }
  if (ambiguous.length) return { ready: false, ambiguous, instruction: 'AI 仅将原文分成连续完整片段；以 C行号 为键保存数组，用 splits 参数重跑。不得改写、漏字或按逗号强拆。' };
  const errors = flattenUseErrors(source, Number.MAX_SAFE_INTEGER), ops = [], steps = new Map();
  let previousTaskKey, taskAlias;
  for (const c of source.cells) {
    const taskKey = JSON.stringify([c.purpose, c.task]);
    if (taskKey !== previousTaskKey) { taskAlias = `$t${ops.length}`; ops.push({ collection: 'tasks', id: taskAlias, set: { purpose: c.purpose || '来源未填写使用目的', name: c.task || '来源未填写关键任务', sourceIds: snapshot.sourceId ? [snapshot.sourceId] : [] } }); previousTaskKey = taskKey; }
    if (!steps.has(c.step_key)) { const alias = `$s${steps.size}`; steps.set(c.step_key, alias); ops.push({ collection: 'steps', id: alias, set: { taskId: taskAlias, action: c.step, ui: c.ui, basis: '来源原文；PCA 原文见来源快照', sourceIds: snapshot.sourceId ? [snapshot.sourceId] : [] } }); }
  }
  for (const e of errors) ops.push({ collection: 'errors', id: `$e${ops.length}`, set: { stepId: steps.get(e.step_key), text: e.error, cause: e.cause, consequence: e.consequence, sourceText: e.source_text, sourceRow: e.source_row, sourceIds: snapshot.sourceId ? [snapshot.sourceId] : [] } });
  return { ready: true, errorCount: errors.length, skipped: source.skipped, patch: { baseRevision: s.revision, reason: `导入任务分析 ${snapshot.sheetId}；原文快照 SHA256 ${hash(snapshot)}`, ops } };
}

// Normalized full main-sheet snapshots: columns/rows/merges, complete=true; no API shape guessing.
export function normalizeRemote(remote, baseline) {
  if (remote.complete !== true || !Array.isArray(remote.rows) || !Array.isArray(remote.columns) || !Array.isArray(remote.merges)) throw new Error('远端快照必须完整并包含 columns/rows/merges');
  const out = structuredClone(remote);
  out.rows = out.rows.map(r => Array.from({ length: out.columns.length }, (_, i) => r[i] ?? ''));
  if (out.rows.length !== baseline.rows.length || JSON.stringify(out.columns) !== JSON.stringify(baseline.columns)) throw new Error('远端行数或表头已变化，需要重新核对稳定 ID 映射');
  if (out.rows.some((r,i) => baseline.anchors.some(c => r[c] !== (baseline.rows[i][c] ?? '')))) throw new Error('远端定位列发生变化/重排，需要重新核对稳定 ID 映射');
  const ranges = m => m.map(r => typeof r === 'string' ? r : r.range).sort();
  if (JSON.stringify(ranges(out.merges)) !== JSON.stringify(ranges(baseline.merges))) throw new Error('远端合并结构已变化，需要重新核对');
  return out;
}

export function syncPlan(baseline, local, remote) {
  if (baseline.kind !== local.kind || baseline.projectId !== local.projectId || JSON.stringify(baseline.rowKeys) !== JSON.stringify(local.rowKeys) || JSON.stringify(baseline.merges) !== JSON.stringify(local.merges)) throw new Error('本地结构发生变化；当前仅支持原结构的局部同步，请生成新版结果或明确编排结构更新');
  const anchorKeys = baseline.rows.map(row => JSON.stringify(baseline.anchors.map(c => row[c] ?? '')));
  if (new Set(anchorKeys).size !== anchorKeys.length) throw new Error('存在相同定位内容的多行，不能可靠识别远端重排；需要核对稳定 ID 映射后定向更新');
  const r = normalizeRemote(remote, baseline), writes = [], conflicts = [], remoteEdits = [], expected = structuredClone(r);
  for (let i = 0; i < local.rows.length; i++) for (let j = 0; j < local.columns.length; j++) {
    const b = baseline.rows[i][j] ?? '', l = local.rows[i][j] ?? '', v = r.rows[i][j] ?? '';
    const cell = { id: local.rowKeys[i], range: `${column(j)}${i + 2}`, field: local.columns[j], base: b, local: l, remote: v };
    if (l === v) continue;
    if (l === b) { remoteEdits.push(cell); continue; }
    if (v !== b) { conflicts.push(cell); continue; }
    writes.push({ range: cell.range, cells: [[{ value: l }]], before: v }); expected.rows[i][j] = l;
  }
  return { safe: conflicts.length === 0, kind: local.kind, projectId: local.projectId, projectRevision: local.projectRevision,
    remoteHash: remoteHash(r), writes, conflicts, remoteEdits, expected,
    // Caller MUST persist remote-only edits into the structured model before establishing a new baseline.
    baselineReady: conflicts.length === 0 && remoteEdits.length === 0 };
}

export function remoteHash(r) {
  if (r.complete !== true || !Array.isArray(r.columns) || !Array.isArray(r.rows) || !Array.isArray(r.merges)) throw new Error('同步前快照不完整');
  return hash({ columns: r.columns, rows: r.rows.map(row => Array.from({ length: r.columns.length }, (_, i) => row[i] ?? '')), merges: r.merges.map(m => typeof m === 'string' ? m : m.range).sort() });
}

export function verifySync(plan, observed) {
  if (!plan.safe) throw new Error('存在未处理的冲突');
  if (observed.complete !== true) throw new Error('回读不完整');
  const rows = observed.rows?.map(r => Array.from({ length: plan.expected.columns.length }, (_, i) => r[i] ?? ''));
  if (JSON.stringify(rows) !== JSON.stringify(plan.expected.rows) || JSON.stringify(observed.columns) !== JSON.stringify(plan.expected.columns)) throw new Error('回读值与计划不符；先读取实际状态，不自动重发');
  const ranges = m => m.map(r => typeof r === 'string' ? r : r.range).sort();
  if (JSON.stringify(ranges(observed.merges ?? [])) !== JSON.stringify(ranges(plan.expected.merges))) throw new Error('回读合并结构不符');
  return { verified: true, baselineReady: plan.baselineReady };
}
