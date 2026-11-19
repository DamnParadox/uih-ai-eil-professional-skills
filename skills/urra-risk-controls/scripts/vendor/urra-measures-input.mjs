import { AppError } from './errors.mjs';

const fail = (message, code = 'INVALID_TASK_ANALYSIS') => { throw new AppError(message, { code }); };
const key = (value) => String(value ?? '').replace(/[\s（）()：:]/gu, '').toLowerCase();
const aliases = {
  step: ['步骤', '用户步骤', '用户任务'], error: ['潜在useerror', '潜在使用错误', 'useerror'],
  purpose: ['预期使用目的', '预期医疗目的', '目的'], task: ['关键任务', '任务'],
  pca: ['用户操作pca模型', '用户操作', 'pca'], ui: ['ui界面/物料', '界面/物料', 'ui界面', '物料'],
};

export function findAnalysisHeader(rows) {
  for (let index = 0; index < Math.min(20, rows.length); index++) {
    const fields = {};
    for (const [name, names] of Object.entries(aliases)) {
      const indices = rows[index].flatMap((cell, i) => names.includes(key(cell)) ? [i] : []);
      if (indices.length > 1) fail('任务分析表含重复表头，无法可靠确定输入列。');
      if (indices.length) fields[name] = indices[0];
    }
    if (fields.step !== undefined && fields.error !== undefined) return { index, fields };
  }
  return null;
}

// Feishu v3 merges use zero-based, INCLUSIVE ends (including single-column merges).
export function expandSheetMerges(rows, merges = []) {
  const expanded = rows.map((row) => [...row]);
  const origins = new Map();
  for (const m of merges) {
    const { start_row_index: r0, end_row_index: r1, start_column_index: c0, end_column_index: c1 } = m;
    if (![r0, r1, c0, c1].every(Number.isInteger) || r0 < 0 || c0 < 0 || r1 < r0 || c1 < c0) fail('源表合并范围无效。');
    if (r0 >= rows.length) continue;
    if (c1 > 255) fail('源表合并范围超出读取范围。');
    const value = rows[r0]?.[c0] ?? '';
    for (let r = r0; r <= Math.min(r1, rows.length - 1); r++) for (let c = c0; c <= c1; c++) {
      if (r !== r0 || c !== c0) {
        if (expanded[r][c] && expanded[r][c] !== value) fail('源表合并范围与单元格内容冲突。');
        expanded[r][c] = value;
      }
      origins.set(`${r}:${c}`, { row: r0, column: c0 });
    }
  }
  return { rows: expanded, origins };
}

export function normalizeMeasuresInput(snapshot) {
  const { rows, origins } = expandSheetMerges(snapshot.rows, snapshot.merges);
  const header = findAnalysisHeader(rows);
  if (!header) fail('未找到“步骤”和“潜在Use Error”两列，请提供任务分析工作表。');
  const cells = [], skipped = [], seenErrorCells = new Map();
  for (let r = header.index + 1; r < rows.length; r++) {
    const get = (name) => String(rows[r][header.fields[name]] ?? '').trim();
    const raw = get('error'), step = get('step');
    if (!raw || /^(?:无|暂无|无潜在使用错误|待补充[：:]暂无足够依据识别|未识别到潜在使用错误)$/u.test(raw)) {
      if (step) skipped.push({ row: r + 1, step, reason: '源表本步没有已列出的潜在使用错误，未额外生成错误。' });
      continue;
    }
    if (!step) fail(`源表第${r + 1}行有使用错误但缺少步骤，且不在步骤合并范围内。`);
    const origin = origins.get(`${r}:${header.fields.step}`) ?? { row: r, column: header.fields.step };
    const errorOrigin = origins.get(`${r}:${header.fields.error}`) ?? { row: r, column: header.fields.error };
    const errorKey = `${errorOrigin.row}:${errorOrigin.column}`;
    if (seenErrorCells.has(errorKey)) {
      if (seenErrorCells.get(errorKey) !== origin.row) fail('同一个使用错误单元格跨越了不同步骤，无法可靠分配；请先拆开该错误单元格。');
      continue;
    }
    seenErrorCells.set(errorKey, origin.row);
    cells.push({ id: `C${r + 1}`, row: r + 1, column: header.fields.error + 1,
      step_key: `${snapshot.sheetId}:R${origin.row + 1}`, step,
      purpose: get('purpose'), task: get('task'), pca: get('pca'), ui: get('ui'),
      raw, parts: splitNumberedErrors(raw) });
  }
  if (!cells.length) fail('任务分析表没有可展开的潜在使用错误。', 'NO_USE_ERRORS');
  return { ...snapshot, cells, skipped };
}

// The writer numbers array items; continuation lines stay inside their item.
// Never infer a delimiter from punctuation inside an error description.
export function splitNumberedErrors(raw) {
  const lines = raw.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
  if (lines.every((line) => /^.+；可能原因：.+；直接后果：.+$/u.test(line))) return lines;
  const markers = [...raw.matchAll(/^[ \t]*(?:(\d+)[.、．)）][ \t]+|[-•●][ \t]+)(?=\S)/gmu)];
  if (!markers.length || raw.slice(0, markers[0].index).trim()) return null;
  const numbered = markers[0][1] !== undefined;
  if (markers.some((m, i) => numbered ? Number(m[1]) !== i + 1 : m[1] !== undefined)) return null;
  const parts = markers.map((m, i) => raw.slice(m.index, markers[i + 1]?.index ?? raw.length).trim());
  return validateErrorParts(raw, parts);
}

// A model may only partition original text, never paraphrase, drop or invent errors.
export function validateErrorParts(raw, parts) {
  if (!Array.isArray(parts) || !parts.length || parts.length > 100) fail('错误拆分条目数无效。', 'ARK_INVALID_RESPONSE');
  let cursor = 0;
  for (const part of parts) {
    if (typeof part !== 'string' || !part.trim()) fail('拆分片段必须为非空原文。', 'ARK_INVALID_RESPONSE');
    const start = raw.indexOf(part, cursor);
    if (start < cursor || raw.slice(cursor, start).trim()) fail('错误拆分遗漏或改写了原文。', 'ARK_INVALID_RESPONSE');
    cursor = start + part.length;
  }
  if (raw.slice(cursor).trim()) fail('错误拆分遗漏尾部原文。', 'ARK_INVALID_RESPONSE');
  return parts;
}

export function flattenUseErrors(source, maxErrors) {
  const records = [];
  for (const cell of source.cells) {
    validateErrorParts(cell.raw, cell.parts);
    cell.parts.forEach((raw, index) => {
      const clean = raw.trim().replace(/^(?:[-•●]\s*|\d+[.、．)）]\s*)/u, '');
      const match = clean.match(/^([\s\S]+?)；可能原因：([\s\S]*?)；直接后果：([\s\S]*)$/u);
      records.push({ id: `E${String(records.length + 1).padStart(4, '0')}`, cell_id: cell.id,
        source_row: cell.row, source_column: cell.column, error_index: index + 1,
        step_key: cell.step_key, step: cell.step, task: cell.task, purpose: cell.purpose, pca: cell.pca, ui: cell.ui,
        error: match ? match[1] : clean, cause: match?.[2] ?? '', consequence: match?.[3] ?? '', source_text: raw });
    });
  }
  if (records.length > maxErrors) fail(`展开后的错误超过${maxErrors}条上限，请分工作表处理；系统不会截断记录。`, 'TOO_MANY_USE_ERRORS');
  return records;
}
