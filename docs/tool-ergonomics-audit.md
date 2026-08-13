# DeepCreator 工具链易用性体检(2026-08-13)

> 对标:Claude Code(Anthropic 官方 CLI)、Codex CLI(OpenAI)
> 方法:三方交叉验证 —— ① 56-agent 多阶段工作流审计(7 维度 → 综合 → 对抗性验证,产出 42 条建议,19 confirmed / 14 plausible / 3 rejected);② DeepSeek(R332)对自身工具链的自检;③ 对以上两份自检的逐条源码核实。
> 编写日期:2026-08-13

---

## 一、结论先行

DeepCreator 工具链在**正确性与安全**上已超过 Claude Code 的细度:`accessPolicy.ts` 的 segment 级命令分类、`apply_patch` 原子事务+回滚、`edit_file`/`multi_edit` 的 stale 内容指纹校验与链式原子回滚、托管命令(commandId + wait/stop)生命周期。这些都是 Claude Code 基本没有或更粗的护栏。

真正拉开差距的是**"模型调用工具时的失败恢复路径与认知负担"**——也就是 Claude Code 工具描述里密集的 `when-to-use / when-NOT-to-use / IMPORTANT`,以及**错误返回里自带的"下一步该怎么做"**。DeepCreator 在这一层有若干具体缺口,且存在两处"描述与实现言行不一"会直接误导模型。

> ⚠️ **2026-08-13 第二轮校正**:对照 Claude Code 公开的工具设计史(尤其 Edit 从 `start_line`/`end_line` 迁移到 `old_string`,因 LLM 生成行号易漂移)后,**P0-1 已反转**——"让 read_file 返回行号、强化 startLine 锚定"是错误方向,正确方向是强化 old_string 精确匹配 + 失败自纠正(见第六节批次 2.1)。整改计划见第六节。

⚠️ 注:DeepSeek 自检有价值,但有 3 处对自家实现的描述不准确(见第五节核实记录),整合时已校正。

---

## 二、和 Claude Code / Codex 的差距(校正后)

| 维度 | DeepCreator 现状(核实) | Claude Code | Codex CLI |
|---|---|---|---|
| **编辑模型** | edit_file / multi_edit / write_file / apply_patch 四入口;**双路径匹配**(old_string 精确 + startLine 行号锚定)——后者为 Claude Code 已弃用路径 | Edit / MultiEdit / Write + apply_patch;**单一 old_string 精确匹配**(从 start_line 迁移而来,因行号漂移不可靠),分层清晰 | 编辑 + 沙盒内写文件 |
| **代码智能** | 仅文本级 grep/glob | LSP 符号级导航 + 实时类型错误 | 上下文内省 |
| **沙盒/审批** | **三档** AccessMode(request_approval/smart_approval/full_access)+ 四档 AccessRisk + segment 级 readOnly/network/destructive 分类 + grant 缓存 | Hooks + 审批门槛 | **三层沙盒(read-only/workspace-write/danger-full-access)+ 平台级隔离(Landlock/Seatbelt/Windows job objects)+ protected paths 强制只读 + 网络独立开关 + 分级审批** |
| **Git** | 仅 git_status 只读摘要;commit/push/log 走 run_command | 完整 Git 集成 | 沙盒保护 .git |
| **记忆** | search_memory 只读,**无写入工具**;但记忆已自动注入 | CLAUDE.md 三层配置 + 自动读写记忆 | 配置持久化 |
| **会话** | **有**恢复胶囊(recovery capsule)+ sessionId+afterOffset 断线续接(ADR-003/004/007) | JSONL 记录,可 rewind/resume/fork | session 机制 |
| **子代理** | delegate:explorer/worker 二选一、上限 4 并发、深度 1 | 可自定义 prompt 的 subagent + Agent teams 对等消息 | 有子代理 |
| **Web** | **2 个**:web_search + fetch_url(非 4 个) | WebSearch + WebFetch | — |

**关键校正**:
- 沙盒审批**不是"二元"**,而是三档 AccessMode × 四档 AccessRisk × capability 分类。但相比 Codex 仍缺:**平台级进程隔离**(Landlock/Seatbelt/job objects)、**protected paths 强制只读**(如递归保护 `.git`)、**网络独立开关**、**on-failure 升级审批**。这是 DeepCreator 比上不足的部分。
- 会话**有恢复能力**(恢复胶囊 + 断线续接),但没有 Claude Code 那种**用户可 rewind/fork 历史分支**的能力。
- Web 工具**只有 2 个**,不存在碎片化问题。

---

## 三、确认的缺陷(三方一致 + 源码核实,按优先级)

### 🔴 P0-1(2026-08-13 校正):编辑匹配应强化 old_string + 失败自纠正,而非行号锚定

> ⚠️ **本条是对初版的反转。** 初版建议是"让 read_file 返回行号、把 edit_file 的 startLine 锚定变可用"。对照 Claude Code 公开的**设计史**——他们早期用 `start_line`/`end_line`,后来**主动迁移到 `old_string` 精确匹配**,原因是 **LLM 生成的行号极容易漂移**(改一处后全文件行号都变),而生成要替换的原文更稳定——初版建议的前提("行号锚定是好东西")被证伪。

**DeepCreator 现状的问题**:`edit_file`/`multi_edit` 同时走两条路——old_string 精确匹配(strict,主)+ startLine/endLine 行号锚定(relaxed,回退)([files.ts:102-141](../server/infra/tools/files.ts:102))。这等于"把 Claude Code 已证伪的旧路径又捡回来当兜底",且 startLine 必须与 endLine 同时给出、单传静默失效([files.ts:139-141](../server/infra/tools/files.ts:139))——是个"半生效参数"陷阱。

**正确方向**(对照 Claude Code Edit,与 P0-4 合流):
1. **强化 old_string 精确匹配 + 失败自纠正**:匹配失败时回显"附近实际行原文 + oldText 首行",让模型直接 diff 出空白/缩进差异再重试。DeepCreator 的 `nearestLine` 提示([textMatch.ts:63](../server/infra/tools/textMatch.ts:63))已有雏形,应扩展到多行上下文,并铺到 multi_edit/apply_patch。**这才是编辑侧最高杠杆的改造。**
2. **考虑弱化/移除 startLine/endLine**:减少"半生效参数"陷阱。若保留,须在描述里显式声明"二者必须同时给出,且只在 strict 未命中时生效、行号会因前序编辑漂移"。短期内**不建议彻底删**(multi_edit 已实现且无害),但**不应再投入优化它**。
3. **read_file 加行号仍有价值,但理由要换**:不是为了喂给 startLine 锚定,而是为**模型读代码的可读性与定位**(看 stack trace、引用 `file:line`、与用户沟通)。这是独立收益,不依赖锚定链路,优先级从 P0 下调到 P1。

### 🔴 P0-2:`read_file.maxChars` 描述与实现"言行不一"(trivial 但必修)

- 描述写"默认 200000",实现是 `40_000`([registry.ts:239](../server/infra/tools/registry.ts:239) vs [files.ts:84](../server/infra/tools/files.ts:84));且 40k 边界**静默截断无提示**(`truncated` 标志只给 UI,模型看不到)。
- 同模块 `read_skill_resource`/`fetch_url` 都正确区分了"默认 vs 上限",唯独 `read_file` 写错。**一句话修复**。

### 🔴 P0-3:缺 `save_memory` —— 记忆环路只读不写(confirmed)

- `search_memory` 是只读的,其描述自陈"目前尚无保存工具"([registry.ts:201](../server/infra/tools/registry.ts:201));底层 `MemoryStore.save` 存在但**只挂在 HTTP POST 给人类用**([http.ts:328](../server/transport/http.ts:328)),模型不可达。
- Claude Code:模型可发现事实并直接写回 `~/.claude/memory`,读写对等。
- **改法**(small):新增 `save_memory` 工具包一层 `MemoryStore.save`,保留凭据检测拦截;可选加用户确认符合 ADR-003。

### 🔴 P0-4:编辑/补丁失败返回缺"可操作修复路径"(与 P0-1 新方向合流)

- `edit_file` 失败已有 `nearestLine` 提示([textMatch.ts:63](../server/infra/tools/textMatch.ts:63)),但**只给一行近似行号、不给附近实际行原文**;`multi_edit` 失败清单([files.ts:207-213](../server/infra/tools/files.ts:207))和 `apply_patch`([applyPatch.ts:47-55](../server/infra/tools/applyPatch.ts:47))**完全不给上下文**。
- 后果:模型不知是空白/缩进差异还是真没匹配到,只能盲重试。
- Claude Code Edit 的灵魂是**"失败即反馈、模型自纠正"**:失败信息本身指向"重新 Read 再试"。
- **改法**(medium,P0-1 新方向的核心):三类编辑工具失败时统一回显——① 出错位置编号(hunk[N]/edit[N])② 期望锚点 ③ **附近实际行原文 + oldText 首行**,让模型一次 diff 出差异。这是编辑侧最高杠杆改造。

### 🔴 P0-5:托管命令协议的隐性记忆负担

- `commandId` 是无意义 UUID([commandManager.ts:144](../server/infra/tools/commandManager.ts:144)),**且模型收到的工具结果文本里根本不含 commandId**(`reduceToolEvidence` facts 只列命令/退出码/超时/裁剪)——这是验证阶段才发现的、原始建议没点出的**最高杠杆修复**。
- `run_command` 只有 `command` 一个字段,模型**无法控制 timeout**(60s 硬切)也无法后台跑。对比 Claude Code Bash:`timeout` 参数(默认 120s、上限 600s、模型可调)+ `run_in_background`(跨 turn、退出自动回调,无需句柄/轮询)。
- **改法分两档**:
  - 小步(small):commandId slug 化 + **把 commandId 显式放进工具结果文本** + `wait` 单 waiter 抛错改幂等(并发 tool_calls 是模型正常用法)。
  - 大步(large):`run_command` 增 `timeout_ms` + `run_in_background`。

### 🔴 P0-6(三方一致,DeepSeek 强调):无代码智能层

- 定位符号靠 grep 猜、跨文件追踪靠人工串联。"重命名跨 12 文件的符号"这类任务漏改风险显著高于 Claude Code(连 LSP,符号级找定义/引用、读实时类型错误)。
- 这是**和 Claude Code 差距最大、最提升正确率**的一项,但投入也最大(需接入 LSP server)。

### 🟡 P1:编辑工具三套心智模型重叠 + 匹配脆弱(DeepSeek 强调)

- edit_file / multi_edit 本质同一能力(精确字符串替换,后者是批量版);apply_patch 又一套 diff 语法。"该用哪个"本身就是出错面。
- 三者都依赖 oldText 精确匹配,遇空白/换行差异失败,`startLine` 宽松匹配是事后补丁而非设计。违背"consolidation to reduce ambiguity"原则。
- **谨慎改法**:DeepSeek 建议合并为 write_file + 统一 edit。但 DeepCreator 的 `multi_edit` 原子性、`apply_patch` 事务回滚是**真实价值**,不能简单删。建议**保留能力、收敛入口认知**:让匹配失败时**自动回退行号定位/宽松空白**(而非逼模型手动加 startLine),并在描述里明确四者分工。**不建议物理删除** multi_edit/apply_patch。

### 🟡 P1:Git 工具残缺

- 只有 git_status 一个只读摘要;commit/push/branch/log 全走 run_command,提交流程割裂;git_status 返回 `--stat` 摘要而非具体 hunk。
- **改法**(small):补 `git_diff`(只读,返回真实 hunk);`git_commit`(受审批)。让模型能自查改动、用户能确认。

### 🟡 P1:沙盒缺平台级隔离 + protected paths(DeepSeek 强调,校正措辞)

- DeepCreator 有三档审批 + 命令分类,**不是二元**(校正 DeepSeek 原文)。但相比 Codex 仍缺:**平台级进程隔离**(Landlock/Seatbelt/Windows job objects)、**protected paths 强制只读**(递归保护 `.git`/敏感目录)、**网络独立开关**、**on-failure 升级审批**。
- 这层缺失意味着 `full_access` 模式下一个误判的 `rm -rf` 能删库——Codex 用平台隔离兜底。
- **改法**(medium-large):分层模式 + protected paths + 网络独立开关 + 分级审批。

### 🟡 P1:`delegate` 描述太薄 + 子代理能力受限

- 描述只有 4 行,**完全没有 when-to-use / when-NOT-to-use**,没教并行 fan-out(最多 4)和 explorer vs worker 选型([registry.ts:668](../server/infra/tools/registry.ts:668))。(trivial 修复)
- explorer(只读但**不能跑命令验证**)↔ worker(一选中就 full_access)权限跨度太大,缺"只读+可跑验证命令"的中间角色(类似 Claude Code code-reviewer)。
- 不能自定义 system prompt / 工具白名单;Claude Code subagent 可自定义 + Agent teams 对等消息。

### 🟢 P1/P2:零散易用性补强(都 confirmed)

- `glob`/`grep` Minimatch 是 `dot:false`,**找不到 `.github`/`.vscode`/`.eslintrc` 等点文件** → 改 `dot:true`。(small)
- `list_files` 无非递归/depth 控制,大项目直接吃满 `maxFiles=200`,建议默认只列一层。(small)
- `search_memory` 描述把"任务开始时检查偏好"列为主场景,但记忆**已通过 `<memory-index>` 自动注入**([contextBuilder.ts:332](../server/app/contextBuilder.ts:332)) → 改为"仅在需取截断全文/字段时才调"。(trivial)
- `read_file` 描述应补**负向教学**:"编辑成功后不要重读验证"(edit 成功已返回 unified diff)。(trivial)
- `apply_patch` 是 registry 里**唯一缺四段式描述**(用途/适用/不适用/IMPORTANT/示例)的写入工具 → 补齐。(trivial)
- `edit_file`/`multi_edit` 的 `startLine`+`endLine` 必须同时给出,只给其一静默失效([files.ts:139-141](../server/infra/tools/files.ts:139)),schema 描述未声明。(small)
- `ask_user` 的 `minSelections/maxSelections` 只标 `minimum:1` 无默认值说明;questions `maxItems:3`(Claude Code 是 4)。(trivial)
- `delegation_result` 把子代理终态原文塞进父上下文**无长度上限** → 加软上限,守住"保护父上下文"承诺。(P2, small)

---

## 四、被验证**驳回**的建议(DeepCreator 已有解法,勿重复造)

1. **"plan 模式进了出不来"** —— 不成立。`planReview.ts:107-120` 已有完整 submit_plan → 用户授权退出路径,真问题只是 prompt 里没教"误入后怎么回退"(补一句即可)。
2. **"update_tasks 无法清空清单导致收尾死锁"** —— 不成立。`completionGate.ts:10` 已对空清单豁免;`tasks minItems:1` 是小痛点但模型可用单步 completed 自然收尾。
3. **"web_search 缺时效注入/Sources 契约"** —— 不成立。当前日期已通过 `<environment>` 信封注入([contextBuilder.ts:320](../server/app/contextBuilder.ts:320))。

---

## 五、DeepSeek 自检的**事实核实记录**(整合时校正)

| DeepSeek 论断 | 核实结果 | 说明 |
|---|---|---|
| Web 工具 4 个(search/open_page/find_in_page/fetch_url),碎片化 | ❌ **不准确** | 实际只有 `web_search` + `fetch_url` 2 个([registry.ts](../server/infra/tools/registry.ts)),无 open_page/find_in_page。不存在碎片化。 |
| 沙盒是"二元审批 or not" | ❌ **不准确** | 实为三档 AccessMode × 四档 AccessRisk × capability 分类 + grant 缓存([runtime.ts:168](../shared/contracts/runtime.ts:168))。但相比 Codex 仍缺平台级隔离/protected paths/网络独立开关——这部分批评成立。 |
| 会话"无回放/恢复能力" | ⚠️ **部分不准确** | 有恢复胶囊(recovery capsule)+ sessionId+afterOffset 断线续接(ADR-003/004/007)。但没有 Claude Code 那种用户可 rewind/fork 历史分支的能力——这部分批评成立。 |
| 编辑工具三套重叠心智 | ✅ 成立 | 但 multi_edit 原子性、apply_patch 事务回滚是真实价值,**不建议物理删除**,应收敛认知而非砍入口。 |
| 缺代码智能层 | ✅ 成立 | 与 Claude Code 差距最大项。 |
| 记忆半闭环(只读不写) | ✅ 成立 | 已列 P0-3。 |
| Git 残缺 | ✅ 成立 | 已列 P1。 |
| delegate 简化版 | ✅ 成立 | 已列 P1。 |
| Skill 工具占 7 个、无命名空间 | ✅ 成立(但优先级低) | 命名空间化是长期清理项,非紧急。 |

---

## 六、整改计划(投入产出比排序)

> 校正说明:2026-08-13 对照 Claude Code 公开设计史后,P0-1 从"行号锚定"反转为"强化 old_string + 失败自纠正",并与 P0-4 合流。read_file 加行号降为 P1(理由改为可读性,非锚定)。

### 批次 1 —— 描述校正(零风险,立即做,trivial/半天)
纯文档/描述改动,不碰运行时逻辑,无回归风险。

| # | 动作 | 文件 | 依据 |
|---|---|---|---|
| 1.1 | `read_file.maxChars` 描述改"默认 40000,上限 200000" | registry.ts:239 | P0-2,描述与实现言行不一 |
| 1.2 | `apply_patch` 补四段式描述(用途/适用/不适用/IMPORTANT/示例)+ 与 edit/write 分工 | registry.ts:356-360 | P1,registry 唯一缺四段式的写入工具 |
| 1.3 | `delegate` 补 when-to-use / when-NOT-to-use + 并行 fan-out 示例 + explorer vs worker 选型 | registry.ts:668 | P1 |
| 1.4 | `search_memory` 改为"记忆已自动注入,仅在需取截断全文/字段时调" | registry.ts:201 | P1 |
| 1.5 | `read_file` 补负向教学"编辑成功后不要重读验证" | registry.ts:236 | P2 |
| 1.6 | `grep` json 档描述补字段清单,统一三/四档表述 | registry.ts:261 | P2 |
| 1.7 | `edit_file`/`multi_edit` 描述显式声明"startLine+endLine 必须同时给出,strict 命中时不生效" | registry.ts:400,429 | P1,半生效参数陷阱 |
| 1.8 | `run_command` 补 shell 行为教学("cwd 持久 / env 不持久 / VAR=val 是唯一传环境方式") | registry.ts:468 | P1 |

### 批次 2 —— 失败自纠正 + 高频缺陷(small,2-3 天)
直接提升编辑/搜索成功率,中等风险,需回归测试。

| # | 动作 | 文件 | 依据 |
|---|---|---|---|
| 2.1 | **edit/multi_edit/apply_patch 失败统一回显**(hunk/edit 编号 + 附近实际行原文 + oldText 首行) | textMatch.ts/files.ts/applyPatch.ts | **P0-1+P0-4 合流,编辑侧最高杠杆** |
| 2.2 | `glob`/`grep` Minimatch 改 `dot:true`(能找点文件) | search.ts | P1 |
| 2.3 | `list_files` 增 depth/非递归控制,默认列一层 | files.ts | P1 |
| 2.4 | 新增 `save_memory` 工具(包 MemoryStore.save + 凭据拦截 + **写入不刷新当前会话信封**,详见第八节) | tools.ts/registry.ts | P0-3,记忆闭环;缓存友好 |
| 2.5 | commandId 进工具结果文本 + slug 化 + wait 幂等 | commandManager.ts/evidence.ts | P0-5 小步 |
| 2.6 | `read_file` 加 `cat -n` 行号 + offset/limit(**理由=可读性,非锚定**) | files.ts | P1(从 P0 下调) |

### 批次 3 —— 结构性能力(medium/large,2-4 周)
对齐 Claude Code/Codex 的核心差距,需要架构决策。

| # | 动作 | 依据 | 备注 |
|---|---|---|---|
| 3.1 | `run_command` 增 `timeout_ms` + `run_in_background` | P0-5 大步 | 对照 Claude Code Bash |
| 3.2 | `git_diff`(只读真实 hunk)+ `git_commit`(受审批) | P1,Git 残缺 | |
| 3.3 | `delegate` 增第三个角色 reviewer(只读+可跑验证命令) | P1 | |
| 3.4 | 沙盒:protected paths 强制只读(.git 递归保护)+ 网络独立开关 + on-failure 升级审批 | P1 | 平台级隔离(Landlock/Seatbelt/job objects)投入更大,可后置 |
| 3.5 | 代码智能层(LSP 符号定义/引用/类型错误) | P0-6 | 投入最大,与 Claude Code 差距最大项 |

### 暂缓 / 不做
- **物理合并编辑工具**(DeepSeek 建议):驳回。multi_edit 原子性、apply_patch 事务回滚是真实价值,收敛认知(批次 1.2/1.7)而非砍入口。
- **移除 startLine/endLine**:暂缓。已实现且无害,不再投入优化即可;若批次 2.1 的失败自纠正足够好用,未来可考虑标记为 deprecated。
- **会话 rewind/fork**:暂缓。已有恢复胶囊 + 断线续接(ADR-003/007),rewind/fork 是增量体验,非阻塞。

### 验证策略
- 批次 1:改动后跑 `npm run build`(tsc 校验),无需功能测试。
- 批次 2:每个动作配 `tests/*.test.ts` 聚焦用例(2.1 验证"失败回显含附近行";2.6 验证"行号注入后 stale 校验仍正确")。
- 批次 3:按工具配集成测试 + 在真实任务跑 eval(`evals/datasets/code-agent-v1.json`)。

---

## 八、记忆注入层与缓存分析(2026-08-13 新增)

> 起因:用户问"记忆在上下文哪一层,会不会破坏缓存命中?"。经 Claude Code 自身上下文实测 + 官方文档核实(子代理)+ DeepCreator 源码核实(子代理)三方交叉,结论如下。
> 本节同时校正了 2.4(`save_memory`)的设计约束。

### 8.1 三方记忆注入层对照(实测 + 官方文档)

| 维度 | Claude Code | Codex CLI | DeepCreator |
|---|---|---|---|
| **记忆角色** | user 角色 `<system-reminder>`(非 system) | `<INSTRUCTIONS>` user fragment | user 角色 `<system-reminder type="context">` |
| **注入位置** | `messages[0]` 首条 user 消息内,第 3 个 text block([对比文档 §1.3](./context-loading-comparison.md)) | user 消息聚合块 | `messages[1]` user,`<memory-index>` 段([contextBuilder.ts:332](../server/app/contextBuilder.ts:332)) |
| **注入形态** | 仅 `MEMORY.md` 索引(前 200 行 / 25KB 上限,官方文档);`memory/*.md` 正文按需召回 | AGENTS.md 全文 | `memoryDigest` 12 条摘要(tab 分隔,statement 截断 220 字符,[runtimeStore.ts:356-360](../server/infra/runtimeStore.ts:356)) |
| **与日期同块?** | **同块**(currentDate 紧贴 `# claudeMd`) | 同 `<environment_context>` user fragment | **同信封**(`<environment>` 含 `date`,与 `<memory-index>` 同 stableEnvelope,[contextBuilder.ts:329-335](../server/app/contextBuilder.ts:329)) |
| **注入时机** | 会话起点一次(非每轮) | 会话起点 | 会话起点 + 压缩时重建(见 8.3) |
| **缓存标记** | API 层 `cache_control` 断点在 system 末尾;记忆块处于"断点之后" | `instructions` 字段会话级稳定 | 自有 `session_stable` + `survivesCompaction:true`([contextBuilder.ts:482](../server/app/contextBuilder.ts:482)) |
| **记忆变更生效** | **延迟**:mid-session 编辑不重注入,`/clear` 或重启才生效(**应用层决策**,非缓存语义;官方未文档化,子代理推断) | — | revision hash 纳入记忆,变即重建信封(但实际只在压缩/新会话触发,见 8.3) |

**行业共识**(三方一致):基础规则(身份/行为)在 system 层,**易变但会话内稳定的内容(记忆/环境/日期)收敛进 user 层一个稳定块,置于 prefix 前段**——以"块内字节稳定"换取前缀缓存命中。DeepCreator 的设计与 Claude Code 是同一套解法,记忆"破坏缓存"的担忧对两家同样成立(见 8.2 日期那一下),不是 DeepCreator 特有缺陷。

### 8.2 Anthropic prompt cache 语义(官方文档核实,子代理)

| 事实 | 状态 | 出处 |
|---|---|---|
| 默认 ephemeral TTL = **5 分钟** | ✅ 官方文档 | platform.claude.com prompt-caching |
| 扩展档 **1h TTL**(`ttl:"1h"`) | ✅ 官方文档 | 同上;Claude Code 拦截请求用此档 |
| **任意一字节变化**即从该点失效,其后重算 | ✅ 官方文档 + 实测 | claudecodecamp |
| 5min write = **1.25x** base;1h write = **2.0x**;read = **0.1x** | ✅ 官方文档 | platform.claude.com |
| 每请求最多 **4 个 cache_control 断点** | ✅ 多源 | 限制了"把记忆/日期切成分段缓存"的自由度 |
| **idle > TTL → 服务端缓存逐出**,下次请求全量 cache-write | ✅ 社区/实现 | idle 后"反正要 mutate prefix"的刷新是免费的——但**需追踪 idle 时长** |
| 缓存沿稳定 prefix 在**最后断点之后**继续延伸(user 消息也算 cache read) | ⚠️ **未文档化的实现细节,中等把握** | 子代理如实标注;非官方契约 |

> ⚠️ 最后一条是子代理诚实标注的**不确定性**:它在文档里未被明确承诺。本节凡涉及"记忆块也算 cache read"的表述都按此降级理解。

### 8.3 DeepCreator 的"免费刷新窗口"矩阵(源码核实,子代理 #1)

**核心机制**([contextBuilder.ts:411](../server/app/contextBuilder.ts:411), [:458](../server/app/contextBuilder.ts:458)):stableEnvelope 一旦持久化为 `session_context` 记录就**逐字冻结、逐轮复用**,`<memory-index>` 根本不重算;`stableEnvelope()`(唯一调 `memoryDigest` 读最新记忆)只在两个条件重跑。注释 [:457](../server/app/contextBuilder.ts:457) 明写:"Root guidance is frozen until compaction. A successful compaction starts a new frozen prefix."

| 窗口 | 触发 | 重跑 stableEnvelope? | 刷新记忆代价 |
|---|---|---|---|
| **#1 会话起点** | 无 existingEnvelope(冷启动) | ✅ 是([:411](../server/app/contextBuilder.ts:411)) | **免费** |
| **#2 压缩 compaction** | `dropped.length > 0`([:458](../server/app/contextBuilder.ts:458)),token 超阈([:438](../server/app/contextBuilder.ts:438)) | ✅ 是 | **免费**(前缀本就全丢重算) |
| resume / 恢复胶囊 | 断线续接 | ❌ 复用冻结信封,recovery capsule 是 dynamic 非前缀消息 | **不免费**(代理 #1 校正了草稿里此条) |
| 日期翻动 | 跨天 | ❌ date 烤进冻结信封,会话内不更新 | **不免费**(校正) |
| mode/guidance/skill 变更 | 运行中切换 | ❌ 全是 append-only dynamic 消息,不碰信封 | **不免费**(校正) |
| **长空闲 > cache TTL** | 会话停滞 | ❌ **现有基础设施不存在**——server 全仓无 `lastActivity`/cache-TTL 追踪(唯一 TTL 是 skillStore 的 1h skill 预览,无关) | **需新基建**(见 8.5 选项 B) |

**死代码标注**:[contextBuilder.ts:351-371](../server/app/contextBuilder.ts:351) 的 `sessionRevisionHash()` **全仓零调用**(代理 #1 核实)。重建门控是纯结构性的(`existingEnvelope` 缺失 或 `dropped>0`),不是 hash 比较。文档此前对"revision hash 如何感知记忆变更"的描述应据此修正:hash 是观测性的(进遥测/快照),不门控重建。

### 8.4 结论:DeepCreator 的冻结架构**天然满足**"延迟刷新"不变量

把用户的设计意图形式化成一条不变量:

> **`save_memory` 写存储立即、持久**(给其他会话和未来重建点用);**当前会话信封里的 `<memory-index>` 只在 prefix 本来就要重建时被动捎带刷新,无主动定时器**。两次重建之间,写入方会话保留"略旧"的索引——这是**正确行为不是 bug**,因为写记忆的那个模型不需要读回它(内容已在其工作上下文),更新只对**别的会话**有意义,而别的会话在各自起点免费拿到。

关键洞察:DeepCreator 现有冻结架构(contextBuilder.ts:411/458)**已经实现了这条不变量**,因为非重建轮的 `memoryDigest` 结果根本被丢弃。**不需要加任何 pending 机制或刷新调度器**——这是源码核实带来的简化,比初版草稿(设想要打 pending 标记)更干净。

### 8.5 选项抉择:纯被动(A)还是加 idle 追踪(B)

| | 选项 A:纯被动(零新基建) | 选项 B:加 `Session.lastActivityAt` 追踪 |
|---|---|---|
| **机制** | 仅靠现有 #1 + #2 两个窗口;会话内长空闲不主动刷新 | `prepareSessionContext` 比较 `now - lastActivityAt > cacheTTL` 作为第三窗口 |
| **理由** | 写入方模型不需读回;其他会话各自起点免费拿到;冻结架构已满足不变量 | 贴合"会话停了很久缓存失效就该刷"的直觉;长 idle 后用户继续同一会话能见到新记忆 |
| **代价** | 同一会话长 idle 后续写,信封仍是旧的(无害,因模型已知该事实) | 改 schema + 加比较逻辑 + 选 cacheTTL 常数(5min?需实测) |
| **建议** | ✅ **推荐先做 A**。边际收益小,符合 YAGNI | 列为**可选增强**,若实测发现"同会话长 idle 后要见新记忆"是真实痛点再做 |

**倾向 A 的依据**:用户最后一条澄清("如果缓存没到期或没压缩,memory 就不需要更新")正是 A 的语义——A 严格遵守它;B 的 idle 窗口反而会在"缓存恰好未到期但超 idle 阈值"时刷新,违反该意图(除非 idle 阈值 > cacheTTL,但那时缓存已逐出,属免费)。

### 8.6 批次 2.4(`save_memory`)的设计约束(据此更新)

1. **立即持久**:写 `runtime.sqlite`(包 `MemoryStore.save`,保留 [memoryStore.ts:13](../server/infra/memoryStore.ts:13) 凭据拦截:`sk-...`/`api_key=`/`token:`/`password:`/`secret:` 正则)。
2. **不刷新当前信封**:工具实现里**不碰** `<memory-index>` / stableEnvelope。当前会话在下次压缩或新会话时被动捎带刷新(8.3 窗口 #1/#2)。这是**刻意为之的缓存保护**,对齐 Claude Code 的延迟生效策略。
3. **反馈给模型**:工具返回应明示"已保存(对后续会话生效);当前会话的记忆索引将在下次上下文压缩时刷新"——让模型知道为何不立即见到,避免它误判保存失败而重试。
4. **visibility 参数**:默认 `personal`(跨项目);`project` 绑 projectRoot。详见 [memory note](../memory-store-architecture.md)。

---

## 九、实施状态

> 本节记录已落地的批次。每项均配回归测试,通过 `npm run build && npm test`(520 tests,0 fail)验证。

| 批次 | 状态 | 测试 |
|---|---|---|
| 批次 1(8 条描述校正:read_file maxChars/apply_patch/delegate/search_memory/read_file 负向教学/grep json 字段/edit+multi_edit startLine/run_command shell 语义) | ✅ 已落地 | `toolSemantics` CJK 约束("keeps every model-visible tool description in Chinese") |
| 批次 2.1(edit/multi_edit/apply_patch 失败统一回显 hunk/edit 编号 + 附近实际行原文 + oldText 首行) | ✅ 已落地 | `editFileTolerant`/`multiEdit`/`applyPatch`/`textMatch` 失败回显断言 |
| 批次 2.2(glob/grep `dot:true`,可见 `.github`/`.vscode`/点配置) | ✅ 已落地 | `glob`/`grep` 点文件用例 |
| 批次 2.4(`save_memory` 记忆闭环:control-tool 接入 + 凭据拦截 + 写入不刷新当前信封) | ✅ 已落地 | `saveMemory` 4 断言(正常/密钥被拒/project 自动填 projectRoot/personal 空) |
| 批次 2.4 缓存保护不变量(计划验证第 7 项) | ✅ 已落地 | `saveMemoryEnvelope` 2 断言:① 写入后当前会话 `<memory-index>` 冻结 + `prefixHash` 不变(缓存命中保护);② 新会话起点 / 压缩触发 才重建信封含新记忆 |

**仍未落地**(留后续单独计划):批次 2.3(list_files depth)、2.5(commandId 进结果文本)、2.6(read_file 行号)、批次 3(LSP/sandbox/git)。

---

## 十、原始数据

- 工作流产物(42 条逐项建议,含 file:line 证据 + 对抗性验证):`journal.jsonl` 在 session 工作流目录下
- DeepSeek 自检原文:用户消息(2026-08-13)
- 旧版缺口清单(2026-07-20,部分已过时):[docs/tool-gap-inventory.md](./tool-gap-inventory.md)
- 上下文加载三方对比:[docs/context-loading-comparison.md](./context-loading-comparison.md)
