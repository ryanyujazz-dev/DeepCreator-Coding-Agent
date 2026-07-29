# ADR 006：企业级模块化单体与工程边界

## 状态

已接受，2026-07-22。

## 背景

DeepCreator 已具备完整的本地 CodeAgent 闭环。当前约束是单机部署、单进程 Runtime、SQLite 持久化和 HTTP/SSE 本地边界。主要风险不是吞吐量，而是协议、业务编排、基础设施和展示逻辑互相渗透后，任何修改都需要全链路联动。

从第一性出发，架构必须优先保护四件事：唯一事实来源、变化隔离、可验证行为和历史兼容。微服务、消息中间件、第二套数据库或重写不会改善这些根因，反而会增加一致性与运维成本。

## 决策

1. 继续采用本地模块化单体，SQLite 是唯一持久化权威；不引入双写、分布式事务或微服务。
2. 依赖方向固定为 `bootstrap -> transport/infra -> app -> domain/contracts`。`bootstrap` 只组装，`transport` 只映射协议，`app` 负责编排用例，`domain` 负责纯规则，`infra` 负责外部技术细节。
3. Event 以 `EventPayloadMap` 为唯一编译期 payload 权威，并在解码边界执行运行时 schema 校验；reducer 必须穷尽处理 discriminated union。
4. 新 Event 只记录可重放事实。渲染标题、展示目标、分组、重要度和展开策略由 `shared/projections` 推导。历史 `title/displayTarget` 继续只读兼容。
5. Runtime 存储能力拆为 `SessionPort`、`EventPort`、`ContextPort`、`EvidencePort`、`MemoryPort`、`MetricPort`。SQLite 实现可以同时实现所有端口，但用例只能依赖其实际使用的最小交集。
6. HTTP 不依赖具体基础设施。会话命令、Run 启动/取消、上下文查询和工作区查询通过 Application 服务执行。
7. 前端 Session 状态只有一个权威 `SessionEventStore`：REST snapshot 只能前进替换，SSE Event 只能通过共享 reducer 演进。
8. 架构边界、类型检查、测试和构建全部纳入 CI 合并门禁。

## 兼容与迁移

- V1 只经 `shared/legacy` 解码，活动代码不得重新引入 V1 词汇。
- V2 历史 Event 中已有的展示字段继续被 projection 识别；新写入不再产生这些字段。
- SQLite migration 必须有序、幂等、前向兼容，并在真实历史 fixture 上验证 replay。
- 每次重构保持部署单元和数据格式可运行，不做“大爆炸”目录重写。

## 后果

新增传输、Provider、存储实现或 UI 形态时，只需实现稳定端口或 projection。代价是需要维护明确边界和少量适配代码；这是可测试的显式成本，优于隐式耦合。

## 不做

- 不按技术名词拆微服务。
- 不引入 ORM/CQRS 框架替代当前清晰的 Event + projection 机制。
- 不让 UI 标签参与业务判断或持久化身份。
- 不让 Application 用例直接导入 Fastify、SQLite、Node 文件系统或进程实现。
