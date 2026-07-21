# DeepSeeker CodeAgent 工具清单与缺口分析

> 对标对象:Claude Code / OpenAI Codex / Cursor
> 基线版本:DeepSeeker CodeAgent v0.1.0(14 个已注册工具)
> 编写日期:2026-07-20

---

## 一、项目现状概览

### 1.1 已注册的 14 个工具

| 类别 | 工具 | 用途 |
|---|---|---|
| 文件系统 | `list_files` `read_file` `write_file` `edit_file` `delete_file` | 项目内文件增删改查 |
| Shell 执行 | `run_command` | 本地命令执行(走 `/bin/zsh -lc`) |
| Git | `git_status` | 工作区状态 + diff 摘要 |
| 记忆 | `search_memory` | 关键词检索已确认的 MemoryFact |
| 能力扩展 | `search_capabilities` `invoke_capability` | Skills/MCP 渐进式披露 |
| Plan 模式 | `enter_plan` `ask_user` `submit_plan` | 计划制定、澄清、提交 |
| 任务管理 | `update_tasks` | 执行期任务清单 |

### 1.2 已经领先的能力(无需补)

- **Plan Mode**:Runtime 强制 + 版本化 + 与 Task 分离,比 Cursor/Codex 都彻底
- **Context OS**:前缀缓存友好布局 + 双阶段压缩 + 恢复胶囊
- **命令静态分类器**(`analyzeCommand`):细粒度识别只读/破坏/网络/校验
- **路径级 Guidance 渐进披露**:类 AGENTS.md/Claude Code 的规则按需注入

---

## 二、Tier 1 —— 核心缺口(高优先级)

### #1 Grep —— 内容搜索工具

**用法**
```
grep(query="TODO", glob="**/*.ts", output_mode="content", -n=true, max_results=100)
```
返回结构化的 `file:line: matched-line` 三元组数组。支持正则、文件类型过滤、上下文行(`-A/-B/-C`)。

**为什么需要这个工具**
当前模型要找代码只能调 `run_command` 跑 `rg`,输出是纯字符串,无法被 Runtime 结构化处理,也绕过了已有的敏感路径过滤(`isSensitivePath`)和证据脱敏(`redactSensitiveText`)。

**好处与解决的问题**
- ✅ 解决:模型频繁调用 shell 造成的审批噪音 + 输出截断混乱
- ✅ 解决:`rg` 输出里可能漏出 `.env` 行等敏感信息
- ✅ 解决:无法把搜索结果标准化喂给 Evidence Store
- ✅ 好处:模型能精准定位代码、减少上下文消耗、提升一次命中概率

**实现机制(三句话)**
1. 在 `server/infra/tools.ts` 新增 `grep` 工具,内部复用 Node 的 `child_process` 调用 `rg --json`,解析其机器可读输出。
2. 对每个命中路径先过 `ensureInsideRoot` + `isSensitivePath`,再走 `redactSensitiveText` 脱敏。
3. 把结果包成 `ToolResult`,走标准 `toolPipeline` 流程并写入 Evidence Store(大输出走 `reduceToolEvidence` 截断)。

---

### #2 Glob —— 文件名匹配工具

**用法**
```
glob(pattern="src/components/**/*.tsx", limit=200)
```
返回匹配路径列表,支持 `minimatch` 语法(你项目已经依赖)。

**为什么需要这个工具**
当前 `list_files` 只能给扁平化的文件树,模型问"所有 reducer 文件在哪"时只能全量列再人工筛,既耗 token 又不准。Claude Code / Codex / Cursor 都把 Glob 作为一等公民。

**好处与解决的问题**
- ✅ 解决:在大型 monorepo 中"按模式找文件"的高频需求
- ✅ 解决:`list_files` 的 `maxFiles=200` 上限在大项目里被截断的问题
- ✅ 好处:与 Grep 配合形成"找文件 → 看内容"的标准动作链

**实现机制(三句话)**
1. 新增 `glob` 工具,基于已有的 `minimatch` 依赖,从 `projectRoot` 递归扫描。
2. 复用 `list_files` 里的 `IGNORED_DIRECTORIES` 跳过 `node_modules`、`dist` 等。
3. 返回结构化路径数组,排序后截断到 `limit`,可附带 `size`/`mtime` 元数据。

---

### #3 WebSearch —— 联网搜索工具

**用法**
```
web_search(query="DeepSeek V4 function calling spec", allowed_domains=["api-doc.deepseek.com"], limit=5)
```
返回 `{title, url, snippet}[]`。

**为什么需要这个工具**
模型知识有截止日期,遇到新 SDK、新报错、新 API 规范时只能靠猜。当前 `run_command` 里 `curl` 虽能抓网页,但被分类为 `network_access` 需要审批,且返回的 HTML 模型难解析。Cursor 和 Codex 都内置了 WebSearch。

**好处与解决的问题**
- ✅ 解决:模型在"未知领域"产生幻觉的问题(文档版本、API 签名)
- ✅ 解决:用户被迫自己查文档再粘贴给 agent 的割裂体验
- ✅ 好处:让 agent 在版本升级、错误排查、新依赖选型场景真正可用

**实现机制(三句话)**
1. 新增 `web_search` 工具,后端接第三方搜索 API(Bing Web Search / Brave Search / SerpAPI),key 走环境变量注入。
2. 结果只保留 `title + url + snippet`,过滤掉黑名单域名,默认走 `network_access` 审批门(首次 allow_run 后续免打扰)。
3. 命中页面 URL 可作为 `fetch_url` 工具的输入,形成搜索→精读的工作流。

---

### #4 WebFetch / fetch_url —— 网页抓取工具

**用法**
```
fetch_url(url="https://api-doc.deepseek.com/guides/function_calling", format="markdown", max_chars=20000)
```
返回转换后的 Markdown 正文 + 提取的链接列表。

**为什么需要这个工具**
WebSearch 只给摘要,要看正文还得抓。模型用 `curl` 抓回来的 HTML 几十 KB 且充满 `<script>`,塞进上下文立刻撑爆预算。Claude Code 的 WebFetch 和 Cursor 的 `@web` 都做了 HTML→Markdown 的转换。

**好处与解决的问题**
- ✅ 解决:HTML 噪声污染上下文(脚本、样式、广告)
- ✅ 解决:大文档一次性塞入导致 token 爆炸
- ✅ 好处:让 agent 能真正"读懂文档",配合 WebSearch 形成完整的信息检索闭环

**实现机制(三句话)**
1. 新增 `fetch_url` 工具,服务端用 `node-fetch` 拉取,经 `turndown` 或 `readability` 转成 Markdown。
2. 走 `robots.txt` 检查 + 同域名限速,长度超 `max_chars` 自动截断并附"已截断"提示。
3. 结果过 `redactSensitiveText`,再走 Evidence Store(大文档只保留摘要,完整内容存 artifacts)。

---

### #5 Task / 子 Agent —— 任务委派工具

**用法**
```
spawn_agent(
  description="查找所有未捕获的 Promise rejection",
  prompt="扫描 src/ 下所有 .ts 文件,找出 .then() 链没有 .catch() 的位置,报告文件:行号",
  subagent_type="Explore",   // 或 general-purpose
  run_in_background=false
)
```
返回子 Agent 的最终摘要(不返回中间过程)。

**为什么需要这个工具**
这是 Claude Code 区别于其他 agent 的核心武器。复杂任务往往需要并行探索多个无关方向(例如"同时查测试模式 + 查路由结构 + 查数据库 schema"),单 Agent 串行做既慢又容易把无关上下文混在一起污染主对话。你的 `Runner` 已经高度模块化,几乎是"再加一个入口"的工作量。

**好处与解决的问题**
- ✅ 解决:主对话上下文被探索性搜索结果撑爆的问题(子 Agent 的中间过程不进主上下文)
- ✅ 解决:多方向任务必须串行执行的延迟问题(支持并行 fan-out)
- ✅ 解决:不同任务需要不同工具子集的隔离需求(Explore 只读、general-purpose 全能)
- ✅ 好处:大幅扩展可处理任务的复杂度上限

**实现机制(三句话)**
1. 新增 `spawn_agent` 工具,内部创建一个隔离子 `Run`(复用现有 `Runner`),传独立的 sessionId + 子工具白名单(如 Explore 只给 read/grep/glob)。
2. 子 Run 跑完后只把最终摘要作为 ToolResult 返回父 Run,中间 Event 不写入父 Session。
3. 同一消息里多个 `spawn_agent` 调用通过 `Promise.all` 并行执行,支持 `run_in_background` 走 RunRegistry 的 detached 通道。

---

### #6 save_memory —— 记忆写入工具

**用法**
```
save_memory(
  statement="用户项目使用 pnpm 而非 npm",
  category="preference",
  visibility="project",
  confidence=0.95
)
```

**为什么需要这个工具**
当前 `MemoryStore` 的 `save`/`delete` 只能通过 HTTP API 由用户手动写入,模型只读不写。结果是用户每次开新会话都要重新交代"用 pnpm""测试跑 vitest""别动 src/legacy"。Claude Code 和 Cursor 都会让模型自动沉淀关键事实。

**好处与解决的问题**
- ✅ 解决:跨会话的事实丢失问题(每次重新自我介绍)
- ✅ 解决:用户重复交代项目偏好的体验割裂
- ✅ 好处:让 agent 真正"记住"用户与项目,提升长期使用粘性

**实现机制(三句话)**
1. 新增 `save_memory` 工具,内部调 `MemoryStore.save`,保留你已有的"凭据检测拦截"(`sk-...`、`api_key=` 一律拒绝)。
2. visibility 区分 `personal`(跨项目)和 `project`(绑定 projectRoot),高置信度事实自动进下次会话的 `<memory_index>`。
3. 可选:加一道"用户确认"环节(类似 Plan Mode 的 ask_user),让用户审核后再入库,符合你 ADR 003 "反对无限制自由记忆"的设计原则。

---

## 三、Tier 2 —— 生态与扩展(中优先级)

### #7 MCP Server 真正接入

**用法**
```
invoke_capability(capabilityId="mcp:github:create_pr", arguments={title, body, head})
```
或者更直接:配置文件声明 MCP server 后,其工具自动出现在 `search_capabilities` 的索引里。

**为什么需要这个工具**
你的 `server/infra/capabilities.ts` 已经留好了 `registerDeferredCapabilityProvider` 这个口子,但**整个代码库从来没有人调用过它**——MCP 是脚手架,不是功能。MCP 是 2024 年后 agent 生态的事实标准,接上等于一夜之间获得 GitHub、Slack、Postgres、Playwright 等数百个工具的接入能力。

**好处与解决的问题**
- ✅ 解决:每个外部集成都要从零写工具胶水代码的重复劳动
- ✅ 解决:agent 能力边界的扩展依赖核心团队的问题
- ✅ 好处:借力 MCP 生态,把 DeepSeeker 从"编码助手"扩展到"通用任务平台"

**实现机制(三句话)**
1. 在 `server/infra/capabilities.ts` 实现一个 `McpCapabilityProvider`,用 `@modelcontextprotocol/sdk` 启动子进程或连 stdio/SSE server。
2. 把 MCP server 暴露的 tools 转成 `Capability` 元数据写入索引,`invoke_capability` 时按 `capabilityId` 路由到对应 server 调用。
3. 配置文件(`~/.deepseeker/mcp.json` 或项目级 `.deepseeker/mcp.json`)声明 server 列表,启动时按需加载(走你已有的渐进披露)。

---

### #8 Slash Commands —— 用户自定义命令

**用法**
用户在 Composer 输入 `/review-pr`,系统自动展开成预置的 prompt 模板:
```
请审查当前 git diff,重点关注:1) 安全问题 2) 性能回归 3) 测试覆盖
```
支持参数:`/review-pr --focus=security`。

**为什么需要这个工具**
当前所有交互都是自由文本,用户重复输入"审查代码""写测试""重构这块"等高频指令既低效又难保证一致性。Claude Code 的 `/command` 系统让用户把工作流固化成可分享的命令,是社区生态的入口。

**好处与解决的问题**
- ✅ 解决:高频重复 prompt 的输入成本与一致性
- ✅ 解决:团队/社区分享最佳实践的载体缺失
- ✅ 好处:用户粘性 + 可发现性 + 可分享性三重提升

**实现机制(三句话)**
1. 在 `desktop/preload.ts` 或 Runtime 加一层命令解析器,识别输入首个 token 是否以 `/` 开头。
2. 命令定义放在 `~/.deepseeker/commands/*.md` 和 `<root>/.deepseeker/commands/*.md`,YAML frontmatter 声明参数,正文是 prompt 模板(支持 `$ARGUMENTS` `$1` 占位符)。
3. 命中后把渲染好的 prompt 作为用户消息提交,无需改动 Runner 核心。

---

### #9 Hooks 系统 —— 工具前后置钩子

**用法**
用户配置:
```yaml
# .deepseeker/hooks.yaml
- event: PreToolUse
  matcher: "run_command"
  script: ./hooks/audit-log.sh     # 记录所有 shell 调用
- event: PostToolUse
  matcher: "write_file|edit_file"
  script: ./hooks/format.sh        # 写完自动 prettier
```

**为什么需要这个工具**
当前所有副作用都走 `toolPipeline.ts` 的固定流程,企业/团队场景无法定制(如强制审计、自动 lint、敏感目录二次确认)。Claude Code 的 PreToolUse/PostToolUse hook 是其企业落地的关键能力。你的 ADR 005 Stage 6 已经把这个列为待办。

**好处与解决的问题**
- ✅ 解决:团队合规需求(强制审计、阻断危险操作)
- ✅ 解决:工具调用后自动副作用(格式化、刷新索引、通知)
- ✅ 好处:把"硬编码的策略"变成"可配置的策略",降低定制开发成本

**实现机制(三句话)**
1. 在 `server/app/toolPipeline.ts` 的 checkpoint 前后插入两个 hook 触发点,把 `toolName + args + targetPath` 传给已注册的 hook 列表。
2. Hook 执行器支持 `shell script`(子进程)和 `inline JS` 两种,返回 `{decision: "allow"|"block"|"modify", reason}` 控制流程。
3. 配置从 `.deepseeker/hooks.yaml` 加载,与 Guidance 同源,失败 hook 默认 block + 告警。

---

### #10 多模态 / 图像输入

**用法**
用户在 Composer 粘贴/拖入一张 UI 截图,附文字"按这个设计实现登录页"。模型看到图像后生成对应代码。

**为什么需要这个工具**
当前 `shared/contracts/provider.ts` 的 `ModelMessage` 只有 `text` 字段,**这是多模态能力的根本瓶颈**。前端设计稿复刻、报错截图分析、白板流程图转代码等场景全部无法支持,而 Claude Code、Cursor、Codex 都已支持。⚠️ 建议在做其他多模态扩展前先升级这个契约。

**好处与解决的问题**
- ✅ 解决:"看图写代码"这个高频需求完全无法满足
- ✅ 解决:复杂报错/堆栈截图无法直接喂给模型
- ✅ 好处:打开一整类全新的使用场景(UI 复刻、视觉调试、文档 OCR)

**实现机制(三句话)**
1. 升级 `shared/contracts/provider.ts` 的 `ModelMessage` 从 `string` 改为 `string | ContentPart[]`,其中 `ContentPart` 含 `{type:"text"|"image_url", ...}`。
2. 在 `DeepSeekProvider` 里把 image part 转成 `{type:"image_url", image_url:{url: "data:image/...;base64,..."}}`,符合 OpenAI 兼容协议。
3. 前端 `src/components/Composer.tsx` 加文件粘贴/拖拽处理,大图先压缩到 1024px 以内再 base64 编码。

---

### #11 MultiEdit —— 批量原子编辑

**用法**
```
multi_edit(
  path="src/App.tsx",
  edits=[
    {oldText:"const foo = 1;", newText:"const foo = 2;"},
    {oldText:"return null;", newText:"return <App/>;"},
    {oldText:"import A", newText:"import A, {B}"}
  ]
)
```
所有替换在一次写操作内原子完成。

**为什么需要这个工具**
重构一个文件常需要改 5-10 处,目前模型只能串行调 5-10 次 `edit_file`,每次都走完整的 checkpoint + 审批 + 事件记录,既慢又容易在中间失败导致文件半改状态。Claude Code 的 MultiEdit 和 Cursor Composer 都支持批量编辑。

**好处与解决的问题**
- ✅ 解决:多次串行 `edit_file` 导致的延迟和半成品风险
- ✅ 解决:相关变更被拆成多个 commit/diff 的可读性问题
- ✅ 好处:大幅提升重构场景的效率与一致性

**实现机制(三句话)**
1. 新增 `multi_edit` 工具,接受 `path + edits[]`,内部依次应用所有 `oldText→newText` 替换到内存中的文件内容。
2. 任意一处 `oldText` 不匹配则整批回滚(读原始内容丢弃),返回详细错误清单。
3. 全部成功后只写一次磁盘,走单次 checkpoint + 单个 `changes.changed` 事件。

---

### #12 后台任务执行

**用法**
```
run_command(command="npm run build", run_in_background=true)
-> 返回 task_id
... 用户继续对话 ...
query_task(task_id="tsk_abc")  -> 返回 stdout/stderr/exitCode
```

**为什么需要这个工具**
当前 `run_command` 是阻塞的(120s 超时),且每个 Session 同一时刻只允许一个 Run(`http.ts:359` 拒绝并发 Run)。跑 `npm run dev`、长测试套件、大型构建时,模型和用户都得干等。Claude Code 的 `run_in_background` 和 Cursor 的 Background tasks 都解决了这个。

**好处与解决的问题**
- ✅ 解决:长任务阻塞主对话的问题
- ✅ 解决:`run_command` 的 120s 超时对构建/测试不够用
- ✅ 好处:让 agent 能并行处理"启动 dev server + 继续写代码"这类场景

**实现机制(三句话)**
1. `run_command` 加 `run_in_background` 参数,内部用 `spawn(..., {detached:true})` 启动,把 PID + stdout/stderr 流注册到 `RunRegistry` 的 detached 池。
2. 立即返回 `task_id`,模型可用 `query_task` 工具轮询状态或读取增量输出。
3. 任务退出时通过现有 `store.publish` 机制推一个 `task.finished` 事件,前端 ActivityView 显示通知。

---

## 四、Tier 3 —— 高级/差异化(低优先级,可选)

### #13 Browser 自动化(Playwright)

**用法**
```
browser_navigate(url="http://localhost:3000")
browser_screenshot(full_page=true)
browser_click(selector="#submit-btn")
browser_expect(selector=".error", text="Invalid")
```

**为什么需要这个工具**
前端开发场景下,agent 写完代码后需要"看一眼效果"。目前只能靠用户人工截图反馈。Cursor 内置了 Browser,Claude Code 通过 MCP 接入 Playwright。你 `accessPolicy.ts` 的白名单里已经出现了 `playwright`,说明已预见此需求。

**好处与解决的问题**
- ✅ 解决:前端调试闭环的"最后一公里"(代码→效果→修正)
- ✅ 解决:E2E 测试用例的自动编写与执行
- ✅ 好处:把 agent 在前端场景的能力从"能写代码"提升到"能验证代码"

**实现机制(三句话)**
1. 通过 MCP 接入官方 `@playwright/mcp` server(复用 #7 的 MCP 桥接)。
2. 浏览器实例与 Session 绑定,生命周期跟随 Session 销毁清理。
3. 截图结果转 base64 走多模态契约(依赖 #10)回喂模型,或存 Evidence Store 后只回摘要。

---

### #14 NotebookEdit —— Jupyter 单元格编辑

**用法**
```
notebook_edit(
  path="analysis.ipynb",
  cell_id="cell-3",
  edit_mode="replace",
  new_source="import pandas as pd\ndf = pd.read_csv(...)"
)
```

**为什么需要这个工具**
数据科学、ML 场景大量用 `.ipynb`,而 `edit_file` 直接改 JSON 会破坏 cell 结构、丢失输出元数据。Claude Code 有专门的 NotebookEdit 工具。

**好处与解决的问题**
- ✅ 解决:`.ipynb` 文件被当作纯文本改导致的结构损坏
- ✅ 解决:数据科学用户的工具适配问题
- ✅ 好处:打开数据科学/ML 这个高价值用户群体

**实现机制(三句话)**
1. 新增 `notebook_edit` 工具,内部用 `@nteract/commutable` 或手写 nbformat 4.x JSON 解析。
2. 按 `cell_id` 或 `cell_index` 定位,支持 `insert/replace/delete` 三种 edit_mode。
3. 保留 outputs/metadata 不动,只替换 source,写回时保持 nbformat 规范的缩进。

---

### #15 语义代码搜索(向量索引)

**用法**
```
semantic_search(query="处理用户登录失效的逻辑", top_k=10)
```
返回语义最相关的代码块,而不是字面匹配。

**为什么需要这个工具**
Grep 只能找字面匹配,但"登录失效"在代码里可能是 `token expired`、`session invalid`、`auth timeout` 等十种说法。Cursor 的 Codebase 索引是它的核心卖点之一。大仓库里这是刚需。

**好处与解决的问题**
- ✅ 解决:字面搜索无法覆盖同义词/意图的问题
- ✅ 解决:大型 codebase 里"按功能找代码"的低效
- ✅ 好处:在大项目里显著提升模型一次命中率

**实现机制(三句话)**
1. 项目首次打开时,用 embedding 模型对每个文件分块后生成向量,存入 SQLite + sqlite-vss 扩展。
2. 文件变更时增量更新对应 chunk 的向量(走 Hooks 系统的 PostToolUse,依赖 #9)。
3. `semantic_search` 工具把 query 向量化后做 ANN 检索,返回 `file:line:snippet:score`。

---

### #16 apply_patch —— 应用补丁

**用法**
```
apply_patch(patch="
*** Begin Patch
*** Update File: src/App.tsx
@@
-const foo = 1;
+const foo = 2;
*** End Patch
")
```
直接应用 unified diff 格式的补丁。

**为什么需要这个工具**
当前 `edit_file` 是"找一段文本替换",遇到大段重构时模型要算出完整 newText,token 消耗大。Codex 用 `apply_patch` 这种格式可以让模型只输出 diff,大幅降低输出 token。也方便用户粘贴外部补丁。

**好处与解决的问题**
- ✅ 解决:大文件重构时输出 token 爆炸的问题
- ✅ 解决:无法直接应用用户粘贴的 `.patch` 文件
- ✅ 好处:降低大改动场景的成本和延迟

**实现机制(三句话)**
1. 新增 `apply_patch` 工具,解析类 V4A 格式的补丁语法。
2. 对每个目标文件读当前内容,应用 hunks,失败的 hunk 报告行号但不中断其他 hunk。
3. 全部应用成功后走单次 checkpoint + 一次写盘,失败则回滚到原始内容。

---

### #17 沙箱化代码执行

**用法**
```
run_command(command="rm -rf /tmp/test", sandbox="docker")
```
命令在隔离容器里执行,无法触及宿主文件系统(除挂载的项目目录)。

**为什么需要这个工具**
当前 `run_command` 直接在用户的 `/bin/zsh` 里跑,虽然有 `accessPolicy` 审批,但 `full_access` 模式下一个误判的 `rm -rf` 就能删库。Codex 默认在容器里执行,是它安全性的基础。

**好处与解决的问题**
- ✅ 解决:`full_access` 模式下的破坏性操作风险
- ✅ 解决:跨平台命令行为不一致(Windows/Linux 差异)
- ✅ 好处:让 `full_access` 真正可用而不危险

**实现机制(三句话)**
1. 检测系统是否安装 Docker,有则用 `docker run --rm -v <root>:/workspace` 起临时容器执行命令。
2. 无 Docker 时降级到当前的直接执行模式,并在结果里标注 `sandbox: "none"`。
3. 容器内用户/权限收敛为非 root,网络默认禁用,需要时显式 `--network=host`。

---

### #18 VSCode 扩展

**用法**
用户在 VSCode 里安装 "DeepSeeker" 扩展,侧边栏出现对话面板,直接在编辑器里和 agent 交互,选中代码右键"解释这段代码"。

**为什么需要这个工具**
当前产品是独立 Electron 应用,用户必须切换窗口,无法和编辑器原生集成。Cursor 本身就是 IDE,Claude Code 和 Codex 都有 VSCode 扩展。触达存量用户必须有 IDE 入口。

**好处与解决的问题**
- ✅ 解决:独立应用与编辑器割裂的体验问题
- ✅ 解决:用户切换窗口的摩擦
- ✅ 好处:大幅降低使用门槛,触达 VSCode 庞大用户群

**实现机制(三句话)**
1. 用 `@vscode/vsce` 打包一个扩展,启动时探测本地 Runtime(8787 端口)或引导用户启动。
2. 扩展通过现有 HTTP/SSE API 与 Runtime 通信,完全复用现有契约,无需新协议。
3. 注册 editor command、hover provider、code lens,把 agent 能力嵌入编辑器原生交互。

---

### #19 Tab 自动补全

**用法**
用户在编辑器敲 `const result = await fetchU`,按下 Tab,自动补全为 `const result = await fetchUser(id);`。

**为什么需要这个工具**
Cursor 的 Tab 补全是它的核心商业卖点,也是用户最高频的交互。当前 DeepSeeker 完全没有这个能力。

**好处与解决的问题**
- ✅ 解决:逐字符敲代码的低效
- ✅ 解决:多行编辑、光标跳转的重复操作
- ✅ 好处:从"对话式 agent"扩展到"嵌入式实时助手",使用频率提升一个数量级

**实现机制(三句话)**
1. 需要专门的 fill-in-the-middle(FIM)模型,DeepSeek Coder 系列有原生 FIM 支持(`<｜fim_begin｜>...<｜fim_hole｜>...<｜fim_end｜>`)。
2. VSCode 扩展监听光标变化,debounce 150ms 后取前后文构造 FIM prompt,本地或远端推理。
3. 延迟必须控制在 300ms 内,需要模型量化 + 推理缓存 + 增量请求合并,工程难度最高。

---

### #20 @-mentions —— 上下文引用

**用法**
用户在 Composer 输入:"帮我重构 `@src/auth/token.ts` 里的 `@validateToken` 函数,参考 `@docs/auth.md`"。被 `@` 的文件/符号自动注入上下文。

**为什么需要这个工具**
当前模型要自己用 `read_file` 去找,既耗 round-trip 又可能找错。Cursor 的 `@文件` `@文档` `@代码符号` 让用户精准控制上下文来源,是产品体验的关键差异化点。

**好处与解决的问题**
- ✅ 解决:用户精准指定上下文的需求
- ✅ 解决:模型自己摸索找文件造成的延迟
- ✅ 好处:让用户对 agent 的上下文有显式控制权,提升信任度

**实现机制(三句话)**
1. Composer 输入框监听 `@` 触发文件/符号 picker(基于已有的 `list_files` + LSP 符号索引)。
2. 选中后把文件内容/LSP 定义作为结构化 attachment 附加到提交的 user message。
3. 走多模态契约(依赖 #10)的扩展版,把 attachment 渲染成 `<attachment type="file" path="...">content</attachment>` 块。

---

## 五、重点结论与建议

### 5.1 最值得先补的三件(投入产出比最高)

| 优先级 | 工具 | 理由 |
|---|---|---|
| 🥇 | **#1 + #2 Grep / Glob** | 高频、易做、收益立竿见影;把依赖 `run_command` 的高频操作升级成一等公民,1-2 天可上线 |
| 🥈 | **#5 子 Agent(Task)** | Claude Code 的核心武器,你的 Runner 已高度模块化,实施成本低;完成后复杂任务处理能力跨数量级提升 |
| 🥉 | **#7 MCP 接入** | 你已经留好口子(`registerDeferredCapabilityProvider`),把脚手架填满即可;一次投入,生态能力瞬间打开 |

### 5.2 一个架构提醒(必须先做的地基)

> **在做 #10 多模态 / #20 @-mentions 之前,先升级 `shared/contracts/provider.ts` 的 `ModelMessage` 契约。**

当前 `ModelMessage` 只支持纯文本,后续所有多模态(image/audio/video/attachment)都要返工。建议一次性升级为:
```typescript
type ModelMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content: string | ContentPart[];
};
type ContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } }
  | { type: "attachment"; path: string; mime: string };
```

### 5.3 缺口优先级矩阵

```
高价值
   │
   │  ★子Agent          ★MCP接入
   │  ★Grep/Glob        ★多模态
   │  ★WebSearch        ★Hooks
   │
   │  Memory写          MultiEdit    后台任务
   │  Slash命令         Browser      apply_patch
   │  NotebookEdit      沙箱
   │  VSCode扩展        语义搜索     Tab补全    @-mentions
   │
   └────────────────────────────────────────────► 实现难度
```

### 5.4 实施路径建议(分四批交付)

| 批次 | 工具 | 周期估计 | 价值 |
|---|---|---|---|
| **批次 1** | Grep、Glob、Memory 写入 | 1 周 | 补齐日常高频短板 |
| **批次 2** | 子 Agent、Provider 契约升级 | 2 周 | 拓展复杂任务上限,为多模态铺路 |
| **批次 3** | MCP 接入、WebSearch、WebFetch、MultiEdit | 2-3 周 | 打开生态与外部信息闭环 |
| **批次 4** | 多模态、Hooks、后台任务、Slash 命令 | 3-4 周 | 产品力全面对齐 Cursor/Claude Code |

Tier 3(Browser/Notebook/语义搜索/沙箱/VSCode/Tab/@-mentions)按业务方向择机投入,非必选项。
