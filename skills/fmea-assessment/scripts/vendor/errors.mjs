export class AppError extends Error {
  constructor(message, { code = 'APP_ERROR', status = 400, cause } = {}) {
    super(message, { cause });
    this.name = 'AppError';
    this.code = code;
    this.status = status;
  }
}

export function toUserMessage(error) {
  const code = error?.code ?? error?.response?.data?.code;
  const raw = `${error?.message ?? ''} ${error?.response?.data?.msg ?? ''}`.toLowerCase();

  if (error instanceof AppError) return error.message;
  if (code === 99991663 || code === 99991664 || raw.includes('permission')) {
    return '当前应用没有该多维表格的访问权限。请将机器人应用添加为该 Base 的协作者后重试。';
  }
  if (raw.includes('not found') || code === 1254043) {
    return '没有找到该多维表格或子表，请确认链接有效且应用拥有访问权限。';
  }
  return '处理失败，请查看服务端日志中的 requestId 和飞书 API 错误信息。';
}
