# ADR-007: 上下文分层架构与加载机制

> Status: Proposed
> Date: 2026-07-23
> Supersedes: ADR-003 (Context Operating System) 的信封渲染部分(不废弃 ADR-003 的压缩/检查点设计)

## 一、背景与动机

### 1.1 当前架构的问题

当前 `contextBuilder.ts` 的 `prepareSessionContext` 是一个 197 行单体函数,把五件不同的事混在一起:

1. **信封渲染**(stable_session_context / mode_context / recovery_capsule)
2. **压缩决策**(token 估算、保护集选择、checkpoint 构建)
3. **消息序列拼装**(messages 数组)
4. **遥测统计**(ContextStats / sections / events)
5. **持久化记录合成**(sessionEnvelopeRecord / recoveryRecord)

具体缺陷:

- **revision hash 不完整**:`<stable_session_context revision="...">` 只哈希了 `guidance.revisionHash`,但信封内容还包含 `date`、`memoryIndex`、`capabilityIndex`、`skillIndex`——这些变化不会反映到 revision 上
- **frozen 复用无验证**:恢复已存 `session_context` 记录时不校验 hash 是否匹配当前输入,AGENTS.md 编辑后静默忽略
- **双消息拼装**:`initialMessages`(379-387 行)和最终 `messages`(412-420 行)近乎重复,前者仅用于 token 估算
- **5 种信封标签各自为政**:`<stable_session_context>` / `<compaction_checkpoint>` / `<mode_context>` / `<recovery_capsule>` / 裸文本 `context_update`,没有统一的注入标签和语义
- **缓存断点缺失**:`cacheClass` 字段只用于遥测标签,没有预留 `cache_control` 扩展位(未来接入 Anthropic 时需要)

### 1.2 对标调研结论

详见 `docs/context-loading-comparison.md`。核心发现:

| 维度 | 行业共识(三家一致) |
|---|---|
| **AGENTS.md 位置** | 不放 system prompt,放 user message(cache breakpoint 之后) |
| **AGENTS.md 冻结** | 会话期间不重载(编辑后模型看不到,直到 restart/compaction) |
| **系统提示词稳定性** | 编译时固定,字节级稳定(prefix cache 命中) |
| **工具描述位置** | API `tools` 参数,不在 prompt 文本里 |
| **运行时注入标签** | ZCode 和 Claude Code 用 `<system-reminder>`,Codex 用 XML fragment |
| **缓存机制** | DeepSeek/OpenAI 全自动隐式;Anthropic 显式断点 + 自动 |

### 1.3 设计目标

1. **显式分层**:把 5 层上下文(Kernel / Session / Checkpoint / Trajectory / Runtime)拆为独立 builder,每层有明确的缓存策略和变化频率
2. **统一标签**:所有运行时注入用 `<system-reminder type="...">` 统一格式(对标 ZCode/Claude Code)
3. **hash 完整化**:信封 revision 纳入全部可变内容(environment + indexes + guidance)
4. **缓存预留**:在类型系统中预留 `cacheControl` 扩展位(当前 DeepSeek 不用,未来 Anthropic 需要)
5. **可观测**:每层的 token 估算、缓存类、survival 标记独立可查

---

## 二、5 层上下文模型

### 2.1 层定义

从第一性原理推导:上下文中的每一条信息,要么是"永不变的"、"会话级稳定的"、"压缩时变的"、"每轮增长的"、或"每轮可能变的"。按变化频率从低到高分 5 层:

```
┌─────────────────────────────────────────────────────────────────────┐
│ L0 Kernel                                                           │
│ system message · 编译时固定 · cacheClass: stable                     │
│                                                                     │
│   prompts.compileSystem() → 7 slots 拼接                            │
│   identity / coding_behavior / tool_policy / plan_policy            │
│   / doing_tasks / output_style / final_response                     │
│                                                                     │
│   变化频率: 永不变化(只有升级代码才变)                                │
│   缓存策略: 永久缓存命中                                             │
├─────────────────────────────────────────────────────────────────────┤
│ L1 Session-Stable                                                   │
│ user message · 会话级冻结 · cacheClass: session_stable               │
│                                                                     │
│   <system-reminder type="context">                                  │
│     <environment>{cwd, platform, shell, locale, date, model}</environment> │
│     <project-instructions>AGENTS.md 规则全文</project-instructions>  │
│     <memory-index>记忆事实索引</memory-index>                        │
│     <capability-index>能力索引</capability-index>                    │
│     <skill-index>技能索引</skill-index>                              │
│   </system-reminder>                                                │
│                                                                     │
│   变化频率: 会话开始时生成,之后 frozen(直到 compaction 重建)         │
│   缓存策略: 会话级缓存(同一天内稳定命中;跨天 date 变化致失效一轮)    │
│   特殊: revision hash 纳入全部可变内容,可检测漂移                    │
├─────────────────────────────────────────────────────────────────────┤
│ L2 Checkpoint                                                       │
│ user message · 压缩级稳定 · cacheClass: compaction_stable            │
│                                                                     │
│   <system-reminder type="checkpoint">                               │
│     {objective, constraints, decisions, changes, tasks, ...}        │
│   </system-reminder>                                                │
│                                                                     │
│   变化频率: 每次压缩(compaction)时更新                               │
│   缓存策略: 压缩级缓存(两次压缩之间稳定命中)                         │
├─────────────────────────────────────────────────────────────────────┤
│ L3 Trajectory                                                       │
│ mixed messages · append-only · cacheClass: dynamic                   │
│                                                                     │
│   历史对话记录(经 protocolSafeModelMessages 处理):                    │
│     human_text → {role: "user"}                                     │
│     agent_text → {role: "assistant"}                                │
│     tool_result → {role: "tool"}                                    │
│     context_update → {role: "user"} (内联在历史中)                   │
│                                                                     │
│   变化频率: 每轮增长(append-only)                                    │
│   缓存策略: 前缀隐式缓存(只要前面不变,旧部分自动命中)                │
├─────────────────────────────────────────────────────────────────────┤
│ L4 Runtime-Dynamic                                                  │
│ user messages · 每轮可能变 · cacheClass: dynamic                     │
│                                                                     │
│   <system-reminder type="recovery">中断恢复事实</system-reminder>    │
│   <system-reminder type="mode">当前模式+计划状态</system-reminder>   │
│                                                                     │
│   变化频率: 每轮可能变化                                             │
│   缓存策略: 不缓存(ephemeral)                                       │
├─────────────────────────────────────────────────────────────────────┤
│ User Input                                                          │
│ user message · 每轮变化                                              │
│                                                                     │
│   用户最新输入(如果是新轮次)                                        │
└─────────────────────────────────────────────────────────────────────┘
```

### 2.2 消息序列(模型实际看到)

```
messages[0]     system    ← L0 Kernel
messages[1]     user      ← L1 <system-reminder type="context"> (frozen)
messages[2]     user      ← L2 <system-reminder type="checkpoint"> (如有)
messages[3..N]  mixed     ← L3 对话轨迹 (history + inline context_update)
messages[N+1]   user      ← L4 <system-reminder type="recovery"> (如有)
messages[N+2]   user      ← L4 <system-reminder type="mode">
messages[last]  user      ← 用户输入
```

### 2.3 与当前架构的差异

| 维度 | 当前 | 重构后 |
|---|---|---|
| **信封标签** | `<stable_session_context>` / `<mode_context>` / `<recovery_capsule>` / `<compaction_checkpoint>` | 统一 `<system-reminder type="context\|mode\|recovery\|checkpoint\|guidance">` |
| **revision hash** | 只哈希 guidance | 哈希 guidance + environment + indexes |
| **frozen 验证** | 无(直接复用文本) | hash 校验(不匹配时重新生成) |
| **函数结构** | 1 个 197 行单体 | 5 个层 builder + 1 个编排函数 |
| **token 估算** | 拼装临时 messages 数组再估算 | 从 records 直接估算(不拼装临时数组) |
| **cache_control** | 无 | 类型预留 `cacheControl?` 字段 |

---

## 三、类型系统设计

### 3.1 新增类型(`shared/contracts/context.ts`)

```typescript
/** 上下文层标识 */
export type ContextLayerId = "kernel" | "session" | "checkpoint" | "trajectory" | "runtime";

/** 系统提醒标签类型 — 统一替换原有 XML 信封标签 */
export type SystemReminderType = "context" | "checkpoint" | "mode" | "recovery" | "guidance";

/** 缓存控制标记(预留,当前 DeepSeek 不用,Anthropic 需要) */
export type CacheControl = { type: "ephemeral"; ttl?: "1h" };

/** 单层的构建结果 */
export type ContextLayerResult = {
  layer: ContextLayerId;
  messages: ModelMessage[];
  cacheClass: "stable" | "session_stable" | "compaction_stable" | "dynamic";
  cacheControl?: CacheControl;           // 预留扩展位
  survivesCompaction: boolean;
  estimatedTokens: number;
  revisionHash?: string;                 // 该层的完整内容指纹
};
```

### 3.2 统一标签构建器(`shared/domain/context.ts`)

```typescript
/** 构建统一格式的 system-reminder 消息文本 */
export function systemReminder(type: SystemReminderType, body: string): string {
  return `<system-reminder type="${type}">\n${body}\n</system-reminder>`;
}

/** 构建带 revision 指纹的 system-reminder(用于 L1 session 层) */
export function systemReminderWithRevision(
  type: SystemReminderType,
  revision: string,
  body: string
): string {
  return `<system-reminder type="${type}" revision="${revision}">\n${body}\n</system-reminder>`;
}
```

### 3.3 标签映射(激进切换)

| 旧标签 | 新标签 |
|---|---|
| `<stable_session_context revision="...">` | `<system-reminder type="context" revision="...">` |
| `<stable_environment>{...}` | `<environment>{...}</environment>` (内层不变) |
| `<memory_index>` | `<memory-index>` (连字符统一) |
| `<capability_index>` | `<capability-index>` |
| `<skill_index>` | `<skill-index>` |
| `<compaction_checkpoint through_sequence="N">` | `<system-reminder type="checkpoint" through_sequence="N">` |
| `<mode_context mode="..." plan_entry="...">` | `<system-reminder type="mode" mode="..." plan_entry="...">` |
| `<recovery_capsule>` | `<system-reminder type="recovery">` |
| context_update 裸文本 | `<system-reminder type="guidance">` |

### 3.4 向后兼容

- **ContextEntry.kind 不变**:`session_context` / `checkpoint` / `recovery_capsule` / `context_update` / `mode_context` 的存储格式不变
- **存储层无感知**:持久化的是 ContextEntry(结构化数据),不是标签文本。标签只在渲染为消息时生成
- **旧记录兼容**:`protocolSafeModelMessages` / `modelMessageFromEntry` 同时识别新旧标签格式(双标签识别期),确保存量会话不中断
- **BuildInput / BuiltContext 保持兼容**:新增字段用 optional,不破坏现有消费者

---

## 四、层 Builder 设计

### 4.1 L0 Kernel Builder

```typescript
function buildKernelLayer(model: string): ContextLayerResult {
  const blueprint = prompts.compileSystem(model);
  return {
    layer: "kernel",
    messages: [{ role: "system", text: blueprint.text }],
    cacheClass: "stable",
    cacheControl: { type: "ephemeral" },     // 预留:未来 Anthropic 用
    survivesCompaction: true,
    estimatedTokens: estimateTokens(blueprint.text),
    revisionHash: blueprint.hash
  };
}
```

### 4.2 L1 Session-Stable Builder

```typescript
function buildSessionLayer(
  input: BuildInput,
  guidance: ResolvedRule[]
): ContextLayerResult {
  const env = {
    projectRoot: input.projectRoot,
    platform: context.platform,
    shellFamily: context.shellFamily,
    locale: context.locale,
    date: new Date().toISOString().slice(0, 10),
    model: input.model,
    app: "DeepSeeker CodeAgent"
  };
  const guidanceText = (input.rules ?? emptyRuleSource).render(guidance, "stable");
  const memory = input.memoryIndex?.trim() || "No curated memory facts are active.";
  const capability = input.capabilityIndex?.trim() || "...";
  const skill = input.skillIndex?.trim() || "...";

  const body = [
    `<environment>${escapeEnvelopeText(JSON.stringify(env))}</environment>`,
    guidanceText,
    `<memory-index>${escapeEnvelopeText(memory)}</memory-index>`,
    `<capability-index>${escapeEnvelopeText(capability)}</capability-index>`,
    `<skill-index>${escapeEnvelopeText(skill)}</skill-index>`
  ].filter(Boolean).join("\n");

  // 完整 revision: guidance + environment + indexes 全部纳入
  const revision = createHash("sha256").update(
    [guidance.map(g => g.revisionHash).join(":"),
     JSON.stringify(env),
     memory, capability, skill
    ].join("\n")
  ).digest("hex");

  return {
    layer: "session",
    messages: [{ role: "user", text: systemReminderWithRevision("context", revision, body) }],
    cacheClass: "session_stable",
    cacheControl: { type: "ephemeral" },     // 预留
    survivesCompaction: true,
    estimatedTokens: estimateTokens(body),
    revisionHash: revision
  };
}
```

### 4.3 L2 Checkpoint Builder

```typescript
function buildCheckpointLayer(checkpoint?: Checkpoint): ContextLayerResult {
  if (!checkpoint) return { layer: "checkpoint", messages: [], cacheClass: "compaction_stable", survivesCompaction: true, estimatedTokens: 0 };
  const text = systemReminder("checkpoint", escapeEnvelopeText(JSON.stringify(checkpoint)));
  return {
    layer: "checkpoint",
    messages: [{ role: "user", text }],
    cacheClass: "compaction_stable",
    cacheControl: { type: "ephemeral" },
    survivesCompaction: true,
    estimatedTokens: estimateTokens(text)
  };
}
```

### 4.4 L3 Trajectory Builder

```typescript
function buildTrajectoryLayer(records: ContextEntry[]): ContextLayerResult {
  const messages = protocolSafeModelMessages(records);
  return {
    layer: "trajectory",
    messages,
    cacheClass: "dynamic",
    survivesCompaction: false,
    estimatedTokens: messages.reduce((sum, m) => sum + estimateTokens(JSON.stringify(m)), 0)
  };
}
```

### 4.5 L4 Runtime-Dynamic Builder

```typescript
function buildRuntimeLayer(
  input: BuildInput,
  session: Session
): ContextLayerResult {
  const messages: ModelMessage[] = [];

  // 恢复信封(如有)
  const resume = recoveryFor(session, input.prompt);
  if (resume) {
    messages.push({ role: "user", text: systemReminder("recovery", recoveryBody(resume)) });
  }

  // 模式信封(仅新轮次)
  if (!input.latestUserInRecords) {
    messages.push({ role: "user", text: systemReminder("mode", modeBody(session)) });
  }

  // 用户输入(仅新轮次)
  if (!input.latestUserInRecords) {
    messages.push({ role: "user", text: input.prompt });
  }

  return {
    layer: "runtime",
    messages,
    cacheClass: "dynamic",
    survivesCompaction: false,      // 注意:latest_user 标记为 survivesCompaction
    estimatedTokens: messages.reduce((sum, m) => sum + estimateTokens(m.text ?? ""), 0)
  };
}
```

### 4.6 编排函数

```typescript
export function prepareSessionContext(input: BuildInput): BuiltContext {
  // 1. 构建 L0 + L1
  const kernel = buildKernelLayer(input.model);
  const startupGuidance = (input.rules ?? emptyRuleSource).resolve({ phase: "session_start", projectRoot: input.projectRoot });

  // 2. 获取/验证 frozen envelope
  const prior = latestCheckpoint(input.records);
  const existingEnvelope = [...input.records].reverse().find(r => r.kind === "session_context" && r.text);

  // 3. 过滤 post-checkpoint records
  const afterCheckpoint = input.records.filter(r =>
    !["checkpoint", "session_context", "recovery_capsule", "runtime_fact"].includes(r.kind) &&
    r.sequence > (prior.checkpoint?.compactedThroughSequence ?? 0)
  );

  // 4. 从 records 直接估算 token(不拼装临时 messages)
  const estimatedInputTokens = estimateRecordsTokens(afterCheckpoint, input.tools);

  // 5. 压缩决策 + 执行(逻辑不变,只是用新估算)
  const { retainedRecords, dropped, checkpoint } = decideCompaction(input, afterCheckpoint, prior, estimatedInputTokens);

  // 6. 构建 L1(如有 dropped 则重建;否则验证 hash 后复用)
  const session = (dropped.length > 0 || !existingEnvelope || hashMismatch(existingEnvelope, input, startupGuidance))
    ? buildSessionLayer(input, startupGuidance)
    : reuseExistingSessionLayer(existingEnvelope);

  // 7. 构建其余层
  const checkpointLayer = buildCheckpointLayer(checkpoint ?? prior.checkpoint);
  const trajectory = buildTrajectoryLayer(retainedRecords);
  const runtime = buildRuntimeLayer(input, input.session);

  // 8. 拼装最终 messages
  const messages = [
    ...kernel.messages,
    ...session.messages,
    ...checkpointLayer.messages,
    ...trajectory.messages,
    ...runtime.messages
  ];

  // 9. 遥测 + 持久化记录合成(逻辑不变)
  // ...

  return { messages, ... };
}
```

---

## 五、AGENTS.md 加载机制(不变,确认正确)

基于调研结论,当前 AGENTS.md 的加载策略**已是行业最佳实践**,不需要改变:

| 决策 | 当前做法 | 行业共识 | 结论 |
|---|---|---|---|
| **位置** | L1 Session 层(messages[1] user 信封内) | user message(cache breakpoint 之后) | ✅ 正确 |
| **冻结** | 会话开始时读取一次,frozen | 会话期间不重载 | ✅ 正确 |
| **编辑检测** | 不检测(无 mtime watcher) | 三家都不检测(或只在 cwd 变化时) | ✅ 正确 |
| **压缩重建** | compaction 时重新 resolve + 渲染 | compaction 时重建 | ✅ 正确 |
| **渐进披露** | 路径级 guidance 通过 context_update 延迟注入 | Claude Code 子目录 CLAUDE.md 延迟加载 | ✅ 我们更完善 |

**唯一增强点(可选,非必须)**:revision hash 完整化后,可以在 `prepareSessionContext` 入口处检测 AGENTS.md 文件 mtime 是否变化,如果变化则输出一条 telemetry warning(不自动重载,只记录)。这给了可观测性但不增加复杂度。

---

## 六、缓存策略

### 6.1 当前(DeepSeek)

DeepSeek 的 [Context Caching on Disk](https://api-docs.deepseek.com/guides/kv_cache/) 全自动,无需客户端干预。我们的消息序列已经是最优布局:

```
[system L0]          ← 永不变 → 隐式缓存命中
[session L1]         ← frozen → 隐式缓存命中(跨天 date 变化致失效一轮)
[checkpoint L2]      ← 压缩间不变 → 隐式缓存命中
[trajectory L3]      ← append-only → 旧部分隐式缓存命中
[runtime L4]         ← 每轮变 → 不缓存
[user input]         ← 每轮变 → 不缓存
```

### 6.2 未来(Anthropic)

如果接入 Anthropic 模型,在 Provider 请求构建层读取 `ContextLayerResult.cacheControl` 字段:

```typescript
// AnthropicProvider.stream() 中
const systemBlocks = layers
  .filter(l => l.layer === "kernel" || l.layer === "session")
  .map(l => ({
    type: "text",
    text: l.messages[0].text,
    ...(l.cacheControl ? { cache_control: l.cacheControl } : {})
  }));
```

`cacheControl` 字段已在类型中预留,实现时不需要改 contextBuilder 核心。

### 6.3 prefixHash 计算

```
prefixHash = sha256([
  toolSpecs JSON,
  kernel.revisionHash,        // blueprint hash
  session.revisionHash,       // 完整 revision(guidance + env + indexes)
  checkpointLayer.text ?? ""  // checkpoint 序列化
].join("\n"))
```

这个 hash 用于遥测,检测前缀是否发生变化。

---

## 七、实施路径

### Phase 1: 类型系统 + 标签构建器(低风险)
- `shared/contracts/context.ts` 新增 `ContextLayerId` / `SystemReminderType` / `CacheControl` / `ContextLayerResult`
- `shared/domain/context.ts` 新增 `systemReminder()` / `systemReminderWithRevision()`
- 不改现有逻辑,只加新能力

### Phase 2: 层 Builder 拆分(中风险)
- `contextBuilder.ts` 拆出 `buildKernelLayer` / `buildSessionLayer` / `buildCheckpointLayer` / `buildTrajectoryLayer` / `buildRuntimeLayer`
- `prepareSessionContext` 变为编排函数
- revision hash 完整化
- frozen 复用 hash 验证

### Phase 3: 标签迁移(中风险)
- 所有信封渲染从 XML 标签改为 `<system-reminder>`
- `identity` slot 更新信封声明(从列举 XML 标签名改为 `<system-reminder>` 统一术语)
- `protocolSafeModelMessages` / `modelMessageFromEntry` 双标签识别(兼容存量记录)
- 测试断言更新

### Phase 4: 验证 + 清理(低风险)
- `npm run build && npm test` 全量验证
- 清理死代码(`mode_context` / `runtime_fact` 半接线路径)
- 更新 `docs/context-loading-comparison.md` 标注实施完成

---

## 八、验证标准

- [ ] `npm run build` 通过(TS 0 错误)
- [ ] `npm test` 全绿(现有 210 tests + 新增层 builder 单元测试)
- [ ] 新消息序列与 §2.2 设计图一致
- [ ] revision hash 能检测 environment/index/guidance 变化
- [ ] 旧标签记录仍能正确渲染(向后兼容)
- [ ] `cacheControl` 字段预留但当前不影响行为

---

## 九、与 ADR-003 的关系

ADR-003(Context Operating System)定义了:
- ✅ 前缀缓存友好布局(本 ADR 继承)
- ✅ 双阶段压缩(deterministic + semantic)(本 ADR 不改)
- ✅ 恢复胶囊(本 ADR 改标签,不改逻辑)
- ✅ 85% 压缩阈值(本 ADR 不改)
- ✅ curated MemoryFact(本 AIR 不改)

本 ADR-007 只重构**信封渲染层和消息拼装层**,不改变 ADR-003 的压缩策略、检查点结构、记忆管理。
