# Coding Agent 上下文加载机制对比报告

> 对标对象:ZCode / OpenAI Codex CLI / Anthropic Claude Code
> 调研日期:2026-07-23
> 调研方法:一手源码级证据(ZCode rollout JSONL 日志、Codex Rust 源码、Claude Code 拦截 API 请求)

---

## 一、消息序列结构(模型实际看到什么)

### 1.1 ZCode

ZCode 的请求体是 **Anthropic 格式**(`system` 为 block 数组,`tools` 为独立参数)。system prompt 拆分为 **4 个 block**,每个都带 `cache_control: {type: "ephemeral"}`。

**主 Agent 的 system block 布局:**

| # | 内容 | 静态? |
|---|---|---|
| block[0] | `"You are ZCode, an interactive coding agent"` (42 字符) | ✅ 静态 |
| block[1] | `# Harness` section(权限模式、system-reminder 声明、hook 行为、并行引导) | ✅ 静态 |
| block[2] | 行为规则 + `# Session-specific guidance` + `# Environment`(cwd/git/platform/shell/OS/model)+ `# Context management` + **gitStatus 快照** | ⚠️ 半动态(Environment 随会话变) |
| block[3] | (主 Agent 无此 block;子 Agent 有 `<env>` 信封) | — |

**完整消息序列(子 Agent 实测):**

```
messages[0]  system   ← block[0] 镜像:"You are ZCode..."
messages[1]  system   ← block[1] 镜像:Agent 类型身份 + 只读模式规则
messages[2]  system   ← block[2] 镜像:全局行为规则
messages[3]  system   ← block[3] 镜像:<env> 信封(cwd/git/platform/shell/model)
messages[4]  user     ← <system-reminder> currentDate(每次请求动态注入)
messages[5]  user     ← 实际任务(来自 coordinator 或人类)
messages[6]  system   ← Skills 目录("The following skills are available..." 5800 字符)
messages[7+] mixed    ← 对话历史(tool calls + results)
messages[tail] system ← TodoWrite 提醒(条件性追加在最末尾)
```

**AGENTS.md 加载方式:** 作为 `role=user` 消息(全文 + 行号 `cat -n` 格式),**不**在 system block 里。

**关键发现:**
- system block 在 28 轮对话中长度恒定为 `[42, 1975, 811, 324]`——**prefix cache 稳定**
- 压缩(summarization)时 `body.system` 保持完整,`messages` 数组被裁剪为 tail
- `<system-reminder>` 是 harness 在**运行时动态追加**到消息中的(currentDate、TodoWrite 提醒、coordinator 消息)
- Skills 全量列示(name + description + SKILL.md 路径),但 SKILL.md 正文只在 Skill 工具被调用时才读取
- `messagesKind` 有三种模式:`full`(全量重发)、`delta`(只发增量)、`tail`(压缩后裁剪)

---

### 1.2 Codex CLI

Codex 使用 **OpenAI Responses API**。系统提示词作为 `instructions` 字段(developer 角色),`default.md` 通过 `include_str!` **编译时嵌入二进制**。

**消息序列:**

```
instructions (API 顶层字段,= default.md 全文)
  ← 编译时嵌入,会话级稳定(prefix cache 友好)

developer messages (每次请求动态组装):
  [0] developer ← developer_sections 聚合:模型切换指令 + personality + skills + token budget
  [1] developer ← separate_developer_sections(如 guardian policy)
  [2] developer ← multi-agent usage hint(如有)

user messages:
  [3] user ← contextual_user_message 聚合:
         ├ <INSTRUCTIONS> AGENTS.md 全文 </INSTRUCTIONS>
         ├ <environment_context> cwd/shell/date/timezone/network/filesystem </environment_context>
         └ 推荐插件/apps
  [4+] user/assistant ← 对话历史
  [last] user ← 最新用户输入
```

**关键发现:**
- `default.md` 是**编译时常量**(`include_str!("prompts/base_instructions/default.md")`),运行时不可变
- AGENTS.md 实际作为 **user 角色**的 `<INSTRUCTIONS>` fragment 注入(prompt 文本里写"included with the developer message"是遗留措辞,代码实际路由到 user 角色)
- 环境信息(cwd/shell/date)在 `<environment_context>` user fragment 里
- 沙箱/审批策略在 **developer 角色**的 `<permissions instructions>` fragment 里(从 markdown 模板动态渲染,根据 approval_mode 选择 never/untrusted/on_request 模板)
- **world-state diff 渲染**:只有快照变化时才输出 fragment(`render_diff` 返回 None 则跳过),最小化每轮 churn
- `apply_patch` 现代路径是 **Freeform tool**(lark 语法定义),不在 prompt 文本里;遗留路径才拼进 system prompt

**"harness"一词的含义:** Codex CLI 的 Rust agent loop——接收模型输出、执行工具调用、管理沙箱/审批、渲染输出。出现在 prompt 中 2 次:
> "Receive user prompts and other context provided by the **harness**, such as files in the workspace."
> "the **harness** already displays it [plan steps]"

---

### 1.3 Claude Code

Claude Code 使用 **Anthropic Messages API**。`system` 是 block 数组,`tools` 是独立参数。

**API 请求结构(拦截到的真实请求):**

```json
{
  "system": [
    { "type": "text", "text": "You are Claude Code, Anthropic's official CLI for Claude." },
    { "type": "text", "text": "<完整规则 # Doing tasks / # Tool usage policy 等> + Environment 块",
      "cache_control": { "type": "ephemeral", "ttl": "1h", "scope": "global" } }
  ],
  "tools": [
    { "name": "Agent", "description": "...", "input_schema": {...} },
    { "name": "Bash", ... }, { "name": "Edit", ... }, ...
    // ~9 个核心工具有完整 schema
  ],
  "messages": [
    { "role": "user", "content": [
      { "type": "text", "text": "<system-reminder>deferred tool names...</system-reminder>" },
      { "type": "text", "text": "<system-reminder>skill names...</system-reminder>" },
      { "type": "text", "text": "<system-reminder>CLAUDE.md + rules + MEMORY.md + currentDate</system-reminder>" },
      { "type": "text", "text": "用户实际输入" }
    ]},
    ... 对话历史 ...
  ]
}
```

**关键发现:**
- `system` 拆为 2 个 block:block[0] 身份一句话(静态),block[2] 完整规则+环境(带 1h cache breakpoint)
- **CLAUDE.md 不在 system 里**——在 `messages[0]` 的第一个 user 消息内,作为第三个 `<system-reminder>` text block(全文,不摘要)
- **环境信息在 system block[2] 末尾**(cwd/git/platform/shell/OS/model/knowledge cutoff)
- **gitStatus 快照**在 system 末尾(旧版)或 Environment 块内(新版),标注"snapshot in time, will not update"
- **Deferred tools(延迟工具)**:~9 个核心工具有完整 schema;~20+ 个其他工具只列名字在 `<system-reminder>` 里,需要时通过 `ToolSearch` 工具按需获取完整 schema——这是 token 优化的重要设计
- `<system-reminder>` 标签用于注入 CLAUDE.md、currentDate、skills 列表、deferred tools 列表
- prompt 明确声明:"Tool results and user messages may include `<system-reminder>` or other tags. Tags contain information from the system."

**缓存层级**(Anthropic 文档确认):
> "Cache prefixes are created in the following order: `tools`, `system`, then `messages`."

---

## 二、加载机制对比矩阵

| 维度 | ZCode | Codex | Claude Code |
|---|---|---|---|
| **API 格式** | Anthropic(`system` block 数组) | OpenAI Responses(`instructions` 字段) | Anthropic(`system` block 数组) |
| **系统提示词角色** | system(4 blocks) | developer(`instructions`) | system(2 blocks) |
| **系统提示词稳定性** | ✅ 编译时固定(block 长度 28 轮恒定) | ✅ 编译时嵌入(`include_str!`) | ✅ 会话级稳定(1h cache breakpoint) |
| **AGENTS.md 位置** | `messages[N]` user 消息(全文+行号) | `<INSTRUCTIONS>` user fragment(全文,有字节预算截断) | `messages[0]` user 内 `<system-reminder>` block(全文) |
| **AGENTS.md 加载时机** | 会话开始时加载一次 | 会话开始 + CWD→root 链全量拼接 | 会话开始(cwd→root 链);子目录延迟加载 |
| **AGENTS.md 嵌套处理** | 未发现 | root→CWD 链全量拼接;CWD 以下靠模型自己找 | root→cwd 链全量;子目录首次访问时延迟加载 |
| **环境信息位置** | system block(Environment section 或 `<env>` 信封) | `<environment_context>` user fragment | system block 末尾(Environment 块) |
| **环境信息格式** | `# Environment` markdown 列表 / `<env>` XML | `<environment_context><cwd>...</cwd></environment_context>` | `Environment: - Primary working directory: ...` |
| **gitStatus** | system block 内(快照,标注不更新) | 未在已发布 prompt 中(可能在 environment_context) | system 末尾(快照,标注不更新) |
| **工具描述位置** | `tools` API 参数(独立于 messages) | `tools` API 参数(Freeform tool 用 grammar) | `tools` API 参数(~9 核心 + deferred) |
| **延迟加载(渐进披露)** | Skills 全量列示但正文延迟;工具无延迟 | 无(AGENTS.md 全量) | ✅ Deferred tools(名字→ToolSearch→schema) |
| **`<system-reminder>` 机制** | ✅ harness 动态注入(currentDate/TodoWrite) | ❌ 无此标签 | ✅ 注入 CLAUDE.md/currentDate/skills |
| **harness 概念** | ✅ `# Harness` section 明确定义 | ✅ prompt 中 2 次使用 | ❌ 不使用此词 |
| **prefix cache 策略** | ✅ system blocks 全带 `cache_control:ephemeral`;messages 用 `messagesKind`(full/delta/tail)优化 | ✅ `instructions` 字段会话级稳定;world-state diff 渲染最小化 churn | ✅ system block 2 带 `cache_control:1h global`;缓存顺序 tools→system→messages |
| **沙箱/审批** | "permission mode"(Harness section) | `<permissions instructions>` developer fragment(按 approval_mode 选模板) | "Executing actions with care"(system section) |

---

## 三、三方共同模式(行业共识)

1. **系统提示词与项目指令分离**:三方都不把 AGENTS.md/CLAUDE.md 放进 system/developer prompt,而是作为 user 消息注入。只有基础规则(身份/行为/格式)在 system 层。

2. **prefix cache 友好**:三家都追求 system prompt 的字节级稳定——ZCode 用编译时固定 + cache_control,Codex 用 `include_str!` + instructions 字段,Claude Code 用 1h cache breakpoint。动态内容环境信息/AGENTS.md 都放在 user 层。

3. **`<system-reminder>` / harness 注入标签**:ZCode 和 Claude Code 都用 `<system-reminder>` 标签注入运行时动态信息(currentDate、TodoWrite 提醒、skills 列表)。Codex 用 `<environment_context>` / `<INSTRUCTIONS>` 等 XML fragment 标签。三家的模型都被明确告知这些标签"不是用户输入"。

4. **工具定义在 API 参数层**:三家都把工具 schema 放在 API 的 `tools` 参数中,不在 prompt 文本里。

5. **环境信息块**:三家都在 system 或 user 层注入 cwd/platform/shell/date/model 等环境字段。格式各异但内容相似。

---

## 四、三方差异点

| 差异 | ZCode | Codex | Claude Code |
|---|---|---|---|
| **AGENTS.md 行号** | ✅ 带 `cat -n` 行号 | ❌ 纯文本 | ❌ 纯文本 |
| **Deferred tools** | ❌ 全量 | ❌ 全量 | ✅ 核心9个+其余延迟 |
| **world-state diff** | ❌ | ✅ 只输出变化部分 | ❌ |
| **沙箱模板系统** | ❌ | ✅ 按 approval_mode 选 never/untrusted/on_request 模板 | ❌ |
| **messagesKind 优化** | ✅ full/delta/tail 三模式 | ❌ | ❌ |
| **harness 显式声明** | ✅ `# Harness` section | ✅ 2 次提及 | ❌ |
| **TodoWrite 提醒** | ✅ 条件性追加到末尾 | ❌ | ✅ 任务完成门 |
| **环境信封标签** | `<env>` (子Agent) | `<environment_context>` | 无标签(直接在 system) |

---

## 五、来源

### ZCode
- `C:\Users\27169\.zcode\cli\rollout\model-io-*.jsonl` — 每次模型请求的完整 payload(ground truth)
- `C:\Users\27169\.zcode\cli\agents\*\transcript.jsonl` — 事件流
- 主会话 `sess_e8e6b5d3` + 3 个子 Agent session 的 rollout 记录

### Codex
- https://github.com/openai/codex `main` 分支 Rust 源码
- `codex-rs/protocol/src/prompts/base_instructions/default.md` — 基础 prompt(编译时嵌入)
- `codex-rs/core/src/client.rs:837-862` — `instructions` vs `tools` 分离
- `codex-rs/core/src/agents_md.rs` — AGENTS.md 加载逻辑
- `codex-rs/core/src/context/user_instructions.rs` — AGENTS.md 作为 user fragment
- `codex-rs/core/src/context/world_state/environment.rs` — `<environment_context>` user fragment
- `codex-rs/prompts/src/permissions_instructions.rs` — 沙箱/审批模板

### Claude Code
- https://gist.github.com/wong2/e0f34aac66caf890a332f7b6f9e2ba8f — 系统提示词 + 工具 schema(2025-06,Sonnet 4)
- https://justacuriousengineer.substack.com/p/breaking-down-claude-codes-prompt — 拦截到的真实 API 请求(2026-03,Sonnet 4.6)
- https://platform.claude.com/docs/en/agents-and-tools/tool-use/define-tools — 工具定义官方文档
- https://platform.claude.com/docs/en/build-with-claude/prompt-caching — prefix cache 官方文档
- https://docs.claude.com/en/docs/claude-code/memory — CLAUDE.md 加载机制
