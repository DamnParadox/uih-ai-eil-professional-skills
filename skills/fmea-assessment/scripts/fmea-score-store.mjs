import path from 'node:path';
import { mkdir, open, rename, unlink, access } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { readJson, writeJson, hash } from './workspace.mjs';

const present = async file => { try { await access(file); return true; } catch (e) { if (e.code === 'ENOENT') return false; throw e; } };

// This validates the transport contract only. It never assigns or normalizes a grade.
export function validateScoreResult(result, job, { complete = true } = {}) {
  if (!result || Array.isArray(result) || Object.keys(result).some(k => !['contextHash', 'rows'].includes(k)) || result.contextHash !== job.contextHash || !Array.isArray(result.rows)) throw new Error(`${job.key} 结果格式或上下文版本不匹配`);
  const expected = new Set(job.recordIds), seen = new Set();
  for (const row of result.rows) {
    if (!Array.isArray(row) || row.length !== 3 || !expected.has(row[0]) || seen.has(row[0]) ||
      !Number.isInteger(row[1]) || row[1] < 1 || row[1] > 5 || typeof row[2] !== 'string' || !row[2].trim()) throw new Error(`${job.key} 存在未知/重复 ID、非整数等级或空依据`);
    seen.add(row[0]);
  }
  if (complete && seen.size !== expected.size) throw new Error(`${job.key} 遗漏 ${expected.size - seen.size} 条：${[...expected].filter(id => !seen.has(id)).slice(0, 10).join(', ')}`);
  return new Map(result.rows.map(([id, level, reason]) => [id, { level, reason }]));
}

export function scoreLockFile(dir, job) {
  if (!/^[a-z]+-\d+$/u.test(job.key)) throw new Error('评分任务 key 无效');
  return path.join(dir, 'jobs', `${job.key}.save.lock`);
}

async function atomicJson(file, value) {
  const temp = `${file}.${randomUUID()}.tmp`;
  try {
    await writeJson(temp, value);
    for (let attempt = 0; ; attempt++) {
      try { await rename(temp, file); return; }
      catch (e) {
        if (!['EPERM', 'EBUSY', 'EACCES'].includes(e.code) || attempt >= 4) throw e;
        await new Promise(resolve => setTimeout(resolve, 40 * (attempt + 1)));
      }
    }
  } finally { await unlink(temp).catch(e => { if (e.code !== 'ENOENT') throw e; }); }
}

async function existingResult(dir, job) {
  const file = path.join(dir, job.outputFile);
  try { const result = await readJson(file); validateScoreResult(result, job, { complete: false }); return result; }
  catch (e) { if (e.code === 'ENOENT') return { contextHash: job.contextHash, rows: [] }; throw e; }
}

function progress(dir, job, result) {
  const seen = new Set(result.rows.map(r => r[0])), missingIds = job.recordIds.filter(id => !seen.has(id));
  return { key: job.key, dimension: job.dimension, saved: seen.size, total: job.recordIds.length,
    complete: missingIds.length === 0, missingIds, outputFile: path.join(dir, job.outputFile) };
}

export async function checkScores(dir, jobs) {
  const results = await Promise.all(jobs.map(async job => {
    try { return { valid: true, ...progress(dir, job, await existingResult(dir, job)) }; }
    catch (e) { return { key: job.key, dimension: job.dimension, valid: false, complete: false, error: e.message, outputFile: path.join(dir, job.outputFile) }; }
  }));
  return { valid: results.every(r => r.valid), complete: results.every(r => r.complete), jobs: results };
}

export async function assertNoScoreWriters(dir, jobs) {
  for (const job of jobs) if (await present(scoreLockFile(dir, job))) throw new Error(`${job.key} 正在保存，待保存命令完成后再接收评分`);
}

export async function saveScores(dir, job, draftFile, { replace = false, assertEditable } = {}) {
  if (!draftFile) throw new Error('save-scores 需要评分草稿 JSON 文件');
  const outputFile = path.join(dir, job.outputFile), inputFile = path.resolve(draftFile);
  if (path.relative(outputFile, inputFile) === '') throw new Error('请把新内容写入独立草稿文件，不能直接覆盖已保存结果');
  const lockFile = scoreLockFile(dir, job);
  await mkdir(path.dirname(lockFile), { recursive: true });
  let lock;
  try { lock = await open(lockFile, 'wx'); }
  catch (e) { if (e.code === 'EEXIST') throw new Error(`${job.key} 已有保存进程；不要同时保存同一维度任务`); throw e; }
  try {
    // The main workflow holds its global lock before checking these job locks.
    // Workers hold their job lock before checking the global lock: accept cannot
    // read half of a save, while different dimensions can save concurrently.
    if (await present(path.join(dir, '.fmea-run.lock'))) throw new Error('主流程正在修改项目，待其完成后再保存评分');
    await assertEditable?.();
    const incoming = await readJson(inputFile), values = validateScoreResult(incoming, job, { complete: false });
    const prior = await existingResult(dir, job), merged = validateScoreResult(prior, job, { complete: false });
    let added = 0, replaced = 0;
    for (const [id, value] of values) {
      if (!merged.has(id)) { added++; merged.set(id, value); }
      else if (!isDeepStrictEqual(merged.get(id), value)) {
        if (!replace) throw new Error(`${job.key} ${id} 已有不同评分；确认是在修订该条后使用 --replace，其他记录保持不变`);
        replaced++; merged.set(id, value);
      }
    }
    const result = { contextHash: job.contextHash, rows: job.recordIds.filter(id => merged.has(id)).map(id => [id, merged.get(id).level, merged.get(id).reason]) };
    let historyFile;
    if (added || replaced) {
      // Store valid snapshots before replacing the current result. A failed save
      // leaves the previous result intact; explicit corrections remain recoverable.
      const history = path.join(dir, 'jobs', 'history', job.key);
      if (prior.rows.length) await atomicJson(path.join(history, `${hash(prior)}.json`), prior);
      historyFile = path.join(history, `${hash(result)}.json`);
      await atomicJson(historyFile, result);
      await atomicJson(outputFile, result);
    }
    const { missingIds, ...status } = progress(dir, job, result);
    return { ...status, added, replaced, unchanged: values.size - added - replaced, ...(historyFile ? { historyFile } : {}) };
  } finally { await lock.close(); await unlink(lockFile); }
}
