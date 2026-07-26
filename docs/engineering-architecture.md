# 工程架构及代码落位规范

本文是新增代码和评审的规范性入口。关键词“必须/不得/应当”用于代码评审与 CI 门禁。

## 1. 架构原则

系统是一个可分模块但共同部署的产品。优先级依次是：行为正确与可恢复、单一事实来源、边界稳定、可测试、可观测，最后才是局部代码简短。

```text
desktop / bootstrap
        │ 组装
        ▼
transport ───────► application ports ◄────── infra
                         │
                         ▼
                 domain + contracts
                         │
                         ▼
                    projections ─────► frontend
```

依赖箭头只能向下或指向端口。Domain、contracts 和 application 不得反向导入 infra；transport 不得导入具体 infra 类。

## 2. 目录与职责

| 目录 | 放置内容 | 不得放置 |
| --- | --- | --- |
| `shared/contracts` | 可序列化领域/Wire 类型 | Node API、React、渲染策略、随机数/时间调用 |
| `shared/schemas` | Wire 边界运行时校验 | 业务编排、数据库规则 |
| `shared/domain` | 纯 reducer、状态机、跨端规则 | I/O、UI 文案、Provider 字段 |
| `shared/projections` | 从事实推导的 timeline/group/label | 持久化写入、HTTP 调用 |
| `server/app` | 一个用户意图对应的 use case、Port | SQL、Fastify、文件系统、子进程实现 |
| `server/domain` | 服务端纯策略 | I/O 与框架对象 |
| `server/infra` | SQLite、Provider、文件、命令、能力实现 | HTTP 状态码、React 状态 |
| `server/transport` | schema、认证、HTTP/SSE 映射 | 业务分支、文件访问、具体存储类 |
| `server/bootstrap` | 实例化与生命周期 | 业务规则 |
| `src/app` | 前端装配和页面壳 | 通用组件实现 |
| `src/features/<feature>` | 按业务能力组织的状态、API、组件 | 跨 feature 的无约束深层导入 |
| `src/shared-ui` | 无业务知识的可复用 UI 原语 | Runtime API、Event 业务判断 |

宿主配置只允许在 `server/bootstrap/main.ts` 或桌面主进程解析一次。`startRuntime` 等可复用组装函数只接收已经解析的值；不得读取用户配置、项目 `.env.local` 或 `process.env`。

## 3. 新代码放哪里

按以下顺序判断：

1. 它是不是跨进程/网络可见的数据？放 `shared/contracts`，并在 `shared/schemas` 校验。
2. 它是不是给定输入即可确定输出的规则？放 `shared/domain` 或 `server/domain`。
3. 它是不是完成一个用户意图、需要协调多个端口？放 `server/app/<VerbNoun>.ts`。
4. 它是不是 SQL、文件、网络、时钟、UUID、Provider 或进程细节？放 `server/infra` 并实现 app Port。
5. 它是不是 HTTP 状态码、Header、SSE framing？放 `server/transport`。
6. 它是不是从 Event/Session 推导展示？放 `shared/projections`。
7. 它是不是某个前端业务能力？放 `src/features/<feature>`；纯视觉原语放 `src/shared-ui`。

如果一个文件同时回答两个以上问题，先拆职责再落位。

## 4. Event 与状态规范

- `EventPayloadMap` 是 Event type 与 payload 的唯一类型映射；不得用 `unknown` + cast 绕过。
- 所有外部或历史 Event 必须经过 `eventSchema`。
- reducer 必须以 `assertNever` 保持穷尽。
- Event 只写重放所需事实；不得写 rendered label、group、expanded、importance、detail policy。
- UI 不得从文案反推执行状态。执行状态只来自 Event reducer。
- REST snapshot 的 offset 小于客户端当前 offset 时必须丢弃。

## 5. Port 与用例规范

- Port 按能力命名并保持最小：`SessionPort`、`EventPort` 等。
- 用例声明所需 Port 的交集，不得依赖全能 Repo。
- Port 接受/返回领域类型，不暴露 Fastify request、SQL row 或 Provider 原生结构。
- 时间、ID、工作区和命令控制通过 Port 注入；核心行为应可用内存替身测试。
- 一个路由出现活动 Run 判断、权限/模式转换、多个持久化调用或文件访问时，必须抽成用例。

## 6. 命名与文件规范

- 类型/类/React 组件用 `PascalCase`；函数、变量、文件用 `camelCase`；既有组件文件保持 `PascalCase.tsx`。
- 用例优先使用动词名：`StartRun`、`CancelRun`；能力边界使用名词 + `Port`。
- `Manager/Helper/Utils` 只有在职责确实无法更准确表达时才允许。
- 一个文件应有一个主要变化原因。超过约 400 行或包含三个独立 I/O 能力时，评审必须说明不拆分的理由。
- 大型声明式目录（例如工具 JSON Schema）可独立成 registry，但 executor、presentation 和具体 I/O 实现必须分离。
- 兼容代码必须位于 `legacy`/migration 边界，并带删除条件。

## 7. 测试规范

- 纯规则：同目录概念对应的 `node:test` 单元测试。
- Application use case：使用 fake Port 或真实临时 SQLite，验证行为而非框架对象。
- Event 变更：schema 正反例、live/replay 等价、V1 fixture 兼容。
- SQLite 变更：事务原子性、migration 幂等和重启恢复。
- Transport：只验证认证、schema、状态码、SSE resume 与用例映射。
- UI projection/store：验证同一 Event 序列得到同一视图，stale snapshot 不回滚。
- 修复缺陷必须先有能复现或保护该行为的测试。

## 8. 数据库迁移规范

1. 新 migration 只追加，不修改已发布 migration。
2. migration 必须幂等或由版本表保证只执行一次。
3. 先扩展 schema，再迁移/回填，最后在后续版本收紧；不得同版本破坏旧读取。
4. 数据转换必须保留 Event offset、ID 和 replay 语义。
5. 迁移前后都运行历史 fixture、重启恢复和原子提交测试。
6. PR 必须写明备份、回滚和前向修复策略。

## 9. CI 与评审门禁

合并前必须通过：

```bash
npm run check
```

`check` 依次执行代码与样式 lint、分层 TypeScript 工程检查、架构门禁、全量测试、生产构建和生产依赖安全审计。评审者还需确认：依赖方向正确、没有第二事实来源、协议兼容策略明确、日志不含秘密/推理、错误与取消路径已测试。

架构测试同时限制应用层平台全局、Runtime 配置读取、工具 facade、前端编排 hook 和 legacy CSS 的增长；调整阈值必须伴随真实拆分，不得仅放宽上限。
