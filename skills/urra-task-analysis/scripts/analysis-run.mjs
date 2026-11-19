import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadProject, commit, readJson, resume } from './workspace.mjs';
import { publish } from './analysis-delivery.mjs';

// A nested draft represents one consistent snapshot. Later edits use the normal revisioned patch workflow.
export async function saveInitial(dir, draft) {
  const state = await loadProject(dir);
  if (state.tasks.length || state.steps.length || state.errors.length) throw Error('已有任务分析；请 resume 后按稳定 ID 局部修改。');
  let tasks = draft.tasks;
  if (Object.hasOwn(draft, 'purposes')) {
    if (tasks !== undefined || !Array.isArray(draft.purposes) || !draft.purposes.length)
      throw Error('按使用目的提供非空 purposes 数组，顶层 tasks 仅用于旧草稿。');
    tasks = draft.purposes.flatMap(({ purpose, tasks: group }) => {
      if (typeof purpose !== 'string' || !purpose.trim() || !Array.isArray(group) || !group.length)
        throw Error('每个使用目的需要名称和至少一项关键任务。');
      return group.map(task => {
        if (task.purpose !== undefined && task.purpose !== purpose) throw Error('关键任务与所属使用目的不一致。');
        return { ...task, purpose };
      });
    });
  }
  if (!Array.isArray(tasks) || !tasks.length) throw Error('需要非空任务数组');
  const ops = [];
  function insert(collection, id, fields) {
    if (!fields || typeof fields !== 'object' || Array.isArray(fields)) throw Error('记录必须是对象');
    ops.push({ collection, id, set: fields });
  }
  for (const { key, ...note } of draft.notes ?? []) {
    if (!/^\$n[\w-]+$/.test(key)) throw Error('新依据 key 应为 $n 开头的唯一别名');
    insert('notes', key, note);
  }
  for (const { steps, ...task } of tasks) {
    const taskId = '$task' + ops.length;
    insert('tasks', taskId, task);
    if (!Array.isArray(steps) || !steps.length) throw Error('每项任务需要 steps');
    for (const { errors, ...step } of steps) {
      if (!Array.isArray(errors)) throw Error('每步须提供对应 errors 数组');
      const stepId = '$step' + ops.length;
      insert('steps', stepId, { ...step, taskId, riskStale: false });
      for (const error of errors) insert('errors', '$error' + ops.length, { ...error, stepId });
    }
  }
  const result = await commit(dir, { baseRevision: draft.baseRevision, reason: '保存首次完整任务分析', ops }, 'analysis');
  return resume(result.state);
}

export async function main([cmd, dir, ...args]) {
  if (cmd === 'save' && dir && args.length === 1) return saveInitial(dir, await readJson(args[0]));
  if (cmd === 'publish' && dir && args.length >= 1 && args.length <= 2) return publish(path.resolve(dir), args[0], args[1]);
  throw Error('用法：save PROJECT draft.json 或 publish PROJECT user|bot [主资料来源ID 或 openid:ou_...]');
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { console.log(JSON.stringify(await main(process.argv.slice(2)), null, 2)); }
  catch (e) { console.error(e.message); process.exitCode = 1; }
}
