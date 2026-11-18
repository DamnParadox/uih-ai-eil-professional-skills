#!/usr/bin/env node
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { initProject, loadProject, resume, addSource, commit, applyPatch, readJson, writeJson, validate } from './workspace.mjs';
import { exportTable, importAnalysis, syncPlan, verifySync, remoteHash } from './tables.mjs';
import { fmeaFields, fmeaBatches, verifyFmeaFields } from './fmea-base.mjs';

export async function main(argv) {
  const [command, dir, ...args] = argv;
  if (!command || ['help', '--help', '-h'].includes(command)) return { usage: [
    'init <project-dir> <name> [final-score-config.json]',
    'resume <project-dir>', 'show <project-dir> [collection] [id]',
    'source <project-dir> <local-file> [metadata.json: id?,url?,label?]',
    'preview <project-dir> <patch.json>', 'commit <project-dir> <patch.json>',
    'import-analysis <project-dir> <snapshot.json> <output.json> [splits.json]',
    'import-fmea <project-dir> <snapshot.json> <output.json>',
    'import-fmea-ndjson <project-dir> <manifest.json> <field-name> <patch.json> [source-id]',
    'verify-fmea-fields <CLI-field-list.json>',
    'export <project-dir> <fmea|analysis|measures> <output-dir>',
    'validate <project-dir> [fmea|analysis|measures]',
    'sync-plan <baseline.json> <local-export.json> <remote.json> <plan-output.json>',
    'sync-check <plan.json> <fresh-remote.json>', 'sync-verify <plan.json> <readback.json>',
  ], note: '所有命令均为本地操作，不调用模型或飞书，不处理授权。' };
  if (command === 'verify-fmea-fields') return verifyFmeaFields(await readJson(dir));
  if (command === 'init') return resume(await initProject(dir, args[0], args[1] ? await readJson(args[1]) : {}));
  if (command === 'sync-plan') { const p = syncPlan(await readJson(dir), await readJson(args[0]), await readJson(args[1])); await writeJson(args[2], p); return { safe: p.safe, writes: p.writes.length, conflicts: p.conflicts.length, remoteEdits: p.remoteEdits.length, output: args[2] }; }
  if (command === 'sync-check') { const p = await readJson(dir); if (!p.safe || remoteHash(await readJson(args[0])) !== p.remoteHash) throw new Error('远端数据在计划生成后发生变化或计划有冲突，禁止执行旧计划'); return { unchanged: true }; }
  if (command === 'sync-verify') return verifySync(await readJson(dir), await readJson(args[0]));
  if (command === 'source') return resume(await addSource(dir, args[0], args[1] ? await readJson(args[1]) : {}));
  const s = await loadProject(dir);
  if (command === 'resume') return resume(s);
  if (command === 'show') { if (!args[0]) return s; if (!Array.isArray(s[args[0]])) throw new Error('集合不存在'); return args[1] ? s[args[0]].find(r => r.id === args[1]) ?? null : s[args[0]]; }
  if (command === 'validate') { validate(s, args[0]); return { valid: true, revision: s.revision }; }
  if (command === 'preview' || command === 'commit') {
    const patch = await readJson(args[0]);
    if (command === 'commit') { const r = await commit(dir, patch); return { revision: r.state.revision, aliases: r.aliases, changed: r.changed, resume: resume(r.state) }; }
    const r = applyPatch(s, patch);
    return { before: resume(s), after: resume(r.state), changes: patch.ops.map(op => ({ ...op, before: s[op.collection].find(x => x.id === op.id) ?? null })) };
  }
  if (command === 'import-analysis') { const result = importAnalysis(s, await readJson(args[0]), args[2] ? await readJson(args[2]) : {}); await writeJson(args[1], result); if (result.ready) await writeJson(`${args[1]}.patch.json`, result.patch); return { ready: result.ready, errorCount: result.errorCount, ambiguous: result.ambiguous?.length ?? 0, output: args[1] }; }
  if (command === 'import-fmea') {
    const snapshot = await readJson(args[0]);
    if (snapshot.complete !== true || !Array.isArray(snapshot.records) || s.issues.length) throw new Error('需要完整 records 快照和空 issues 集合');
    const seen = new Set();
    const records = snapshot.records.filter(r => String(r.text ?? '').trim());
    const ops = records.map((r,i) => { if (!r.recordId || seen.has(r.recordId)) throw new Error('源记录 ID 缺失或重复'); seen.add(r.recordId); return { collection: 'issues', id: `$i${i}`, set: { text: r.text, sourceRecordId: r.recordId, sourceIds: snapshot.sourceId ? [snapshot.sourceId] : [] } }; });
    const patch = { baseRevision: s.revision, reason: '导入原始 FMEA 问题，保留源顺序和记录 ID', ops };
    applyPatch(s, patch); await writeJson(args[1], patch); return { count: ops.length, skipped: snapshot.records.length - ops.length, output: args[1] };
  }
  if (command === 'import-fmea-ndjson') {
    const [manifestFile, field, output, sourceId] = args, m = await readJson(manifestFile);
    if (m.format !== 'ndjson' || m.has_more !== false || !m.record_file || !m.columns?.[field] || !m.base_token || !m.table_id || m.rev == null || !m.query_context) throw new Error('需要完整的单块 CLI manifest；多块请合并核对版本和范围后使用 import-fmea');
    const file = path.isAbsolute(m.record_file) ? m.record_file : path.resolve(path.dirname(manifestFile), m.record_file);
    const raw = (await readFile(file, 'utf8')).replace(/^\uFEFF/u, '').trim();
    const records = raw ? raw.split(/\r?\n/u).map(line => JSON.parse(line)) : [];
    if (records.length !== m.records_count || new Set(records.map(r => r.record_id)).size !== records.length || records.some(r => !r.record_id || !Object.hasOwn(r, field))) throw new Error('NDJSON 记录数量、ID 或目标字段不完整');
    const snapshot = `${output}.snapshot.json`;
    await writeJson(snapshot, { complete: true, ...(sourceId ? { sourceId } : {}), origin: m,
      records: records.map(r => ({ recordId: r.record_id, text: r[field] ?? '' })) });
    return main(['import-fmea', dir, snapshot, output]);
  }
  if (command === 'export') {
    const t = exportTable(s, args[0]), out = args[1]; if (!out) throw new Error('缺少输出目录');
    await writeJson(path.join(out, 'export.json'), t);
    await writeJson(path.join(out, 'sheets.json'), t.sheets);
    await writeJson(path.join(out, 'styles.json'), t.styles);
    if (args[0] === 'fmea') {
      await writeJson(path.join(out, 'base-records.json'), t.rows.map(row => ({ fields: Object.fromEntries(t.columns.map((c,i) => [c, row[i]])) })));
      await writeJson(path.join(out, 'base-fields.json'), fmeaFields());
      const batches = fmeaBatches(t);
      for (const batch of batches) await writeJson(path.join(out, batch.file), batch.payload);
      await writeJson(path.join(out, 'base-batches.json'), { projectId: s.id, projectRevision: s.revision, rows: t.rows.length, batches: batches.map(({ payload, ...b }) => b) });
    }
    return { rows: t.rows.length, merges: t.merges.length, revision: s.revision, output: out };
  }
  throw new Error(`未知命令 ${command}，请使用 help`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { console.log(JSON.stringify(await main(process.argv.slice(2)), null, 2)); }
  catch (e) { console.error(JSON.stringify({ ok: false, message: e.message })); process.exitCode = 1; }
}
