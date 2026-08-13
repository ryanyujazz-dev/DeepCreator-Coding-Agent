# DeepCreator 目标态工具集设计稿(2026-08-13)

> 对标:Claude Code(退出型命令靠 harness 回调自动送回;非退出型保留 TaskOutput/TaskStop)。
> 依据:[tool-ergonomics-audit.md](./tool-ergonomics-audit.md) 全批次 + 三角度"后台命令架构"核实 + 三组"工具集现状"盘点。
> 状态:**待审**。审过再实现。本文给出每个工具的名称 / 描述 / schema / tool result 组织方式。

## 设计原则

1. **能砍就砍**:机械性工作(等命令退出)吸收进 harness,不占模型可见工具位。
2. **失败即自纠正反馈**:每个工具失败返回"附近实际行 / 期望锚点 / 下一步"。
3. **结果文本自带可操作信息**:commandId、行号、截断标注都进正文,不藏在结构化字段里。
4. **专用优先于通用**:读文件用 read_file 不用 run_command cat;查改动用 git_diff 不用 run_command git diff。
5. **描述四段式**(用途 / 适用 / 不适用 / 重要 / 示例),全中文(CJK 测试约束)。

---

## 一、砍掉:`wait_command`(被 harness 回调取代)

**为什么能砍**:它90%的用途是"轮询一条退出型命令直到它结束拿结果"。批次 3.1b 的 harness 回调落地后,退出型命令自然结束 → Runtime 自动把最终输出作为续写消息送回,**模型不再需要主动 wait**。

**替代机制**:见 [§四 harness 回调](#四harness-回调机制批次-31b砍-wait-的前提)。

**残留场景的处理**:非退出型命令(dev server)读输出——由 `run_command` 转后台时的返回正文携带前 `timeout_ms` 窗口已产生的输出(服务启动日志通常在几秒内打出);杀命令由保留的 `stop_command` 负责。

---

## 二、改造的三个工具

### 2.1 `run_command`(增 timeout_ms + run_in_background + commandId 进正文)

**描述(四段式)**:
```
用途：在项目根目录执行一条真实 shell 命令(构建、测试、git、启服务、脚本)。
适用场景：需要真正运行进程、产生副作用或产出运行时输出的操作。
不适用场景：读文件内容(read_file)、按模式找文件(glob)、按内容搜(grep)、查 git 改动(git_diff)。能用专用工具就别用本工具。
重要：
  - 每次调用 spawn 一个全新隔离 shell,cwd 固定为项目根目录,环境变量不跨调用持久(在同一条命令内用 VAR=val 前缀传递)。
  - timeout_ms 是前台等待上限(默认 120000 / 上限 600000),不是杀死超时——到点未退出则命令转入后台继续运行,返回 running 态与 commandId。
  - run_in_background=true 时立即转后台(不等),返回 commandId;命令自然结束后,Runtime 自动把最终输出作为续写消息送回(无需轮询、无需 wait)。
  - 返回正文始终含 commandId(供后续 stop_command 引用)。
示例：run_command(command="npm test", timeout_ms=300000)
      run_command(command="npm run dev", run_in_background=true)
```

**schema**:
| 字段 | 必填 | 默认 | 说明 |
|---|---|---|---|
| `command` | 是 | — | shell 命令(经 redact 进正文) |
| `timeout_ms` | 否 | 120000 | 前台等待上限,上限 600000;到点转后台不杀 |
| `run_in_background` | 否 | false | true=立即转后台返回 commandId |

**tool result 组织**:
- 结构化 ToolResult:`command, commandId, commandState(running/completed/failed/cancelled), elapsedMs, exitCode, mutatedWorkspace, output, outputTruncated`。
- 正文(modelText,reduceToolEvidence 生成,limit 14000)的 **facts 行** = `命令：<redacted>` + **`命令标识：{commandId}`(新增,批次2.5)** + `退出码：{n}`(若已退出)+ `状态：后台运行中`(若 running)+ `裁剪：…`(若超限),后接 middleTruncate 的 output。
- **前台完成**:正文 = 命令 + commandId + 退出码 + 完整 output。
- **转后台(running)**:正文 = 命令 + commandId + `命令仍在后台运行,自然结束后将自动把结果送回` + 已产生的增量 output。
- **退出后续写**(harness 回调注入,role:user):`后台命令 {commandId} 已结束。退出码 {n}。\n{final output}`。

### 2.2 `read_file`(加 cat -n 行号 + offset/limit + 截断标注)

**描述**:
```
用途：读取项目内 UTF-8 文本文件,带行号返回,大文件按 maxChars 截断并明确标注。
适用场景：查看源码/配置/文档;定位行号以引用 file:line、与用户沟通、看 stack trace。
不适用场景：按模式找文件路径(glob)、按内容搜(grep)、编辑后重读验证(edit/multi_edit 成功已返回 unified diff)。
重要：
  - 正文每行带 1 起始行号(cat -n 风格)。
  - maxChars 默认 40000、上限 200000;超过按 maxChars 截断并在末尾标注"[已截断:原文 N 字符,保留 M 字符,可用 offset/limit 读后续]"。
  - 可用 offset(起始行)/ limit(行数)分页读大文件特定区段。
示例：read_file(path="src/index.ts")
      read_file(path="src/index.ts", offset=120, limit=80)
```

**schema**:
| 字段 | 必填 | 默认 | 说明 |
|---|---|---|---|
| `path` | 是 | — | 工作区相对路径 |
| `maxChars` | 否 | 40000 | 上限 200000(描述与实现已对齐) |
| `offset` | 否 | 1 | 1 起始行号 |
| `limit` | 否 | 由 maxChars 推导 | 读取行数 |

**tool result 组织**:正文 = `  {行号}\t{原文}` 逐行 + 末尾截断标注;经 reduceToolEvidence(limit 18000)。read 后仍调 fileState.recordRead 记指纹供 edit 的 stale 检测。

### 2.3 `list_files`(加 depth,默认列一层)

**描述**:
```
用途：以平铺列表列出项目文件,默认只列一层(顶层),可用 depth 控制递归深度。
适用场景：了解项目结构、确认文件存在、开工前摸底。
不适用场景：按模式找特定文件(glob)、读内容(read_file)。
重要：
  - 默认 depth=1(只列顶层),避免大项目一次吃满上限。
  - 自动跳过依赖/构建产物/敏感目录(node_modules、.git、dist、output 等)。
  - maxFiles 默认 200、上限 1000;超过截断并标注。
示例：list_files(depth=2)
```

**schema**:
| 字段 | 必填 | 默认 | 说明 |
|---|---|---|---|
| `depth` | 否 | 1 | 递归层数;`-1` = 全量递归 |
| `maxFiles` | 否 | 200 | 上限 1000 |

**tool result 组织**:正文 = 相对路径换行列表(维持平铺,非树);截断尾附标注。

---

## 三、新增的两个工具

### 3.1 `git_diff`(只读,真实 hunk)

**描述**:
```
用途：只读查看 git 工作区/暂存区的真实改动(unified diff),不产生副作用。
适用场景：提交前自查改动、向用户汇报改了什么、确认 edit/apply_patch 的实际效果。
不适用场景：提交(git_commit)、读单文件全文(read_file)。
重要：
  - 只读,无需审批,不动工作区。
  - 默认显示工作区+暂存区全部改动;可用 path 限定。
  - 大 diff 按上限截断并标注(用 path 收窄)。
示例：git_diff()
      git_diff(path="src/")
```

**schema**:
| 字段 | 必填 | 默认 | 说明 |
|---|---|---|---|
| `path` | 否 | — | 限定文件/目录 |
| `staged` | 否 | false | true=只看暂存区(`--cached`) |

**tool result 组织**:正文 = `git diff` 的 unified diff 输出(经 redact);截断标注。effect=workspace_read,无需审批。

### 3.2 `git_commit`(受审批写操作)

**描述**:
```
用途：把暂存区改动提交为一个 git commit(受审批的写操作)。
适用场景：用户明确要求提交、或一个完整逻辑单元改动已就绪需落检查点。
不适用场景：还没改完(不要中途提交半成品)、用户没要求(不擅自提交)、想看改动(git_diff)。
重要：
  - 受审批(accessMode 非 full_access 时需用户确认)。
  - message 必填且自描述。
  - 不会自动 push(push 是独立操作,需用户明确要求)。
示例：git_commit(message="fix: 编辑失败未回显附近行")
```

**schema**:
| 字段 | 必填 | 默认 | 说明 |
|---|---|---|---|
| `message` | 是 | — | commit message |
| `amend` | 否 | false | 是否 amend 到上次提交 |

**tool result 组织**:正文 = `[{branch} {sha7}] {摘要}`;失败 isError=true。effect=workspace_write,走 workspaceMutationCoordinator。

---

## 四、harness 回调机制(批次 3.1b,砍 wait 的前提)

> 这是架构改动,不是工具。落地后才允许删 wait_command。

**机制(镜像现有 delegation 异步等待模式)**:

1. 新增 `commandManager.waitForSettled(runId): Promise<SettledCommand[]>`——语义与现有 `delegations.waitForResult(runId)` 同构。
2. runner 主循环改动:模型无 tool_calls 且仍有活跃后台命令时,**把现在 completionGate 的 `running_commands` 重试(逼模型调 wait/stop)替换为**:
   ```ts
   await commandManager.waitForSettled(runId);   // 镜像 runner.ts:609-613 的 delegations.waitForResult
   applySettledCommandResults(...)               // 把每个刚 settled 命令的最终输出作为 role:user 续写注入
   continue;
   ```
3. `onSettled`(commandManager.ts:281)在 settle 时 resolve 该 promise(若该 run 正在 await)。
4. completionGate 的 `running_commands` 分支要么删除(由 await 接管),要么保留为安全网但**改文案**,不再提 wait/stop。

**效果**:退出型后台命令的结果自动回到模型,无需 wait_command 轮询。这是砍 wait 的充要条件。

---

## 五、维持不变的 17 个工具(已落地批次不再动)

| 工具 | 一句话 | 状态 |
|---|---|---|
| `write_file` | 用完整内容创建/覆盖文件 | 维持 |
| `edit_file` | oldText→newText 精确替换(strict→relaxed),失败已回显附近行 | 批次2.1 已落地 |
| `multi_edit` | 单文件多编辑原子批量,失败已回显 | 批次2.1 已落地 |
| `apply_patch` | 跨文件 apply_patch 原子事务,失败已回显 | 批次2.1 已落地 |
| `glob` | minimatch 路径匹配,dot:true 可见点文件 | 批次2.2 已落地 |
| `grep` | 内容正则搜索(四档输出),dot:true | 批次2.2 已落地 |
| `search_memory` | 只读查结构化记忆 | 维持 |
| `save_memory` | 保存结构化记忆(缓存保护,不刷当前信封) | 批次2.4 已落地 |
| `submit_plan` | 提交计划等审批 | 维持 |
| `update_tasks` | 维护任务清单 | 维持 |
| `delegate` | 委派子代理(explorer/worker) | 维持(批次3.3 可加 reviewer 角色) |
| `ask_user` | 提 1~3 个选择题 | 维持 |
| `enter_plan` | 请求进计划模式 | 维持 |
| `web_search` | 联网搜索 | 维持 |
| `fetch_url` | 抓 URL 转 markdown | 维持 |
| `run_skill_script` | 跑已信任 skill 的 .mjs 脚本 | 维持 |
| `materialize_skill_asset` | 复制 skill 资源文件到工作区 | 维持 |

---

## 六、待你拍板的分叉

**`stop_command`:留还是砍?**

- **留(推荐)**:非退出型命令(dev server)必须有模型可触达的杀命令途径。修 commandId 进正文(批次2.5)后,模型能精准指定要杀的命令。
- **砍**:接受"模型启动的后台服务只能由用户在 UI 杀"(HTTP `/api/commands/:id/stop` 已存在,UI 可用)。工具数再 −1。代价:模型失去中途放弃错误命令的能力。

## 七、不在本稿范围(批次 3.4 / 3.5,结构性,后续单独设计)

- 沙盒(protected paths + 网络独立开关 + Windows 平台隔离方案选型)
- 代码智能层(LSP 符号定义/引用/类型错误)
