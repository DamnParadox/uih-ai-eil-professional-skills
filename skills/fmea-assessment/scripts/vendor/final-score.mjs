const DEFAULT_WEIGHTS = { severity: 0.5, occurrence: 0.3, recovery: 0.2 };
const DEFAULT_FLOORS = { 4: 65, 5: 85 };

export function normalizeFinalScoreConfig(options = {}) {
  requireObject(options, 'finalScore');
  if (options.weights !== undefined) requireObject(options.weights, 'finalScore.weights');
  if (options.severityFloors !== undefined) requireObject(options.severityFloors, 'finalScore.severityFloors');
  const weights = { ...DEFAULT_WEIGHTS, ...options.weights };
  const severityFloors = { ...DEFAULT_FLOORS, ...options.severityFloors };
  for (const [key, value] of Object.entries(weights)) {
    if (!Object.hasOwn(DEFAULT_WEIGHTS, key) || !Number.isFinite(value) || value < 0 || value > 1) {
      throw new Error('finalScore.weights 仅支持 severity/occurrence/recovery，权重须为0～1数字。');
    }
  }
  if (Math.abs(Object.values(weights).reduce((sum, value) => sum + value, 0) - 1) > 1e-9) {
    throw new Error('finalScore.weights 三项权重之和必须为1。');
  }
  for (const [key, value] of Object.entries(severityFloors)) {
    if (!Object.hasOwn(DEFAULT_FLOORS, key) || !Number.isFinite(value) || value < 0 || value > 100) {
      throw new Error('finalScore.severityFloors 仅支持4和5，保底分须为0～100数字。');
    }
  }
  if (severityFloors[5] < severityFloors[4]) {
    throw new Error('5级危害保底分不能低于4级危害保底分。');
  }
  return { weights, severityFloors };
}

export function createFinalScoreCalculator(options) {
  const { weights, severityFloors } = normalizeFinalScoreConfig(options);
  return (severity, occurrence, recovery) => {
    const values = [severity, occurrence, recovery];
    if (values.some((value) => value == null || (typeof value === 'string' && !value.trim()))) {
      return undefined;
    }
    if (values.some((value) => !Number.isInteger(value) || value < 1 || value > 5)) {
      throw new Error('最终问题评分要求三项评分均为1～5整数。');
    }
    const base = 20 * (weights.severity * severity +
      weights.occurrence * occurrence + weights.recovery * recovery);
    return Number(Math.max(base, severityFloors[severity] ?? 0).toFixed(2));
  };
}

function requireObject(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${name} 必须为配置对象。`);
  }
}
