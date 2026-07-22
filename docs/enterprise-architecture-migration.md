# 企业架构整理迁移记录

## 目标与约束

本轮整理不重写产品、不拆微服务、不替换 SQLite，保持现有 Session/Run/Activity 行为、历史 replay、工具开始/完成配对和托管命令语义。

## 已完成

- 建立测试、类型检查、构建与架构边界基线。
- Event 改为 type/payload discriminated union；增加运行时 schema 和穷尽 reducer。
- 保留 V1 decoder 与真实历史 fixture；SQLite 继续作为唯一权威。
- 将 Context 纯逻辑、时间/UUID、证据处理移出 contract/domain 错误边界。
- 新 Activity Event 不再持久化 `title/displayTarget/groupMode/importance/detail`；projection 兼容旧历史并从事实推导新展示。
- 将 Runtime 存储拆为 Session/Event/Context/Evidence/Memory/Metric Port，Application 仅依赖最小交集。
- 抽出 StartRun、RunLauncher、CancelRun、SessionService、ContextQueries 和 WorkspaceQueries。
- HTTP 移除对 RuntimeStore、文件系统和 CommandManager 的直接依赖。
- 工具基础设施拆出安全边界、Shell 执行和摘要能力。
- 前端增加唯一 SessionEventStore，统一 REST snapshot 与 SSE Event 演进，并建立 app/features/shared-ui 层。
- 增加 ADR、工程落位规范和 GitHub Actions 门禁。

## 兼容策略

数据库格式不做破坏性重写。历史展示字段保持 optional legacy read；V1 仅在 decoder 中归一化。任何阶段都可用当前 SQLite 数据启动并 replay。

## 回滚策略

代码回滚必须保留当前 V2 decoder 与 SQLite migration 目录。若只回滚 UI，可继续消费相同 Event；若回滚 Runtime，应先复制 `runtime.sqlite`，并确认目标版本认识所有已写 Event type。禁止用旧版本覆盖数据库后再双向运行。

## 后续演进触发条件

- 当独立模块需要独立发布、扩缩容或故障隔离，并有可度量收益时，才评估进程/服务拆分。
- 当工具注册继续增长时，按 file/search/mutation/command/capability 拆 registry 与 executor；保持 ToolHost Port 不变。
- 前端新功能必须直接进入 `src/features/<feature>`，旧 `src/components` 以触及即迁移方式逐步收敛。
