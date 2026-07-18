import { ContextStats } from "../../shared/contracts/context";
import { Database } from "./database";

export class MetricStore {
  constructor(private readonly database: Database) {}

  save(metric: ContextStats): void {
    this.database.raw.prepare(`INSERT INTO metrics
      (metric_id, session_id, run_id, created_at, metric_json)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(metric_id) DO UPDATE SET metric_json = excluded.metric_json`)
      .run(metric.metricId, metric.sessionId, metric.runId, metric.createdAt, JSON.stringify(metric));
  }

  updateUsage(
    metricId: string,
    usage: Pick<ContextStats, "actualInputTokens" | "outputTokens" | "cacheHitTokens" | "cacheMissTokens">
  ): void {
    const row = this.database.raw.prepare("SELECT metric_json FROM metrics WHERE metric_id = ?").get(metricId) as { metric_json: string } | undefined;
    if (!row) return;
    const metric = { ...JSON.parse(row.metric_json), ...usage } as ContextStats;
    this.save(metric);
    const rawEstimate = metric.rawEstimatedInputTokens
      ?? metric.estimatedInputTokens / Math.max(0.4, metric.tokenCalibrationFactor ?? 1);
    if (!usage.actualInputTokens || rawEstimate <= 0 || !metric.model) return;
    const observed = Math.min(2.5, Math.max(0.4, usage.actualInputTokens / rawEstimate));
    const previous = this.database.raw.prepare("SELECT factor, sample_count FROM token_calibration WHERE model = ?").get(metric.model) as { factor: number; sample_count: number } | undefined;
    const weight = Math.min(19, previous?.sample_count ?? 0);
    const factor = previous ? (previous.factor * weight + observed) / (weight + 1) : observed;
    this.database.raw.prepare(`INSERT INTO token_calibration (model, factor, sample_count, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(model) DO UPDATE SET factor = excluded.factor, sample_count = excluded.sample_count, updated_at = excluded.updated_at`)
      .run(metric.model, factor, (previous?.sample_count ?? 0) + 1, new Date().toISOString());
  }

  read(sessionId: string): ContextStats[] {
    return (this.database.raw.prepare("SELECT metric_json FROM metrics WHERE session_id = ? ORDER BY created_at").all(sessionId) as Array<{ metric_json: string }>)
      .map((row) => JSON.parse(row.metric_json) as ContextStats);
  }

  calibration(model: string): number {
    const row = this.database.raw.prepare("SELECT factor FROM token_calibration WHERE model = ?").get(model) as { factor: number } | undefined;
    return row?.factor ?? 1;
  }
}
