# UIH AI EIL Professional Skills

面向产品可用性与风险分析的专业 Agent Skills。每个技能独立安装，使用当前智能体客户端完成分析，飞书业务读写通过官方 `lark-cli`。

## 当前技能

| 技能 | 版本 | 用途 |
|---|---|---|
| [fmea-assessment](skills/fmea-assessment/SKILL.md) | 1.0.1 | 为产品使用问题评估风险危害、发生等级和预见感知恢复性，计算综合分并交付飞书 Base |
| [urra-task-analysis](skills/urra-task-analysis/SKILL.md) | 1.0.0 | 按产品使用目的分析关键任务、具体步骤、PCA、潜在使用错误和操作影响，可交付飞书表格并局部修订 |
| [urra-risk-controls](skills/urra-risk-controls/SKILL.md) | 1.0.0 | 将任务分析中的每条潜在使用错误展开为一条措施记录，说明危险情况、潜在伤害、严重程度及缓释建议 |

## 一行安装

先准备 Node.js 22.20.0 或更高版本（安装器要求），以及 Git。以下命令使用 [Vercel Labs skills](https://github.com/vercel-labs/skills)，固定安装器及本仓库发布版本。

将 **URRA 措施 v1.0.0** 安装到当前用户的 Codex。此命令固定使用仓库标签 `v1.2.0` 中的技能。

```sh
npx --yes skills@1.9.0 add https://github.com/DamnParadox/uih-ai-eil-professional-skills/tree/v1.2.0/skills/urra-risk-controls --skill urra-risk-controls --agent codex --global --copy --yes
```

将 URRA 任务分析安装到 Codex，供当前用户的各项目使用。仓库标签为 `v1.1.0`，技能版本为 `1.0.0`。

```sh
npx --yes skills@1.9.0 add DamnParadox/uih-ai-eil-professional-skills@v1.1.0 --skill urra-task-analysis --agent codex --global --copy --yes
```

将 FMEA 评分安装到 Codex：

```sh
npx --yes skills@1.9.0 add DamnParadox/uih-ai-eil-professional-skills@v1.0.1 --skill fmea-assessment --agent codex --global --copy --yes
```

安装到 Claude Code：

```sh
npx --yes skills@1.9.0 add DamnParadox/uih-ai-eil-professional-skills@v1.0.1 --skill fmea-assessment --agent claude-code --global --copy --yes
```

安装到 Cursor：

```sh
npx --yes skills@1.9.0 add DamnParadox/uih-ai-eil-professional-skills@v1.0.1 --skill fmea-assessment --agent cursor --global --copy --yes
```

`--agent` 指定智能体，`--global` 安装到用户级目录，`--copy` 使用文件复制。去掉 `--global` 则安装到当前项目。已有同名技能的自定义修改需先备份；不要同时保留不同安装目录中的同名旧版。

安装器可识别这些平台的目录，不代表本技能已在所有平台完成业务验证。目前业务验证环境为 Windows / Codex；其他平台需要具备本地命令、文件访问和 CLI 执行能力。评分工具自身要求 Node.js 20+，上面的安装器要求更高。

如果使用支持 `gh skill` 的 GitHub CLI，也可按其[官方安装方式](https://cli.github.com/manual/gh_skill_install)安装：

```sh
gh skill install DamnParadox/uih-ai-eil-professional-skills fmea-assessment@v1.0.1 --agent codex --scope user
```

## 飞书接入与使用

一行命令安装的是技能及其配套脚本，不代替飞书 CLI 安装和授权。使用者需要在智能体实际执行命令的环境中安装官方 `lark-cli`，完成用户或应用身份接入，并具备目标文件的访问权限。授权和凭据不会随本仓库分发。

打开新对话，可输入 `$urra-task-analysis` 并附上背景资料，也可使用以下两行触发任务分析。

```text
/URRA任务分析
<飞书背景文档链接>
```

任务分析也可使用本地文字或可读附件。飞书表格包含主表和分析依据。需要修订时，提供已有项目目录并说明修改范围。

使用 URRA 措施时，在新对话中输入以下两行。也可以指定 `$urra-risk-controls` 并附上任务分析表链接。结果包含六列主表和分析依据，每个使用错误一行，严重程度按建议措施实施前的可信健康伤害评定为 1～5 级。

```text
/URRA措施
<飞书任务分析表链接>
```

使用 FMEA 评分时，在 Codex 输入：

```text
$fmea-assessment
请对下面的飞书多维表格进行 FMEA 评分：
<Base 链接，可包含 table 和 view 参数>

以下文档和附件仅作为参考资料：
<参考资料>
```

Claude Code 可用 `/fmea-assessment`；其他客户端也可通过技能菜单或明确指定技能名调用。无子代理能力时按既有流程依次完成三个维度。

当前全量评分主输入为飞书 Base 子表/视图。普通表格、云文档、Word、PDF 和图片可作为参考资料；直接以它们作为主输入的通用转换后续再做。缺少 CLI、没有可评分的问题、混合内容范围不明确或资料不能完整读取时，技能会分别说明问题与下一步。

## 版本与验证范围

- v1.0.1 补齐输入适用性、CLI 缺失提示和多份参考资料处理。
- 三项评分规则、总分公式、主流程与全部运行脚本沿用 v1.0.0。
- 64 项离线工程测试通过，并完成 8 个合成输入场景的行为检查；这些检查不代表专业判断准确率或所有平台均已验证。
- 本工具辅助内部改进排序，综合分不用于判定医疗器械风险可接受性或证明控制措施有效。

仓库 v1.1.0 加入 URRA 任务分析 v1.0.0。Windows 本地项目保存已验证文件占用后重试、快照与正文一致，以及归档中断后的恢复。发布 ZIP 和校验文件见 [GitHub Releases](https://github.com/DamnParadox/uih-ai-eil-professional-skills/releases)。

仓库 v1.2.0 加入 URRA 措施 v1.0.0。Windows / Codex 下通过 39 项本地工程回归，并用三条真实来源记录验证危险情况表述及六列导出。[下载技能 ZIP 与校验文件](https://github.com/DamnParadox/uih-ai-eil-professional-skills/releases/tag/v1.2.0)。

## 仓库结构

```text
skills/
  urra-risk-controls/
    SKILL.md
    agents/
    references/
    scripts/
    package-manifest.json
  urra-task-analysis/
    SKILL.md
    agents/
    references/
    scripts/
    package-manifest.json
  fmea-assessment/
    SKILL.md
    agents/
    references/
    scripts/
    package-manifest.json
```

无需部署机器人服务，也无需配置额外模型 API。每个技能目录包含独立运行所需的规则和脚本，分析项目应保存在技能目录之外。
