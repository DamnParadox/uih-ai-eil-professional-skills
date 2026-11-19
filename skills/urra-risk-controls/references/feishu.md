# 飞书交付、异常与原表修订

全部飞书读写、权限和回读仅用 lark-cli；不使用浏览器、直接 HTTP/SDK 或其他连接器。常规读取/交付使用 measures-run.md 的稳定入口，其他资源类型或命令不支持时按目标查 lark-doc、lark-sheets、lark-drive 等技能及具体命令帮助，不重复探查无关命令。

## 身份和故障

默认 user 先访问，身份或目标权限不足再用 bot 读取同一范围，不再询问是否切换。网络、参数错误和公共凭据存储故障按实际证据诊断；空数据不是无权限的证据。两种身份均不可用时分别说明原因。CLI 缺失引导安装并接入；认证、scope和资源ACL错误按 lark-shared 解决，用户负责授权。不要读取或输出密钥。

read 只自动处理电子表格及指向它的Wiki。Base、云文档或本地材料用相应读取能力提取真实步骤与错误，按文字入口接入，不因格式不同拒绝可用内容。没有步骤/使用错误或关键对象不明确时说明缺口。读取截断时按相同范围分段续读、核对完整后接入；不能直接把complete改成true。

user 在用户默认空间创建，bot 在应用默认空间创建；沿用主资料成功访问身份。bot 核实主参考文档及结果表的所有者。主资料由用户所有时授予该用户 edit 并回读；若主资料与结果均由当前应用所有，已有所有权无需重复授权，实际接收人另行核实。所有者、当前应用身份和接收人分别记录，不以创建人、最后编辑者或任意协作者代替。无云端主资料、主资料不明确或应用所有且无已授权接收人时，只请用户明确目标资料或接收人；不复制整份协作者名单。

publish 保存创建、内容校验和权限状态，失败后在同一项目续做。已建表未授权时传入 openid:ou_... 修复原表；不另建副本。创建中断无成功回执时，用CLI核实是否已有表：确认存在后恢复原token、URL和子表映射，确认未建后才重试创建。内容、合并和布局完整回读；单元格样式仅抽查表头及正文首、中、末范围，不先读取全表样式。补授权沿用内容校验状态，已验证回执可直接复用；显式指定原接收人可重新核验其权限。CLI校验不代表已目视确认显示或文字截断。

## 局部同步与人工修改

本地只改对应errorId记录，保留稳定ID。已有结果表先读取最新内容，与 bindings/baseline-measures.json 和本地新导出做三方比较。主表保持六列；ID和理由在分析依据及本地项目。

```text
node SKILL/scripts/assistant.mjs sync-plan baseline.json local-export.json remote.json plan.json
node SKILL/scripts/assistant.mjs sync-check plan.json fresh-remote.json
node SKILL/scripts/assistant.mjs sync-verify plan.json readback.json
```

remote为完整归一化快照：`{"complete":true,"columns":["六列名称"],"rows":[["不含表头的数据"]],"merges":[{"range":"A2:A4"}]}`。按实际原始类型保留数值，合并区域只保留左上角值。不能跳过合并核对或把远端重排行号当作原ID。

sync-plan不发请求。远端单独修改保留，同格双方修改列入冲突；已有用户明确选择则按其要求处理，否则只询问具体冲突。将接纳的人工修改写回项目，必要时锁定字段，不能用旧本地内容覆盖。增删行、重排、合并变化或重复定位内容时，工具会拒绝按旧位置同步；先核对稳定ID映射或按用户要求交付新版。

无冲突写入计划转换为CLI `sheets +cells-set --writes @./writes.json`，每项保留range和cells（接口单次最多100项）。写前立即回读并sync-check，写后sync-verify；远端并发修改时不静默覆盖重试。分析依据页也需对应更新并保留人工备注。全部内容核对后更新本地基线和回执，保存中断进度。底层格式见 workspace.md，具体CLI写入用法按当前lark-sheets指引执行。
