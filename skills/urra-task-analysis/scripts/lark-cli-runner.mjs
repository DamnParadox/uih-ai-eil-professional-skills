import path from 'node:path';
import { access } from 'node:fs/promises';
import { execFile } from 'node:child_process';

export class CliError extends Error {
  constructor(message, details = {}) { super(message); Object.assign(this, details); }
}

export function identityFailure(error) {
  const e = error?.response?.error;
  return Boolean(e && (['authentication', 'authorization'].includes(e.type) ||
    ['token_missing', 'token_expired', 'missing_scope', 'permission_denied', 'identity_unavailable'].includes(e.subtype)));
}

// Never run a command string through cmd.exe/PowerShell. In the Windows npm
// layout use the installed official binary that the lark-cli shim itself uses.
export async function findCli({ platform = process.platform, envPath = process.env.PATH || '' } = {}) {
  for (const dir of envPath.split(path.delimiter).filter(Boolean)) {
    const candidates = platform === 'win32'
      ? [path.join(dir, 'lark-cli.exe'), path.join(dir, 'node_modules/@larksuite/cli/bin/lark-cli.exe')]
      : [path.join(dir, 'lark-cli')];
    for (const candidate of candidates) {
      try { await access(candidate); return candidate; } catch (e) { if (e.code !== 'ENOENT' && e.code !== 'ENOTDIR') throw e; }
    }
  }
  throw new CliError('未找到可执行的官方 lark-cli；请在相同系统用户环境检查 CLI 安装，不改用浏览器。', { code: 'CLI_UNAVAILABLE' });
}

export function createCliRunner({ executable, prefix = [] } = {}) {
  return async (args, { cwd, timeoutMs = 30000, manifest = false } = {}) => {
    const command = executable || await findCli();
    return new Promise((resolve, reject) => {
      execFile(command, [...prefix, ...args], {
        cwd, timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, encoding: 'utf8', windowsHide: true,
        env: { ...process.env, LARKSUITE_CLI_NO_UPDATE_NOTIFIER: '1', LARKSUITE_CLI_NO_SKILLS_NOTIFIER: '1' },
      }, (error, stdout, stderr) => {
        const parse = text => { try { return JSON.parse(text.replace(/^\uFEFF/u, '').trim()); } catch { return undefined; } };
        const out = parse(stdout), err = parse(stderr), response = err?.ok === false ? err : out;
        if (response?.ok === false) {
          reject(new CliError(`飞书 CLI：${response.error?.type || 'error'}/${response.error?.subtype || ''} ${response.error?.message || ''}`, { response, exitCode: error?.code })); return;
        }
        if (error) {
          // Raw stderr may contain sensitive environment diagnostics. Keep only
          // the execution code; structured CLI errors above preserve useful hints.
          reject(new CliError(`飞书 CLI 进程失败或超时（${error.code || error.signal || 'unknown'}）；写入结果可能未知。`, { code: 'CLI_PROCESS', exitCode: error.code, uncertain: true })); return;
        }
        const validManifest = manifest && response?.manifest_version && response.format === 'ndjson';
        if (response?.ok !== true && !validManifest) {
          reject(new CliError('飞书 CLI 未返回可验证的成功回执；写入不得盲目重试。', { code: 'CLI_CONTRACT', uncertain: true })); return;
        }
        resolve(response);
      });
    });
  };
}
