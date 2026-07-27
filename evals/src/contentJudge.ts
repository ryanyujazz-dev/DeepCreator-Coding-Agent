import { Event, Run } from "../../shared/contracts/runtime";
import { Provider } from "../../shared/contracts/provider";
import { ContentJudgeResult, EvalCase, JudgeFinding, ProcessContentScores } from "./types";

export interface ContentJudge {
  evaluate(input: { evalCase: EvalCase; events: Event[]; run: Run }): Promise<ContentJudgeResult>;
}

type ContentSegment = {
  activityId: string;
  eventId?: string;
  text: string;
  precedingTools: Array<{ status: string; target: string; toolName: string }>;
};

const ANALYSIS_CUE = /(?:说明|意味着|表明|因此|所以|根因|现状|问题|判断|取舍|优先|风险|边界|依赖|耦合|假设|排除|相比|而不是)/;
const FRAMEWORK_CUE = /(?:分成|主线|维度|重点|标准|范围|这一轮|先.+再|验收|只.+不)/;
const ACTIONABLE_CUE = /(?:下一步|应该|方案|解决|修复|迁移|验证|检查|调整|保留|避免)/;
const GENERIC_PLACEHOLDER = /^(?:好的[，。\s]*)?(?:我(?:会|先|再|继续|接下来)?|现在)?(?:来|将)?(?:先|再|继续|进一步)?(?:查看|看看|检查|分析|研究|处理|修改|获取|读取)(?:一下)?(?:相关|更多|这些)?(?:信息|内容|代码|文件|问题)?[，。…\s]*(?:让我)?(?:再|继续|进一步)?(?:看看|检查|分析|处理)?[。！!…\s]*$/;

function clamp(value: number, maximum: number): number {
  return Math.max(0, Math.min(maximum, Math.round(value * 10) / 10));
}

function segmentsFor(run: Run, events: Event[]): ContentSegment[] {
  const activities = run.activities;
  return activities.flatMap((activity, index) => {
    if (activity.kind !== "message" || activity.audience !== "user" || !activity.body.trim()) return [];
    if (activity.body.trim() === run.answer.trim() && index === activities.length - 1) return [];
    let event: Event | undefined;
    for (let eventIndex = events.length - 1; eventIndex >= 0; eventIndex -= 1) {
      if (events[eventIndex].scope.activityId === activity.activityId) {
        event = events[eventIndex];
        break;
      }
    }
    const precedingTools = activities.slice(0, index).flatMap((candidate) => candidate.tool ? [{
      status: candidate.status,
      target: candidate.tool.normalizedTarget,
      toolName: candidate.tool.toolName
    }] : []);
    return [{ activityId: activity.activityId, eventId: event?.eventId, precedingTools, text: activity.body.trim() }];
  });
}

function normalize(text: string): string {
  return text.toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, "");
}

function heuristicMetrics(segments: ContentSegment[]): ContentJudgeResult["metrics"] {
  if (segments.length === 0) {
    return {
      factInterpretationLinkRate: 0,
      genericPlaceholderCount: 0,
      groundedAnalysisRate: 0,
      groundedClaimRate: 0,
      redundantProgressCount: 0,
      substantiveContentRate: 0
    };
  }
  let generic = 0;
  let substantive = 0;
  let grounded = 0;
  let groundedAnalysis = 0;
  let interpreted = 0;
  let analysisCount = 0;
  let redundant = 0;
  const seen: string[] = [];
  for (const segment of segments) {
    const genericSegment = GENERIC_PLACEHOLDER.test(segment.text) || (segment.text.length < 24 && !ANALYSIS_CUE.test(segment.text) && !FRAMEWORK_CUE.test(segment.text));
    const analytical = ANALYSIS_CUE.test(segment.text) || FRAMEWORK_CUE.test(segment.text);
    const hasEvidence = segment.precedingTools.some((tool) => tool.status === "completed") && /(?:文件|测试|命令|实现|模块|状态|代码|目录|工具|架构|前端|后端|Runtime|Event|Plan|[\w./-]+\.(?:ts|tsx|js|json|md))/i.test(segment.text);
    const hasValue = analytical || ACTIONABLE_CUE.test(segment.text) || hasEvidence;
    if (genericSegment) generic += 1;
    if (hasValue && !genericSegment) substantive += 1;
    if (hasEvidence) grounded += 1;
    if (analytical) {
      analysisCount += 1;
      if (hasEvidence) groundedAnalysis += 1;
      if (hasEvidence && ANALYSIS_CUE.test(segment.text)) interpreted += 1;
    }
    const fingerprint = normalize(segment.text);
    if (seen.some((previous) => previous === fingerprint || (fingerprint.length > 20 && (previous.includes(fingerprint) || fingerprint.includes(previous))))) redundant += 1;
    seen.push(fingerprint);
  }
  return {
    factInterpretationLinkRate: analysisCount ? interpreted / analysisCount : 0,
    genericPlaceholderCount: generic,
    groundedAnalysisRate: analysisCount ? groundedAnalysis / analysisCount : 0,
    groundedClaimRate: grounded / segments.length,
    redundantProgressCount: redundant,
    substantiveContentRate: substantive / segments.length
  };
}

function heuristicScores(segments: ContentSegment[], metrics: ContentJudgeResult["metrics"]): ProcessContentScores {
  const framework = segments.some((segment) => FRAMEWORK_CUE.test(segment.text));
  const actionable = segments.filter((segment) => ACTIONABLE_CUE.test(segment.text)).length / Math.max(1, segments.length);
  const evidenceGrounding = clamp(metrics.groundedClaimRate * 7, 7);
  const analysisAndJudgment = clamp(((metrics.groundedAnalysisRate + metrics.factInterpretationLinkRate) / 2) * 7, 7);
  const logicalProgression = clamp((metrics.substantiveContentRate * 4) + (framework ? 2 : 0), 6);
  const userValue = clamp((metrics.substantiveContentRate * 3) + (actionable * 2), 5);
  return {
    analysisAndJudgment,
    evidenceGrounding,
    logicalProgression,
    total: clamp(evidenceGrounding + analysisAndJudgment + logicalProgression + userValue, 25),
    userValue
  };
}

export class HeuristicContentJudge implements ContentJudge {
  async evaluate(input: { evalCase: EvalCase; events: Event[]; run: Run }): Promise<ContentJudgeResult> {
    const segments = segmentsFor(input.run, input.events);
    const metrics = heuristicMetrics(segments);
    const scores = heuristicScores(segments, metrics);
    return {
      findings: [{
        confidence: 0.45,
        dimension: "heuristic_baseline",
        evidenceEventIds: segments.flatMap((segment) => segment.eventId ? [segment.eventId] : []),
        reason: "本地启发式评分只用于跑通流程；正式对比应启用 Provider Judge，并用人工标注样本校准。",
        score: scores.total
      }],
      metrics,
      scores
    };
  }
}

function jsonObject(text: string): Record<string, unknown> {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  const source = fenced ?? text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1);
  const parsed = JSON.parse(source) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Judge 未返回 JSON 对象。");
  return parsed as Record<string, unknown>;
}

function numberField(record: Record<string, unknown>, key: string, maximum: number): number {
  const value = Number(record[key]);
  if (!Number.isFinite(value)) throw new Error(`Judge 缺少分数字段：${key}`);
  return clamp(value, maximum);
}

export class ProviderContentJudge implements ContentJudge {
  constructor(private readonly provider: Provider, private readonly model: string) {}

  async evaluate(input: { evalCase: EvalCase; events: Event[]; run: Run }): Promise<ContentJudgeResult> {
    const segments = segmentsFor(input.run, input.events);
    const metrics = heuristicMetrics(segments);
    const trace = segments.map((segment, index) => ({
      content: segment.text,
      evidenceEventId: segment.eventId,
      index,
      precedingTools: segment.precedingTools.slice(-8)
    }));
    const response = await this.provider.stream({
      maxOutputTokens: 2_000,
      messages: [
        {
          role: "system",
          text: "你是严格的 Agent 过程 Content 评测员。只评价用户可见的阶段 Content，不评价私有思维链。必须基于给出的 Trace 证据评分；允许明确标注的推断，但不得把无证据判断当作事实。只输出 JSON。"
        },
        {
          role: "user",
          text: JSON.stringify({
            case: {
              checkpoints: input.evalCase.contentEvaluation.checkpoints,
              groundedFacts: input.evalCase.contentEvaluation.groundedFacts,
              request: input.evalCase.userRequest
            },
            rubric: {
              analysisAndJudgment: "0-7：解释事实意味着什么、区分现象与根因、形成有依据的判断或取舍",
              evidenceGrounding: "0-7：直接说出具体事实，且事实可关联先前工具结果",
              logicalProgression: "0-6：建立分析框架，并随着证据推进假设、结论和下一步",
              userValue: "0-5：帮助用户理解问题、解决路径、风险、优先级或验收方法"
            },
            trace,
            output: {
              analysisAndJudgment: "number",
              evidenceGrounding: "number",
              findings: [{ confidence: "0-1", dimension: "string", evidenceEventIds: ["string"], reason: "string", score: "number" }],
              logicalProgression: "number",
              userValue: "number"
            }
          })
        }
      ],
      model: this.model,
      thinkingMode: "disabled",
      tools: []
    });
    const parsed = jsonObject(response.answer);
    const scores = {
      analysisAndJudgment: numberField(parsed, "analysisAndJudgment", 7),
      evidenceGrounding: numberField(parsed, "evidenceGrounding", 7),
      logicalProgression: numberField(parsed, "logicalProgression", 6),
      userValue: numberField(parsed, "userValue", 5)
    };
    const findings = Array.isArray(parsed.findings) ? parsed.findings.flatMap<JudgeFinding>((value) => {
      if (!value || typeof value !== "object" || Array.isArray(value)) return [];
      const item = value as Record<string, unknown>;
      return [{
        confidence: clamp(Number(item.confidence ?? 0.5), 1),
        dimension: String(item.dimension ?? "processContent"),
        evidenceEventIds: Array.isArray(item.evidenceEventIds) ? item.evidenceEventIds.map(String) : [],
        reason: String(item.reason ?? ""),
        score: Number(item.score ?? 0)
      }];
    }) : [];
    return {
      findings,
      metrics,
      scores: { ...scores, total: clamp(Object.values(scores).reduce((total, score) => total + score, 0), 25) }
    };
  }
}
