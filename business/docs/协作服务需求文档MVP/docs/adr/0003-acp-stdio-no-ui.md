# ACP stdio 作为 MVP 主入口，不做界面

状态：已采用

MVP **不提供任何界面**（无 Web、无桌面、无侧栏）。它是一个 DeepSeek Harness 插件，主入口是 **`dsh --profile acp`**——经 ACP（Agent Client Protocol）以 stdio 向外部客户端提供 Agent 服务；`dsh --profile headless --json` 作为脚本与 CI 验证入口。人通过**说话**驱动，Agent 调用插件提供的业务工具。

## 为什么值得记录

三个入口在 DSH 中都是真实存在的 profile（已实测 `dsh --profile acp --help`、`dsh --profile headless --help`、`dsh --profile headless --dump-default-config`，后者确认已挂载 `tools`/`agent`/`session`/`jobs`/`plugin-manager`）。因此"无界面"不是能力缺失，而是**把交互层交给宿主**：DSH 已提供会话、Agent 循环、工具调用与持久化，工作台只补业务状态与业务工具。

**并且已端到端验证过**：最小 ACP 客户端完成了 `initialize` → `session/new` → `session/prompt` 的完整握手，取得真实 `protocolVersion: 1` 与 `sessionId`；ACP profile 的组成层确认包含 `tools` 与 `agent-loop`，故插件工具可用。细节与注意事项见[事实核查记录](../验证/DSH-ACP-事实核查.md)。

这直接决定了验收方式：**不能靠"点开页面看一眼"验收**，每一步结果都必须能通过**查询**独立核实。这条约束写进了 MVP-032。

## 考虑过的方案

- **Web GUI**：与 `Experiment/` 现状一致。**未采用**：用户明确要求无界面，且界面会把预算烧在交互而非主链路上。
- **仅会话内对话**：最省事。**未采用**：无法被外部客户端或其他 Agent 程序化调用，MVP 的可验证性会依赖人工在场。

> **注意**：这里的"未采用"针对的是**把会话内对话当作唯一入口**。会话内**日常使用**本身是支持的，且**不需要任何触发词**——人直接说人话即可，Agent 自主选择工具（见 MVP-033 与[ADR-0005](../../../../docs/adr/0005-no-scheduler-human-initiates.md) 的「边界」一节）。
- **仅 headless CLI**：易脚本化。**未采用**：每次调用是"一问一答即退出"，不适合承载需要多轮确认的长流程。

## 后果

- **ACP 是协议、不是聊天窗口**：选择它意味着 MVP 的主要消费者是**程序化客户端**，而非直接坐在终端前的人。
- 全部 115 条原需求中的**界面类要求（G5：键盘可达、屏幕适配、详情可关闭等）整体失效**，涉及 NOTICE-006、OPS-012 等，已在[裁剪对照表](../../裁剪对照表.md)标注。
- 插件**不需要** client bundle（浏览器产物），只注册 Host 工具——这使打包与安装显著简化，也是"单插件"切分可行的原因。
- 验收必须走**程序化查询**；任何"要靠人眼看界面才能确认"的验收条件在 MVP 中不成立。
