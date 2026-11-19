# 首次资料读取、保存与交付

**读取资料。** 本地资料直接读取。飞书云文档及指向云文档的 Wiki 链接在系统终端直接运行 `lark-cli docs +fetch --doc URL --as user`，保存成功回执中的正文。遇到用户身份或访问权限问题时，用 `--as bot` 读取同一目标。正文引用影响分析的流程画板时，用 `lark-cli docs +media-download --type whiteboard --token TOKEN --output PATH --as 身份` 保存并查看。文档选区、分页或附件按实际返回的范围处理；其他资源类型和命令报错时再查对应 CLI 指引。

**登记来源。** 下列命令直接在系统终端用 Node 执行。`SKILL` 是本技能目录，`PROJECT` 默认为当前工作目录下的 `analysis-projects/产品短名`。每份来源登记一次，飞书来源在元数据中保留原始 URL。

```text
node SKILL/scripts/assistant.mjs init PROJECT 产品名
node SKILL/scripts/assistant.mjs source PROJECT 已读取的本地文件 来源元数据.json
```

元数据示例为 `{"label":"产品背景","url":"原始文档链接"}`。取最后登记返回的 revision 和来源 ID。将首份完整分析写成 UTF-8 JSON，按使用目的组织关键任务，同组按实际流程排列。例如：

```json
{
  "baseRevision": 0,
  "notes": [{"key":"$n1","kind":"assumption","text":"此版本允许在预览时切换时段。","reason":"若只能看固定时段，则省去选择范围的动作。"}],
  "purposes": [{"purpose":"回顾设备运行情况","tasks":[{"name":"调取时段记录","steps":[{
    "action":"选择要比较的日期范围","p":"起止日期和当前选区","c":"识别本次需要比较的时段","ui":"日期选择控件",
    "noteIds":["$n1"],"errors":[{"text":"沿用上次的日期范围","cause":"将默认选区当成本次时段","consequence":"图表显示了另一段记录"}],
    "risk":"中","riskReason":"所见时段错误，现场可重新选择并查看。"
  }]},{"name":"判读变化趋势","steps":[{
    "action":"辨认曲线的变化方向","p":"时间轴和曲线","c":"判断选定时段内数值的变化方向","ui":"趋势图",
    "errors":[{"text":"读反曲线方向","cause":"误认时间轴方向","consequence":"对变化方向的判断相反"}],
    "risk":"中","riskReason":"可回看时间轴并当场纠正。"
  }]}]}]
}
```

来源用 `sourceIds` 关联已登记的 ID；新依据用唯一的 `$n...` 别名关联。任务、步骤和错误按数组顺序保存。显式给出每步的 errors 数组和一个综合评级；没有识别出适用错误时用空数组。局部修改、尚待补齐的草稿按原项目工作流提交补丁。

```text
node SKILL/scripts/analysis-run.mjs save PROJECT draft.json
node SKILL/scripts/analysis-run.mjs publish PROJECT user|bot [主参考文档来源ID]
```

保存成功后直接 `publish`。它负责导出、带最终版式建表、回读两页内容与合并和布局，并保存回执。正常交付以该回执为准。单独导出用于用户只要本地文件的情况；用户要求额外格式或回执报告具体差异时，再处理相应范围。CLI 的布局数据用于核对冻结、列宽和行高，实际显示或文字截断按能取得的证据说明。

传入主资料实际读取成功的身份，本地输入先用 user。bot 默认向主参考文档所有者授予编辑权限并回读。无云端主资料或所有者无法核实时，使用用户明确指定的协作者；多份主资料的所有者不同，先明确授权对象。已建表待补授权时，在同一项目运行：

```text
node SKILL/scripts/analysis-run.mjs publish PROJECT bot openid:ou_实际协作者
```

回执 `PROJECT/bindings/analysis-delivery.json` 分别记录主资料、目标协作者和已核实的权限。修复权限后也可原参数重跑，从原表续办。创建中断且没有成功回执时，先通过 CLI 核实是否已经建表；确认已有表则使用其结果标识和子表 ID 恢复回执，确认未创建后才可重新创建。已有分析的修改按[局部同步](feishu.md#局部同步和人工修改保护)处理。
