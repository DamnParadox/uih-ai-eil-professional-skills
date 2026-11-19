# 接入、保存与交付

`SKILL` 为本技能目录，脚本使用 Node 20+。`PROJECT` 为当前工作目录下 `analysis-projects/产品短名`，后续沿用同一目录。JSON 文件为 UTF-8，命令中的输入文件路径相对终端当前目录；统一入口的导出与交付文件固定保存到 PROJECT 内。

## 输入与上下文

用户给出任务分析链接时，用本次项目目录直接运行 read。它会初始化新目录，无需先搜索同名项目或导出本地上下文。用户明确接续已有本地项目时才直接运行 context。

```text
node SKILL/scripts/measures-run.mjs read PROJECT 飞书任务分析链接 [子表ID或名称]
node SKILL/scripts/measures-run.mjs context PROJECT context.json
```

read 通过 CLI 解析 Sheets/Wiki、完整读取所有子表、识别任务表、取得实际合并范围并登记来源。读取身份先 user 后 bot；保存到 inputs/current.json 供交付沿用。主表与辅助页保存在来源快照；标准“分析依据”表的 fact/assumption/decision 及可解析的步骤关联会接入项目。其他辅助材料仍在快照中，读取会影响判断的内容并按其事实/假设身份关联，不能仅看错误清单。多张候选表无法确定时指定子表，不拼成一个产品。

read 返回 ready:false 时，尚未导入；查看返回的 ambiguous。明确只有一条的单元格保留整段；多条只分割原文，写成 `{"C2":["第一段完整原文","第二段完整原文"]}`，然后：

```text
node SKILL/scripts/measures-run.mjs prepare PROJECT 返回的snapshot.json splits.json
```

文字资料接入新项目时先运行 `node SKILL/scripts/assistant.mjs init PROJECT 产品名`，再保存原文并登记来源：

```text
node SKILL/scripts/assistant.mjs source PROJECT 原文文件 来源元数据.json
```

元数据为 `{"label":"资料名称","url":"可选的原始链接"}`。提取已有步骤与错误为以下输入，sourceId 使用返回的真实 ID。字段缺失可省略，不生成替代性步骤或错误；保留 sourceRow/sourceText 或 basis 中的位置说明。

```json
{"complete":true,"sourceId":"D-实际来源ID","notes":[{"key":"$nScope","kind":"assumption","text":"可重试导出且保留原件","reason":"需由产品资料确认"}],"steps":[{"purpose":"交付照片","task":"导出照片","action":"选择照片","ui":"照片列表","pca":"原资料的PCA文字（如有）","noteIds":["$nScope"],"errors":[{"text":"漏选一张照片","cause":"忽略未选状态","consequence":"导出集合不完整","sourceText":"原文"}]}]}
```

```text
node SKILL/scripts/measures-run.mjs prepare PROJECT input.json
```

context 按步骤给出错误ID、原因、直接后果、PCA、UI、条件和关联依据，项目来源与依据仅列一次。来源增补仍通过 source，依据修订通过项目补丁；避免为同一资料反复登记。task analysis 的 riskStale 只影响其操作评级，不要求为措施任务重评高中低。

## 分析保存

根据 context 返回的 baseRevision 和 errorId 保存。记录可为全量或本次修改范围；已有记录按 errorId 更新，不重建编号。你只填写专业内容，脚本继承步骤及错误的来源/依据关联。新增假设放 notes，用 `$n...` 关联。

```json
{"baseRevision":2,"notes":[{"key":"$nModel","kind":"assumption","text":"发送后无法撤回","reason":"若可撤回则需修订暴露持续条件"}],"records":[{"errorId":"E-实际ID","noteIds":["$nModel"],"conclusion":"错址且未在发送前纠正时造成非预期披露","paths":[{"domain":"service","situation":"照片送达非预期收件人","harm":"隐私信息披露，未识别可信健康伤害","mechanism":"有效但错误的地址被提交且无法撤回"}],"controls":[{"target":"发送确认界面","proposal":"完整显示收件地址与照片，地址变更后清除确认状态","mechanism":"使错址在发送前可见并可纠正","verification":"观察用户能否发现相似错址并纠正"}]}]}
```

```text
node SKILL/scripts/measures-run.mjs save PROJECT analysis.json
node SKILL/scripts/measures-run.mjs ratings PROJECT ratings-input.json
```

save 接受未评级草稿；paths 不包含评级。每条 paths 可有多条或为空；多路径时 controls 显式给 `pathIndices:[0,1]` 指向本记录路径，单路径/空路径由代码补索引。无路径仍给 conclusion 和针对源错误的可用性建议。路径的适用条件用 paths[].conditions，随对应路径导出到分析依据；有具体实施约束时才填写 controls[].conditions。正文不重复写“建议、未验证”，导出统一标记。

ratings 只提供错误、已形成的伤害路径、结论及相关依据，不带措施文本。按其当前版本与路径顺序评级，保存：

```json
{"baseRevision":3,"records":[{"errorId":"E-实际ID","paths":[{"severity":1,"severityReason":"非健康后果，本级仅代表健康维度"}]}]}
```

```text
node SKILL/scripts/measures-run.mjs rate PROJECT ratings.json
```

无路径记录由代码得出总级别1，保留边界说明。评级不增加或改变伤害路径；版本不符重新读取相关记录。只改措施用 `records:[{errorId,controls:[...]}]` 保存，路径及评级不动。修改路径时脚本清除旧评级；同时确认措施仍覆盖当前路径后保存，再 rate。高级变更、人工锁定、来源替换按 workspace.md 的补丁处理；未核实的 stale 不可清空。

## 交付

```text
node SKILL/scripts/measures-run.mjs publish PROJECT [user或bot] [主资料来源ID或openid:ou_协作者] [--title "最终标题"]
```

首次 publish 用 --title 传入用户指定的标题，或依据已识别的产品／分析对象命名为“对象名-URRA措施”。对象无法确定时使用“URRA措施”。建表时写入最终标题，续做沿用原回执。优先沿用 read 保存的身份和主资料；本地输入先 user。同项目接续而没有 inputs/current.json 时，显式传入主资料实际读取身份和来源 ID。脚本负责最终完整性校验、导出、建表、两页内容及合并/布局回读和样式抽查。bot 查询主资料所有者：用户所有则核实其编辑权限；当前应用所有则保留所有权，向已授权实际接收人授予编辑权限。无法确定接收人时保留结果链接，只澄清接收人，在原 PROJECT 用 openid:ou_... 重跑 publish 补授权。只补授权时不重新导出、建表或回读已校验内容；来源、所有者和接收人分别保存在回执中。回执位于 bindings/measures-delivery.json。

创建结果未知时先核实原回执及云端状态；publish 会拒绝重复创建。已有交付后的内容修订走 feishu.md 的局部同步，不更换 PROJECT 绕过已有对象。无需飞书消息通知。

仅需本地导出时执行 `node SKILL/scripts/measures-run.mjs export PROJECT`，结果位于 PROJECT/exports/measures/r版本，含主表、依据、格式和合并载荷。它是可交付到飞书的JSON；用户需要其他文件格式时按需求另行转换，不能称为已创建飞书表。
