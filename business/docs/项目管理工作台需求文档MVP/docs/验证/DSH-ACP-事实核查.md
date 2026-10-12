# 事实核查记录：DSH / ACP 运行环境

本文记录在编写 MVP 需求前**实测核实**的环境事实，用于支撑 [ADR-0003](../adr/0003-acp-stdio-no-ui.md) 与 `MVP-032` 的验收可执行性。

核实日期：2026-10-11。核实环境：本机 `C:\Users\cjh13\AppData\Local\Programs\DeepSeek Harness`（desktopVersion `0.2.0-rc.2`，内置 Node `24.21.0` / pnpm `11.7.0`）。

**方法**：直接在本机运行命令并驱动真实进程，不依据文档推测。

---

## 1. ACP 入口真实可用（已端到端验证）

`dsh --profile acp` 真实存在并接受 ACP（Agent Client Protocol）JSON-RPC over stdio。

我写了一个最小 ACP 客户端，实际完成了一次完整握手：

| 步骤 | 请求 | 实测结果 |
| --- | --- | --- |
| 1 | `initialize` | ✅ 返回 `protocolVersion: 1`，`agentInfo.name: deepseek-harness-acp`，`version: 0.0.1` |
| 2 | `session/new` | ✅ 返回真实 `sessionId`：`6e04fd00-b813-48da-8046-db082d6e1cdb` |
| 3 | `session/prompt` | ✅ `stopReason: end_turn`，模型实际应答 |
| 4 | `session/update`（通知） | ✅ 收到流式 `agent_message_chunk` |
| 5 | **工具调用** | ✅ 观察到 `[tool_call] pwsh`，真实执行命令并返回结果 |

第 5 步是关键：它证明 **ACP profile 中进程内工具确实可被模型调用**，而不只是"配置里挂着 `tools` 插件"。

**进一步验证**：已用一个自定义插件（自有 `ping_probe` 工具）完成端到端验证——工具被真实调用并回传 token。完整可复现步骤见[实现前验证清单](实现前验证清单.md)。

`initialize` 返回的 agent 能力：

```json
{"protocolVersion":1,
 "agentInfo":{"name":"deepseek-harness-acp","version":"0.0.1"},
 "agentCapabilities":{
   "mcpCapabilities":{"http":true},
   "promptCapabilities":{"image":false,"audio":false,"embeddedContext":false},
   "sessionCapabilities":{"close":{},"list":{},"resume":{}}},
 "authMethods":[]}
```

**结论**：ADR-0003 的前提成立，ACP 可作为主入口。注意 `promptCapabilities.image = false`——**MVP 的分析能力不能假设能通过 ACP 提示词直接传图**，图片必须走"上传入库 + 按固定版本读取"这条路径。

## 2. ACP 协议方法清单（从运行时提取，非推测）

从 `app.asar` 提取到真实常量表：

**Agent 侧方法**（客户端调用）：
`initialize`、`authenticate`、`providers/list`、`providers/set`、`providers/disable`、`session/new`、`session/load`、`session/set_mode`、`session/set_config_option`、`session/prompt`、`session/cancel`、`mcp/message`、`session/list`、`session/delete`、`session/fork`、`session/resume`、`session/close`、`logout`、`nes/*`、`document/*`

**Client 侧方法**（Agent 回调客户端）：
`session/request_permission`、`session/update`、`fs/read_text_file`、`fs/write_text_file`、`terminal/*`、`mcp/connect|message|disconnect`、`elicitation/create|complete`

**关键点**：`session/update` 是**通知**（无 id），Agent 用它流式推送文本与工具调用；`session/request_permission` 是**请求**（有 id），需要客户端应答，否则回合会挂住。

## 3. 插件工具在 ACP profile 中可用

`dsh --profile acp --dump-default-config` 显示该 profile 的组成层包含：

- `@deepseek-ai/dsh-tools`（id: `tools`）✅
- `@deepseek-ai/dsh-agent-loop`（id: `agent-loop`）✅
- `@deepseek-ai/dsh-agent`、`dsh-session`、`dsh-goal`、`dsh-skill`、`dsh-tool-skill`

`DSH-taskboard` 的插件挂载方式是 `ctx.inject(['tools'], ...)` 注册工具（见其 `src/index.ts`）。由于 ACP profile 组成层包含 `tools`，**同一插件模式在 ACP 下同样成立**。

**结论**：MVP 的"单插件 + 进程内工具"设计在 ACP 入口下可行，不需要 client bundle（浏览器产物）。

## 4. 模型凭据（已解决）

**首次核查时的现象**：`session/prompt` 返回

```
{"code":-32603,"message":"Internal error: turn failed: llm-deepseek: no API key for
 provider route \"deepseek-official\"; store DEEPSEEK_API_KEY through the credentials
 service (the web Models page writes it), or export DEEPSEEK_API_KEY ..."}
```

`dsh --profile headless "..."` 同样失败（`MISSING_CREDENTIAL`），证明这是**全局凭据问题，不是 ACP 的缺陷**。

**现状**：用户补充 API KEY 后复测——

- `dsh --profile headless "reply with exactly: PROBE-OK"` → 返回 `PROBE-OK` ✅
- ACP `session/prompt` → `stopReason: end_turn`，模型应答 ✅
- ACP 内工具调用 → `[tool_call] pwsh` ✅

**结论**：凭据阻塞已消除，`MVP-032` 端到端演练**全流程可执行**（含依赖 Agent 的步骤）。MVP-032 中"分两段执行"的说明因此变为**可选建议**（先验状态机、后验 Agent 步骤）而非必要前提。

## 5. 其他已核实事实

| 事实 | 实测 |
| --- | --- |
| `dsh --profile headless` 存在 | ✅ "Answer one task and exit"，支持 `--json`、`--session-id` |
| headless 已挂载的核心插件 | ✅ `tools`、`agent`、`session`、`jobs`、`plugin-manager`、`goal` |
| headless 可实际调用工具 | ✅ 要求执行 `pwsh` 并返回真实日期 |
| ACP 会话持久化 | ✅ 会话写入 `~/.dsh/sessions`（按 cwd 分目录） |
| desktop / web / acp / headless profile | ✅ 均存在于 `~/.dsh/profiles` 或为内置 profile |
| 内置 Node / pnpm | ✅ `24.21.0` / `11.7.0` |

**另注**：`dsh.cmd` 实际执行 `DeepSeek Harness.exe --expose-internals <asar 内 cli.js>`，并设 `ELECTRON_RUN_AS_NODE=1`。在 Windows 上以程序方式驱动 ACP 时，**应直接 spawn 该 exe 并传参数组**，不要经 `cmd.exe` 包装——路径含空格，`shell: true` 会导致参数被错误切分（实测报 `'C:\Users\cjh13\AppData\Local\Programs\DeepSeek' is not recognized`）。这是实现 MVP 客户端时的具体注意事项。
