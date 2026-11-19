# 项目续做与局部补丁

常规接入、保存、评级和交付用 measures-run.md；以下用于已有项目的来源更新、假设修订、人工锁定或结构变更。业务文件保存在 PROJECT，不放技能目录。当前客户端负责专业判断，脚本不调用模型或配置认证。

```text
node SKILL/scripts/assistant.mjs resume PROJECT
node SKILL/scripts/assistant.mjs show PROJECT measures [稳定ID]
node SKILL/scripts/assistant.mjs source PROJECT 原文文件 元数据.json
node SKILL/scripts/assistant.mjs preview PROJECT patch.json
node SKILL/scripts/assistant.mjs commit PROJECT patch.json
node SKILL/scripts/assistant.mjs validate PROJECT measures
```

元数据为 `{"label":"名称","url":"可选原链接","id":"更新已有来源时才指定D-ID"}`。来源保存不可变副本、SHA256及版本；同一来源更新会标记依赖记录stale，新增来源需判断其实际影响。resume提供revision、来源、依据、计数和失效状态；按需show具体集合，不反复重读全表。

## 数据与修订

稳定编号关联：tasks → steps.taskId → errors.stepId → measures.errorId。sources的ID为D-，notes为N-，其他记录分别为T-/S-/E-/M-。同名步骤仍有独立ID。notes的kind为fact、assumption、decision，不把上游推断改称事实。

主要字段：

| 集合 | 内容 |
|---|---|
| notes | kind、text、reason |
| tasks | purpose、name；可有scope、actor、condition、start、end |
| steps | taskId、action、p/c或pca、ui、condition |
| errors | stepId、text、cause、consequence、sourceText、sourceRow |
| measures | errorId、paths、controls、conclusion |

所有记录可有sourceIds、noteIds、basis、status、lockedFields、stale。来源和依据只关联其影响的记录。路径和措施字段见measures-run.md；路径的domain为health/property/environment/service，评级前可不填severity。controls.pathIndices从0开始，路径顺序变化必须同步对应措施索引；不能通过删去可信路径绕过覆盖校验。

补丁示例：

```json
{"baseRevision":4,"reason":"用户补充资料纠正先前假设","ops":[{"collection":"notes","id":"N-实际ID","set":{"text":"可在发送前核对但发送后不能撤回","kind":"fact","sourceIds":["D-资料ID"]}}]}
```

每次修改须使用当前baseRevision，过期补丁不覆盖新内容。新记录id用唯一 `$别名`，同补丁内引用由脚本解析为真实ID；`delete:true`删除记录，存在下游引用时先处理关联，不能静默丢失分析。修改顺序用patch.order的完整ID数组。

源事实、假设、任务、步骤或错误改变时，相关下游记录变为stale。核实输入及其关联后只清除已检查记录的stale；measures可用save提交完整的paths、controls和conclusion确认本次分析。不能批量清空stale绕过判断。仅修改controls不清除旧stale，也不改变评级。

已有路径的危险情况、伤害、机制、条件或顺序变更会清除旧severity/severityReason；随后独立rate。若底层补丁只变路径未确认controls，记录仍保持stale。最终导出要求每条错误恰有一条有效措施、每条路径已评级且有措施覆盖。任务分析的riskStale属于操作影响评级，不因它单独触发措施重评。

人工确定内容可用lockedFields锁定，如 `["controls"]`。用户明确要求改锁定字段时先单独解锁，再提交修改；同一补丁中一边解锁一边改内容会被拒绝。

## 保存与恢复

正文project.json、版本history、原始来源sources、导出exports和云端bindings分别存储。保存以正文替换成功为提交点，再完成对应版本归档；Windows短暂占用由工具重试。失败后先resume确定当前版本，不复用过期补丁、不手工复制随机历史快照。

若.write.lock仍在，先确认没有写入进程再移除；不要删除项目重新开始。跨聊天通过用户给出的项目路径恢复，不能承诺客户端自动记住所有项目。已有飞书结果的更新与远端人工修改按feishu.md处理；本地保存成功不代表云端已经同步。
