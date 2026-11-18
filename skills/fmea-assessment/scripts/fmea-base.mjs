// CLI v3 field definitions. These are display contracts, not AI scoring decisions.
export const FMEA_COLUMNS = ['原数据', '分类结果', '风险危害', '评分依据', '发生概率', '发生概率依据', '不可预见或不可恢复性', '预见感知恢复依据', '最终问题评分'];
const icons = { '风险危害': 'lightning', '发生概率': 'number', '不可预见或不可恢复性': 'star' };
export function fmeaFields() {
  return FMEA_COLUMNS.map(name => ({ name, type: icons[name] || name === '最终问题评分' ? 'number' : 'text',
    style: icons[name] ? { type: 'rating', icon: icons[name], min: 1, max: 5 }
      : name === '最终问题评分' ? { type: 'plain', precision: 2, percentage: false, thousands_separator: false } : { type: 'plain' } }));
}

export function verifyFmeaFields(response) {
  if (response.ok !== true || !Array.isArray(response.data?.fields)) throw new Error('需要成功的 CLI +field-list JSON 回执');
  const actual = response.data.fields, issues = [];
  if (actual.length !== FMEA_COLUMNS.length || (response.data.total !== undefined && response.data.total !== actual.length)) issues.push('字段数量不是完整的九列');
  for (const expected of fmeaFields()) {
    const matches = actual.filter(f => f.name === expected.name), f = matches[0];
    if (matches.length !== 1) { issues.push(`${expected.name} 缺失或重名`); continue; }
    if (!f.id) issues.push(`${expected.name} 缺少真实 field ID`);
    if (f.type !== expected.type) issues.push(`${expected.name}.type 应为 ${expected.type}`);
    for (const [key, value] of Object.entries(expected.style)) if (f.style?.[key] !== value) issues.push(`${expected.name}.style.${key} 应为 ${value}`);
  }
  if (issues.length) throw new Error(`FMEA 字段契约不匹配：${issues.join('；')}`);
  return { verified: true, fields: actual.length, icons: { ...icons }, fieldIds: Object.fromEntries(actual.map(f => [f.name, f.id])) };
}

export function fmeaBatches(table) {
  if (table.kind !== 'fmea' || JSON.stringify(table.columns) !== JSON.stringify(FMEA_COLUMNS)) throw new Error('不是完整的 FMEA 导出');
  return Array.from({ length: Math.ceil(table.rows.length / 200) }, (_, i) => ({
    file: `base-create-${String(i + 1).padStart(3, '0')}.json`,
    issueIds: table.rowKeys.slice(i * 200, (i + 1) * 200),
    payload: { create_records: table.rows.slice(i * 200, (i + 1) * 200).map(row => Object.fromEntries(FMEA_COLUMNS.map((name,j) => [name, row[j]]))) },
  }));
}
