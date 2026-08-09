# 全量评测批次设计

## 架构

- `shared/contracts/evals.ts` 定义供应商中立的批次契约及子 Run 关联。
- `shared/domain/evalBatchScoring.ts` 负责纯函数式难度权重和批次结算。
- `EvalService` 创建全部 queued Run，通过容量为 4 的调度器逐步填充并发槽，并在每个子 Run 终止时推进队列和持久化批次。
- 批次暂停只关闭调度门，不中断已经占用执行槽的 Run；继续时重新调用同一调度器填充空位。
- HTTP 增加批次列表与启动接口；Renderer 与 Run 列表一起轮询批次快照。
- 侧边栏继续以 Eval Run 为执行过程入口，批次只负责聚合和导航，不复制 Runtime Session。

## 数据与 API

- `EvalRunRecord.batchId?` 标识所属批次；`queued` 是尚未占用执行槽的真实阶段。
- `EvalBatchRunRecord.cases` 固化 Case、难度、权重与 Eval Run ID，避免数据集后续修改影响历史分数。
- `GET /api/evals/batches` 返回批次历史。
- `POST /api/evals/batches` 使用当前模型、Judge 和 prompt 版本启动全量批次。
- `POST /api/evals/batches/:batchId/pause` 与 `/resume` 原位更新批次状态。
- 新评测默认使用 provider Judge，Judge 模型固定默认为 `deepseek-v4-flash`；用户仍可在观察器显式切换评分方式。

## 计分

`weightedAverage = round1(sum(score × weight) / sum(all case weights))`

难度权重为 easy=1、medium=1.5、hard=2。只有包含评分结果的 completed Run 使用实际分数；其他终态均为 0 分。批次未全部终止前只展示完成进度，不展示临时平均分。

## 失败与重启

- 单个 Case 失败不终止批次，调度器继续填充剩余任务。
- Runtime 关闭时 queued Run 明确取消；活动 Run 走现有取消与收尾路径。
- 重启恢复时中断 Run 按现有规则转为 failed，随后批次重新结算。

## UI

- “评测集”标题右侧使用现有 PillButton 与 Lucide Play 图标。
- 批次运行时在同一区域显示暂停按钮；暂停后按钮变为继续，批次结果显示“已暂停”。
- “全量评测结果”显示批次状态、完成数或加权分；展开后列出全部 Case，可点击查看执行过程。
- 原“评测结果”改为“单次评测结果”，并过滤掉带 `batchId` 的 Run。
