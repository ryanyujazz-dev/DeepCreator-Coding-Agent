import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { EvalExperimentSummary, EvalResult } from "./types";

type Aggregate = {
  key: string;
  model: string;
  promptVersion: string;
  count: number;
  passRate: number;
  total: number;
  content: number;
  groundedAnalysisRate: number;
  genericPlaceholderRate: number;
  durationMs: number;
};

function average(values: number[]): number {
  return values.length ? values.reduce((total, value) => total + value, 0) / values.length : 0;
}

function fixed(value: number, digits = 1): string {
  return value.toFixed(digits);
}

function aggregates(results: EvalResult[]): Aggregate[] {
  const keys = [...new Set(results.map((result) => `${result.model}\u0000${result.promptVersion}`))];
  return keys.map((key) => {
    const [model, promptVersion] = key.split("\u0000");
    const items = results.filter((result) => result.model === model && result.promptVersion === promptVersion);
    const segments = items.reduce((total, item) => total + item.metrics.genericPlaceholderCount, 0);
    return {
      content: average(items.map((item) => item.scores.processContent.total)),
      count: items.length,
      durationMs: average(items.map((item) => item.metrics.durationMs)),
      genericPlaceholderRate: segments / Math.max(1, items.length),
      groundedAnalysisRate: average(items.map((item) => item.metrics.groundedAnalysisRate)),
      key,
      model,
      passRate: items.filter((item) => item.passed).length / Math.max(1, items.length),
      promptVersion,
      total: average(items.map((item) => item.scores.total))
    };
  });
}

function mdCell(value: unknown): string {
  return String(value ?? "—").replaceAll("|", "\\|").replaceAll("\n", " ");
}

function markdownTable(headers: string[], rows: unknown[][]): string {
  return [
    `| ${headers.map(mdCell).join(" | ")} |`,
    `| ${headers.map(() => "---").join(" | ")} |`,
    ...rows.map((row) => `| ${row.map(mdCell).join(" | ")} |`)
  ].join("\n");
}

function attributionRows(results: EvalResult[]): unknown[][] {
  const layers = ["model", "tool", "context", "interaction", "feedback"] as const;
  return layers.map((layer) => {
    const items = results.filter((result) => result.attribution.primaryLayer === layer);
    const codes = [...new Set(items.flatMap((item) => item.attribution.failureCodes))];
    return [layer, items.length, `${fixed(items.length / Math.max(1, results.length) * 100)}%`, codes.join("、") || "—"];
  });
}

function promptComparisonRows(aggregate: Aggregate[]): unknown[][] {
  if (aggregate.length < 2) return [["尚无对比版本", "—", "—", "至少运行两个模型或 Prompt 版本后生成差异"]];
  const baseline = aggregate[0];
  return aggregate.slice(1).flatMap((candidate) => [
    ["任务通过率", `${baseline.model}/${baseline.promptVersion}: ${fixed(baseline.passRate * 100)}%`, `${candidate.model}/${candidate.promptVersion}: ${fixed(candidate.passRate * 100)}%`, `${fixed((candidate.passRate - baseline.passRate) * 100)}pp`],
    ["平均总分", fixed(baseline.total), fixed(candidate.total), fixed(candidate.total - baseline.total)],
    ["过程 Content", fixed(baseline.content), fixed(candidate.content), fixed(candidate.content - baseline.content)],
    ["事实分析率", `${fixed(baseline.groundedAnalysisRate * 100)}%`, `${fixed(candidate.groundedAnalysisRate * 100)}%`, `${fixed((candidate.groundedAnalysisRate - baseline.groundedAnalysisRate) * 100)}pp`],
    ["占位播报/Run", fixed(baseline.genericPlaceholderRate, 2), fixed(candidate.genericPlaceholderRate, 2), fixed(candidate.genericPlaceholderRate - baseline.genericPlaceholderRate, 2)]
  ]);
}

export function renderMarkdown(summary: EvalExperimentSummary): string {
  const aggregate = aggregates(summary.results);
  const overall = markdownTable(
    ["模型", "Prompt", "运行数", "通过率", "平均总分", "过程 Content", "事实分析率", "占位播报/Run", "平均耗时"],
    aggregate.map((item) => [
      item.model,
      item.promptVersion,
      item.count,
      `${fixed(item.passRate * 100)}%`,
      fixed(item.total),
      `${fixed(item.content)}/25`,
      `${fixed(item.groundedAnalysisRate * 100)}%`,
      fixed(item.genericPlaceholderRate, 2),
      `${fixed(item.durationMs / 1_000)}s`
    ])
  );
  const cases = markdownTable(
    ["Case", "模型/Prompt", "通过", "总分", "任务结果", "Content", "轨迹", "验证", "硬失败"],
    summary.results.map((item) => [
      item.caseId,
      `${item.model}/${item.promptVersion}`,
      item.passed ? "是" : "否",
      fixed(item.scores.total),
      `${fixed(item.scores.taskOutcome)}/30`,
      `${fixed(item.scores.processContent.total)}/25`,
      `${fixed(item.scores.toolTrajectory)}/15`,
      `${fixed(item.scores.verification)}/15`,
      item.hardFailures.map((failure) => failure.rule).join("、") || "—"
    ])
  );
  const content = markdownTable(
    ["Case", "事实与证据", "分析与判断", "逻辑推进", "用户价值", "事实分析率", "占位播报"],
    summary.results.map((item) => [
      item.caseId,
      `${fixed(item.scores.processContent.evidenceGrounding)}/7`,
      `${fixed(item.scores.processContent.analysisAndJudgment)}/7`,
      `${fixed(item.scores.processContent.logicalProgression)}/6`,
      `${fixed(item.scores.processContent.userValue)}/5`,
      `${fixed(item.metrics.groundedAnalysisRate * 100)}%`,
      item.metrics.genericPlaceholderCount
    ])
  );
  const attribution = markdownTable(["归因层", "数量", "占比", "失败代码"], attributionRows(summary.results));
  const comparison = markdownTable(["指标", "基线", "候选", "变化"], promptComparisonRows(aggregate));
  return `# DeepCreator Agent Eval Report\n\n` +
    `- 实验：${summary.experimentId}\n` +
    `- 生成时间：${summary.generatedAt}\n` +
    `- 运行数量：${summary.results.length}\n\n` +
    `## 1. 总体成绩\n\n${overall}\n\n` +
    `## 2. Case 明细\n\n${cases}\n\n` +
    `## 3. 过程 Content\n\n${content}\n\n` +
    `## 4. Bad Case 归因\n\n${attribution}\n\n` +
    `## 5. Prompt / 模型对比\n\n${comparison}\n`;
}

function escapeHtml(value: unknown): string {
  return String(value ?? "—")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function htmlTable(headers: string[], rows: unknown[][]): string {
  return `<div class="table-wrap"><table><thead><tr>${headers.map((header) => `<th>${escapeHtml(header)}</th>`).join("")}</tr></thead><tbody>${rows.map((row) => `<tr>${row.map((cell) => `<td>${escapeHtml(cell)}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`;
}

export function renderHtml(summary: EvalExperimentSummary): string {
  const aggregate = aggregates(summary.results);
  const passRate = summary.results.filter((result) => result.passed).length / Math.max(1, summary.results.length);
  const total = average(summary.results.map((result) => result.scores.total));
  const contentAverage = average(summary.results.map((result) => result.scores.processContent.total));
  const overall = htmlTable(
    ["模型", "Prompt", "运行数", "通过率", "平均总分", "过程 Content", "事实分析率", "占位播报/Run", "平均耗时"],
    aggregate.map((item) => [item.model, item.promptVersion, item.count, `${fixed(item.passRate * 100)}%`, fixed(item.total), `${fixed(item.content)}/25`, `${fixed(item.groundedAnalysisRate * 100)}%`, fixed(item.genericPlaceholderRate, 2), `${fixed(item.durationMs / 1_000)}s`])
  );
  const cases = htmlTable(
    ["Case", "模型/Prompt", "通过", "总分", "结果", "Content", "轨迹", "验证", "硬失败"],
    summary.results.map((item) => [item.caseId, `${item.model}/${item.promptVersion}`, item.passed ? "通过" : "失败", fixed(item.scores.total), `${fixed(item.scores.taskOutcome)}/30`, `${fixed(item.scores.processContent.total)}/25`, `${fixed(item.scores.toolTrajectory)}/15`, `${fixed(item.scores.verification)}/15`, item.hardFailures.map((failure) => failure.rule).join("、") || "—"])
  );
  const content = htmlTable(
    ["Case", "事实与证据", "分析与判断", "逻辑推进", "用户价值", "事实分析率", "占位播报"],
    summary.results.map((item) => [item.caseId, `${fixed(item.scores.processContent.evidenceGrounding)}/7`, `${fixed(item.scores.processContent.analysisAndJudgment)}/7`, `${fixed(item.scores.processContent.logicalProgression)}/6`, `${fixed(item.scores.processContent.userValue)}/5`, `${fixed(item.metrics.groundedAnalysisRate * 100)}%`, item.metrics.genericPlaceholderCount])
  );
  const attribution = htmlTable(["归因层", "数量", "占比", "失败代码"], attributionRows(summary.results));
  const comparison = htmlTable(["指标", "基线", "候选", "变化"], promptComparisonRows(aggregate));
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Agent Eval · ${escapeHtml(summary.experimentId)}</title><style>
  :root{color-scheme:light;background:#f4f6f8;color:#1f252b;font-family:Arial,"HarmonyOS Sans SC",sans-serif}body{margin:0;padding:32px}.page{max-width:1280px;margin:auto}.hero{background:#17202a;color:white;border-radius:18px;padding:28px 32px}.hero h1{margin:0 0 8px;font-size:28px}.hero p{margin:0;color:#c7d0d9}.cards{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:14px;margin:18px 0 28px}.card{background:white;border:1px solid #e1e6eb;border-radius:14px;padding:18px}.card strong{display:block;font-size:28px}.card span{color:#66717c;font-size:13px}section{background:white;border:1px solid #e1e6eb;border-radius:14px;padding:20px;margin:16px 0}h2{font-size:18px;margin:0 0 14px}.table-wrap{overflow:auto}table{width:100%;border-collapse:collapse;font-size:13px}th,td{text-align:left;padding:10px 12px;border-bottom:1px solid #edf0f2;white-space:nowrap}th{background:#f7f8fa;color:#53606b}tbody tr:hover{background:#f8fafb}@media(max-width:760px){body{padding:14px}.cards{grid-template-columns:1fr}}
  </style></head><body><main class="page"><header class="hero"><h1>Agent Eval Report</h1><p>${escapeHtml(summary.experimentId)} · ${escapeHtml(summary.generatedAt)}</p></header><div class="cards"><div class="card"><strong>${fixed(passRate * 100)}%</strong><span>任务通过率</span></div><div class="card"><strong>${fixed(total)}</strong><span>平均总分 / 100</span></div><div class="card"><strong>${fixed(contentAverage)}</strong><span>过程 Content / 25</span></div></div><section><h2>1. 总体成绩</h2>${overall}</section><section><h2>2. Case 明细</h2>${cases}</section><section><h2>3. 过程 Content</h2>${content}</section><section><h2>4. Bad Case 归因</h2>${attribution}</section><section><h2>5. Prompt / 模型对比</h2>${comparison}</section></main></body></html>`;
}

function csvCell(value: unknown): string {
  const text = String(value ?? "");
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export function renderCsv(results: EvalResult[]): string {
  const rows = [
    ["caseId", "model", "promptVersion", "passed", "total", "taskOutcome", "processContent", "evidenceGrounding", "analysisAndJudgment", "logicalProgression", "userValue", "toolTrajectory", "verification", "safety", "efficiency", "groundedAnalysisRate", "genericPlaceholderCount", "hardFailures"],
    ...results.map((item) => [item.caseId, item.model, item.promptVersion, item.passed, item.scores.total, item.scores.taskOutcome, item.scores.processContent.total, item.scores.processContent.evidenceGrounding, item.scores.processContent.analysisAndJudgment, item.scores.processContent.logicalProgression, item.scores.processContent.userValue, item.scores.toolTrajectory, item.scores.verification, item.scores.safety, item.scores.efficiency, item.metrics.groundedAnalysisRate, item.metrics.genericPlaceholderCount, item.hardFailures.map((failure) => failure.rule).join("|")])
  ];
  return rows.map((row) => row.map(csvCell).join(",")).join("\n") + "\n";
}

export function writeReports(summary: EvalExperimentSummary, outputDirectory: string): void {
  mkdirSync(outputDirectory, { recursive: true });
  writeFileSync(path.join(outputDirectory, "summary.json"), JSON.stringify(summary, null, 2) + "\n", "utf8");
  writeFileSync(path.join(outputDirectory, "report.md"), renderMarkdown(summary) + "\n", "utf8");
  writeFileSync(path.join(outputDirectory, "report.html"), renderHtml(summary), "utf8");
  writeFileSync(path.join(outputDirectory, "results.csv"), renderCsv(summary.results), "utf8");
}
