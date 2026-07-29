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
- 工具基础设施拆出安全、文件、搜索、网络、Git 变更、Shell、摘要和声明式 registry；`tools.ts` 仅保留执行编排与展示投影。
- 前端增加唯一 SessionEventStore，统一 REST snapshot 与 SSE Event 演进，并建立 app/features/shared-ui 层；Surface 状态机和 Runtime 观察器已从入口编排迁入 feature hook。
- 增加 ADR、工程落位规范和 GitHub Actions 门禁。
- 将 TypeScript 拆成 shared、server、renderer、desktop、tooling、tests 六个独立工程，防止 Node/DOM 类型跨层泄漏。
- 为 REST 与 SSE 建立共享 schema 和客户端解码器，Provider 原生流统一收敛到兼容层。
- 将 Runner 拆出完成门、模型流、Provider 恢复、上下文准备和工具步骤执行，并通过 SystemPort 注入执行链的时间与 ID。
- 将 Runtime 重启收敛为单一恢复用例，并暴露 migration、旧数据导入、运行中断和工具协议修复报告。
- 为 renderer 建立 platform 边界和重量级功能懒加载，首屏不再同步加载 Monaco、Mermaid 与 Lottie。
- 建立语义颜色的新样式入口和受控 legacy CSS 债务门禁，浅色与暗色主题必须通过同一语义 token 映射；工作区表面、主题编辑、思考动效与暗色交互审计已迁入独立 feature stylesheet。
- Application 的时间与 ID 全部通过 `SystemPort` 注入；稳定摘要算法进入平台无关 domain，`server/app` 不再引用 Node API、平台全局或直接时钟。
- 用户配置由宿主一次性解析后注入 Runtime；项目 `.env.local` 不再自动加载，默认模型统一持久化到 `~/.deepcreator/config.json`，损坏配置会明确报错且不会被静默覆盖。
- 增加零警告 lint、生产依赖审计和统一 `npm run check` 验收入口。

## 兼容策略

数据库格式不做破坏性重写。历史展示字段保持 optional legacy read；V1 仅在 decoder 中归一化。任何阶段都可用当前 SQLite 数据启动并 replay。

## 回滚策略

代码回滚必须保留当前 V2 decoder 与 SQLite migration 目录。若只回滚 UI，可继续消费相同 Event；若回滚 Runtime，应先复制 `runtime.sqlite`，并确认目标版本认识所有已写 Event type。禁止用旧版本覆盖数据库后再双向运行。

## 后续演进触发条件

- 当独立模块需要独立发布、扩缩容或故障隔离，并有可度量收益时，才评估进程/服务拆分。
- 当工具目录继续增长时，按能力域拆分 registry 数据文件；保持统一 registry 导出和 ToolHost Port 不变。
- 前端新功能必须直接进入 `src/features/<feature>`，旧 `src/components` 以触及即迁移方式逐步收敛。
