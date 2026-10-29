# Codex ↔ DeepSeek Harness bridges

Three MCP bridges that let **Codex keep the decision-making** and hand work to
**DeepSeek Harness (DSH)**. They differ in one axis each: capability
(`text-only`), process lifetime (`one-shot`), and persistent ACP sessions
(`warm-session`).

| Variant | Role (2026-10-27) | Tool surface | DSH capabilities | Permission requests |
|---|---|---|---|---|
| [`warm-session`](warm-session/) | **primary** | `dsh_run`, `dsh_continue`, `dsh_read`, `dsh_tasks` | files, shell, web — persistent ACP sessions bound to `task_id` | answered inside the client, fail-closed |
| [`one-shot`](one-shot/) | fallback | `dsh_run`, `dsh_continue`, `dsh_read` | files, shell, web, subagents — fresh process per call | possible outside the workspace |
| [`text-only`](text-only/) | **decision pending** (not removed) | `dsh_think` | **none** — text in, text out | impossible by construction |

All three are dependency-free Node MCP servers speaking newline-delimited
JSON-RPC 2.0 over stdio, written around one rule: **the caller's context is the
scarce resource**, so every reply is a bounded summary and full transcripts are
stored out of band.

| Name | The defining property |
|---|---|
| `text-only` | DSH has **no tools** — the only capability axis |
| `one-shot` | Every call spawns a **fresh process**; no task binding |
| `warm-session` | One persistent ACP process; **one session per task_id**, resumable after a bridge restart |

---

# 中文说明

## 这是什么

三个 MCP 桥，方向都是「Codex 决策 / DSH 执行」：

- **`warm-session`（主入口，2026-10-27 起）**：常驻 ACP 进程；会话按 `task_id` 显式绑定并持久化，同一目标继续原会话、不同目标默认新建；支持 `session/resume`、统一超时预算、单请求取消、流式完整落盘、MCP 进度通知和调用级日志。
- **`one-shot`（备用）**：DSH 保留完整工具（文件、shell、网页、子代理），每次调用新起进程，用 `session_id` 续接；保留为 ACP 桥不可用或需要全新进程时的 fallback。
- **`text-only`（是否默认禁用待单独决定）**：DSH 没有任何工具，只能读你粘贴给它的文字。本轮不因使用少而删除。

三个桥对 Codex 的接入方式一样：在 `~/.codex/config.toml` 里加 `[mcp_servers.*]`。

## 2026-10-27 修订摘要

依据 `docs/REVISION-2026-10-27.md`：

1. **会话复用**：取消按工作目录自动复用；`dsh_run` 不带 `task_id` = 新目标；同一 `task_id` 继续原会话；历史过长（usage 比例 ≥ 0.7）自动新建会话并带简短 `[handoff]` 摘要。
2. **检索成本**：`state/tasks.json` 保存目标、项目、会话、状态、短摘要；按 `task_id` 直查；`dsh_tasks` 最多返回少量候选，不返回全文。
3. **侧栏/恢复**：不新增 UI；接入 ACP `session/resume`，桥重启后可用 `task_id` 恢复；也接受 DSH 侧栏里已有的 `session_id`。
4. **减少往返**：摘要默认 900 → **1500** 字符；摘要优先改动/验证/未解决；完整输出改为流式落盘，`dsh_read` 可恢复全文（旧版缓冲溢出后落盘也被截断）。
5. **执行控制**：启动、建会话、排队、执行共享一个 deadline（默认 900s，上限 3300s，低于宿主 3600s）；排队请求可单独取消，不会误伤运行中的请求；仅对提示开始前的可恢复传输故障自动重试一次；权限保持 fail-closed。
6. **可观测性**：ACP `session/update` → MCP `notifications/progress`（宿主带 progressToken 时）；`logs/calls.jsonl` 记录桥内耗时与各阶段，调用端耗时由外部对照脚本 join（`test/compare-latency.mjs`）；无提速承诺。
7. **工具入口**：`warm-session` 主入口，`one-shot` 备用，`text-only` 单独决定。

## 目录

```
dsh-bridge-variants/
├── docs/REVISION-2026-10-27.md   # 本轮修订说明、设计决定、测试与待办
├── text-only/                    # 无工具；默认禁用与否待决定
│   ├── bridge.mjs
│   ├── profile.patch.yml
│   └── test-client.mjs
├── one-shot/                     # 备用：每次调用新进程
│   ├── bridge.mjs                # dsh_run / dsh_continue / dsh_read
│   ├── profile.patch.yml
│   └── test-client.mjs
└── warm-session/                 # 主入口：常驻 ACP + task_id 绑定
    ├── bridge.mjs                # MCP server + task 绑定 + deadline + progress + 日志
    ├── lib/deadline.mjs          # 单次调用统一预算
    ├── lib/registry.mjs          # task_id -> session 持久化绑定
    ├── lib/results.mjs           # 流式完整输出 + 分页读取
    ├── lib/acp.mjs               # 帧、信封校验、超时、反向请求
    ├── lib/policy.mjs            # 权限应答（fail-closed）
    ├── lib/session.mjs           # 会话池 + 队列/取消 + resume + 更新投影
    └── test/                     # 离线协议、MCP 端到端、对照；真实 DSH 测试默认 gated
```

## 共同设计原则：Token 预算

主目标是**把 Codex 的上下文留给决策，而不是读日志**：

| 规则 | 实现 |
|---|---|
| 只回摘要 | `text-only`：6000 字符；`one-shot` / `warm-session`：默认 1500 字符 |
| 全文不塞上下文 | `one-shot` / `warm-session` 落盘到 `results/<handle>.md`，用 `dsh_read` 分页取；warm 侧流式写入，完整可恢复 |
| 失败紧凑 | 分类错误 + 证据 + 部分输出句柄 |
| 不轮询 | 同步阻塞一次，不做 `dsh_wait` |
| 工具定义精简 | 主入口 4 个工具；备用 3 个；text-only 1 个 |

判断标准：**这段文字能不能帮 Codex 做下一个决定？不能就别放进去。**

## 安装

先确认 DSH 的 CLI 路径（macOS 默认在应用包里）：

```bash
ls "/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh"
```

### warm-session（主入口）

```toml
[mcp_servers.dsh_warm_session]
command = "node"
args = ["/绝对路径/dsh-bridge-variants/warm-session/bridge.mjs"]
startup_timeout_sec = 60
tool_timeout_sec = 3600
env = { DSH_BRIDGE_CWD = "/你的工作区" }
```

可选 env：`DSH_BRIDGE_STATE_DIR` / `DSH_BRIDGE_RESULTS_DIR` / `DSH_BRIDGE_LOG_DIR`
（默认都在 `warm-session/` 下的 `state/`、`results/`、`logs/`）。

### one-shot（备用）

```toml
[mcp_servers.dsh_one_shot]
command = "node"
args = ["/绝对路径/dsh-bridge-variants/one-shot/bridge.mjs"]
startup_timeout_sec = 60
tool_timeout_sec = 3600
env = { DSH_BRIDGE_CWD = "/你的工作区" }
```

### text-only（默认禁用与否待决定）

```toml
[mcp_servers.dsh_text_only]
command = "node"
args = ["/绝对路径/dsh-bridge-variants/text-only/bridge.mjs"]
```

> 如果你的环境里没有独立 `node`（例如只装了 DSH 应用），可以把 `command` 换成
> DSH 自带的 Electron 运行时，并加 `ELECTRON_RUN_AS_NODE=1`：
>
> ```toml
> command = "/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness"
> env = { ELECTRON_RUN_AS_NODE = "1" }
> ```

改完配置需要**重启 Codex**，并**新开一个对话**（MCP 工具面按会话绑定，旧会话不会热加）。
本轮升级后必须重启，旧 MCP 进程仍持有旧代码。

## 验证

```bash
# warm-session：离线（零 token、零 DSH 调用）
node warm-session/test/run-tests.mjs         # 协议/池/注册表，15 项
node warm-session/test/bridge-tests.mjs      # MCP 端到端，14 项
node warm-session/test/compare-latency.mjs   # 调用端 vs 桥内耗时对照

# 真实 DSH（当前轮 DSH 调用暂停，默认不执行）：
DSH_ALLOW_REAL=1 node warm-session/test/real-smoke.mjs
DSH_ALLOW_REAL=1 node warm-session/test/verify-bridge.mjs

# 备用/纯文本桥（真实调用；DSH 暂停期间不要运行）
node one-shot/test-client.mjs --run "..."
node text-only/test-client.mjs --ask
```

### 实测记录

| 时间 | 检查 | 结果 |
|---|---|---|
| 2026-10-22 | ACP 协议/真实冒烟/热复用/超时恢复 | ✅（见旧版记录与 `docs/performance.md`） |
| 2026-10-27 | warm-session 离线单元测试 | ✅ 15/15 |
| 2026-10-27 | warm-session MCP 端到端（fake ACP） | ✅ 14/14 |
| 2026-10-27 | 对照脚本（fake ACP） | ✅ 桥内/调用端 join 一致 |
| 2026-10-27 | 真实 DSH resume / progress / cancel | ⏸ 本轮 DSH 调用暂停，未运行 |

## warm-session：task 绑定语义（替换旧的「按目录复用」）

| 场景 | 行为 |
|---|---|
| `dsh_run` 不带 `task_id` | 新 task_id + 新会话；同目录**不会**自动复用 |
| `dsh_run` 带已有 `task_id` | 继续绑定会话（`[reused]`；桥重启后 `[resumed]`） |
| `dsh_continue(task_id)` | 同一目标的实现/测试/修复后续（首选） |
| `dsh_continue(session_id)` | 显式接续某个会话（如 DSH 侧栏里的 id） |
| 不同目标 | 新的 `dsh_run`（不带 task_id）；task_id 跨项目会被拒绝 |
| `fresh: true` | 同一目标显式重开会话 |
| 历史过长 | 自动新会话 + `[handoff]`（目标/上一会话/进展摘要/项目） |

## 安全边界

**text-only** 的安全性来自结构，而不是策略：`profile.patch.yml` 把文件、shell、网页、子代理、技能等工具全部禁用，模型即使想调用也没有工具可调。

**warm-session / one-shot** 的安全性来自 DSH 的默认沙箱（写操作限制在工作区，工作区外需要审批）。工作区外的请求在 MCP 下没有回传通道，会被拒绝并作为工具错误返回给 Codex。

## 已知限制 / 待办

- **真实 DSH 验证未做**：本轮所有 DSH 调用暂停；`session/resume`、真实进度通知、真实取消、摘要长度 A/B 需要后续在授权后验证。
- **摘要 1500 是配置依据而非实测结论**：离线对照只能验证测量方法；不承诺提速比例。
- **权限请求无法转达给 Codex**：MCP 无反向通道，桥保持 fail-closed。
- **text-only 默认禁用与否**单独决定，未在本轮修改。
- **macOS/Linux 优先**：进程清理用 `detached: true` + `process.kill(-pid)`；Windows 需要 `taskkill /T /F`。
- **DSH 路径自动探测**有限：默认找 macOS 应用包和常见 PATH；其他安装方式请设 `DSH_CLI`。
- 桥的 `state/`、`logs/`、`results/` 默认在包内，已加入 `.gitignore`；运行时若目录不可写，用 env 指到可写位置。

## 环境变量（warm-session 为主）

| 变量 | 默认 | 作用 |
|---|---|---|
| `DSH_CLI` | 自动探测 | `dsh` 启动脚本路径 |
| `DSH_BRIDGE_CWD` | 进程 cwd | 默认项目目录 |
| `DSH_BRIDGE_TIMEOUT_SEC` | 900 | 单次调用默认预算 |
| `DSH_BRIDGE_MAX_TIMEOUT_SEC` | 3300 | `timeout_sec` 上限 |
| `DSH_BRIDGE_SUMMARY_CHARS` | 1500 | 摘要上限（全文始终落盘） |
| `DSH_BRIDGE_HANDOFF_RATIO` | 0.7 | 触发 handoff 的上下文使用比例 |
| `DSH_BRIDGE_STARTUP_TIMEOUT_MS` | 30000 | ACP 启动预算 |
| `DSH_BRIDGE_STATE_DIR` | `<warm-session>/state` | `tasks.json` |
| `DSH_BRIDGE_RESULTS_DIR` | `<warm-session>/results` | 完整输出 |
| `DSH_BRIDGE_LOG_DIR` | `<warm-session>/logs` | `calls.jsonl` |
| `DSH_THINK_*` | 见 text-only | 纯文本桥参数 |
| `DSH_BRIDGE_PATCH` | 启用（one-shot） | 设为 `0` 跳过 profile 补丁 |

## License

MIT，见 [LICENSE](LICENSE)。发布前请把版权行改成你自己的名字。
