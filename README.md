# Codex ↔ DeepSeek Harness bridges

Three MCP bridges that let **Codex keep the decision-making** and hand work to
**DeepSeek Harness (DSH)**. They differ in one axis each: capability
(`text-only`), process lifetime (`one-shot`), and session warmth (`warm-session`).

| Variant | Tool surface | DSH capabilities | Permission requests |
|---|---|---|---|
| [`text-only`](text-only/) | `dsh_think` | **none** — text in, text out | impossible by construction |
| [`one-shot`](one-shot/) | `dsh_run`, `dsh_continue`, `dsh_read` | files, shell, web, subagents | possible outside the workspace |
| [`warm-session`](warm-session/) | `dsh_run`, `dsh_continue`, `dsh_read` | files, shell, web — in persistent ACP sessions | answered inside the client, fail-closed |

All three are dependency-free Node MCP servers speaking newline-delimited
JSON-RPC 2.0 over stdio, written around one rule: **the caller's context is the
scarce resource**, so every reply is a bounded summary and full transcripts are
stored out of band.

| Name | The defining property |
|---|---|
| `text-only` | DSH has **no tools** — the only capability axis |
| `one-shot` | Every call spawns a **fresh process**; nothing carries over |
| `warm-session` | One persistent process, **sessions reused per directory** |

---

# 中文说明

## 这是什么

三个 MCP 桥，方向都是「Codex 决策 / DSH 执行」，区别在**信任模型**：

- **`text-only`（纯文本）**：DSH 没有任何工具，只能读你粘贴给它的文字。它碰不到本机，所以**不可能**发起权限请求。
- **`one-shot`（一次性）**：DSH 保留完整工具（文件、shell、网页、子代理），每次调用新起进程，状态不残留。
- **`warm-session`（热会话）**：同样的工具，但常驻一个 ACP 进程，同目录复用会话，冷启动只付一次。

三个桥对 Codex 的接入方式完全一样：在 `~/.codex/config.toml` 里加一段 `[mcp_servers.*]`。

## 目录

```
dsh-bridge-variants/
├── text-only/                 # 无工具：只能读文本、返回分析
│   ├── bridge.mjs             # MCP server，只有 dsh_think
│   ├── profile.patch.yml      # 禁用全部工具的 DSH profile 补丁
│   └── test-client.mjs
├── one-shot/                  # 每次调用新进程：状态不残留
│   ├── bridge.mjs             # MCP server，dsh_run / dsh_continue / dsh_read
│   ├── profile.patch.yml      # 重新启用已保存凭据
│   └── test-client.mjs
└── warm-session/              # 常驻 ACP 进程：同目录复用会话
    ├── bridge.mjs             # MCP server + 会话复用
    ├── lib/acp.mjs            # 帧、信封校验、超时、反向请求
    ├── lib/policy.mjs         # 权限应答（fail-closed）
    ├── lib/session.mjs        # 会话池 + 更新投影
    └── test/                  # 离线协议测试 + 真实 DSH 冒烟 + 端到端
```

## 共同设计原则：Token 预算

主目标是**把 Codex 的上下文留给决策，而不是读日志**。三个桥都遵守：

| 规则 | 实现 |
|---|---|
| 只回摘要 | `text-only`：6000 字符；`one-shot` / `warm-session`：900 字符 |
| 全文不塞上下文 | `one-shot` / `warm-session` 落盘到 `results/<handle>.md`，用 `dsh_read` 分页取 |
| 失败紧凑 | 只给退出码 + 错误 + 少量 stderr |
| 不轮询 | 同步阻塞一次，不做 `dsh_wait` |
| 工具定义精简 | `text-only` 只有一个工具 |

判断标准：**这段文字能不能帮 Codex 做下一个决定？不能就别放进去。**

## 安装

先确认 DSH 的 CLI 路径（macOS 默认在应用包里）：

```bash
ls "/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh"
```

### text-only

```toml
[mcp_servers.dsh-text-only]
command = "node"
args = ["/绝对路径/dsh-bridge-variants/text-only/bridge.mjs"]
```

### one-shot

```toml
[mcp_servers.dsh-one-shot]
command = "node"
args = ["/绝对路径/dsh-bridge-variants/one-shot/bridge.mjs"]
startup_timeout_sec = 60
tool_timeout_sec = 3600
env = { DSH_BRIDGE_CWD = "/你的工作区" }
```

> 如果你的环境里没有独立 `node`（例如只装了 DSH 应用），可以把 `command` 换成
> DSH 自带的 Electron 运行时，并加 `ELECTRON_RUN_AS_NODE=1`：
>
> ```toml
> command = "/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness"
> env = { ELECTRON_RUN_AS_NODE = "1" }
> ```

### warm-session

```toml
[mcp_servers.dsh-warm-session]
command = "node"
args = ["/绝对路径/dsh-bridge-variants/warm-session/bridge.mjs"]
startup_timeout_sec = 60
tool_timeout_sec = 3600
env = { DSH_BRIDGE_CWD = "/你的工作区" }
```

改完配置需要**重启 Codex**，并**新开一个对话**（MCP 工具面按会话绑定，旧会话不会热加）。

## 验证

三个版本都自带测试客户端：

```bash
# warm-session：离线协议测试（零 token）
node warm-session/test/run-tests.mjs

# warm-session：端到端（冷启动 / 热复用 / 超时 / 恢复）
node warm-session/test/verify-bridge.mjs

# text-only：握手 + 一次真实分析
node text-only/test-client.mjs --ask

# one-shot：握手 + 一次真实执行 + 分页读取
node one-shot/test-client.mjs --run "在当前目录创建 demo.txt 写入 ok 并读回"
```

### 实测记录（2026-10-22，macOS / Apple Silicon）

| 检查 | 结果 |
|---|---|
| `text-only` 拒绝写文件 | ✅ 无任何工具，`/tmp` 目标文件未创建 |
| `text-only` 正常分析 | ✅ 返回结构化结论 |
| `one-shot` 写工作区文件 | ✅ 创建并读回成功 |
| `one-shot` 摘要 + 句柄 | ✅ 摘要 ≤ 900 字符，`dsh_read` 返回 `[0..200/523]` 分页 |
| `one-shot` 失败回传 | ✅ `timeout_sec=1` → `isError: true`，Codex 判断后重试成功 |
| ACP 协议测试 | ✅ 7/7（分帧、信封、超时、反向请求、进程死亡） |
| ACP 真实服务器 | ✅ 1.4s，`ACP_OK`，暴露 `close/list/resume` 与模型档位 |
| ACP 热复用 | ✅ 同目录两次：1.1s → 0.8s，session id 相同，标记 `[warm]` |
| ACP 超时与恢复 | ✅ 1s 超时返回 `isError`，下一次调用自动开新会话成功 |

## warm-session：常驻进程 + 热会话

工具名和返回格式与「现状」完全一致，Codex 侧零配置改动，但内层换成了常驻 ACP：

| | one-shot（headless） | warm-session |
|---|---|---|
| 每次调用 | 新起一个进程，冷启动 2–4s | 复用常驻进程与会话 |
| 多轮 | `--session-id` 冷恢复 | 会话在内存里 |
| 取消 | 杀进程 | `session/cancel` |
| 模型档位 | 固定 | 会话可暴露 `model` / `reasoning_effort` |

实测同一目录连续两次调用：第一次 1.1s、第二次 0.8s 且标记 `[warm]`，会话 id 相同。

## 安全边界

**方案 A** 的安全性来自结构，而不是策略：`profile.patch.yml` 把文件、shell、网页、子代理、技能等工具全部禁用，模型即使想调用也没有工具可调。可以用一条命令验证：

```bash
dsh --patch text-only/profile.patch.yml --profile headless \
  "write hello to /tmp/should-not-exist.txt"
# 预期：模型声明无法执行，文件不存在
```

**现状** 的安全性来自 DSH 的默认沙箱（写操作限制在工作区，工作区外需要审批）。工作区外的请求在 MCP 下没有回传通道，会被拒绝并作为工具错误返回给 Codex。

## 已知限制

- **macOS/Linux 优先**：进程清理用 `detached: true` + `process.kill(-pid)`（POSIX 进程组）。Windows 需要改成 `taskkill /T /F`。
- **DSH 路径自动探测**有限：默认找 macOS 应用包和常见 PATH；其他安装方式请设 `DSH_CLI`。
- **方案 A 不能处理 URL**：它没有 web 工具，需要 Codex 先把内容取回来。
- **现状的权限请求无法转达给 Codex**：MCP 没有反向通道，桥只能拒绝。
- 三个变体都要求 DSH 已登录（`profile.patch.yml` 会重新启用已保存凭据）。

## 环境变量

| 变量 | 变体 | 默认 | 作用 |
|---|---|---|---|
| `DSH_CLI` | 全部 | 自动探测 | `dsh` 启动脚本路径 |
| `DSH_THINK_TIMEOUT_SEC` | A | 300 | 单次分析超时 |
| `DSH_THINK_BUDGET_CHARS` | A | 6000 | 答案上限 |
| `DSH_THINK_CWD` | A | 桥所在目录 | DSH 运行目录（不参与文件操作） |
| `DSH_BRIDGE_TIMEOUT_SEC` | 现状 | 900 | 单次执行默认超时 |
| `DSH_BRIDGE_SUMMARY_CHARS` | 现状 | 900 | 摘要上限 |
| `DSH_BRIDGE_CWD` | 现状 | 进程 cwd | 默认工作目录 |
| `DSH_BRIDGE_PATCH` | 现状 | 启用 | 设为 `0` 可跳过 profile 补丁 |

## License

MIT，见 [LICENSE](LICENSE)。发布前请把版权行改成你自己的名字。
