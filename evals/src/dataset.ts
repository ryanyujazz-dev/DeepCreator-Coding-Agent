import { readFileSync } from "node:fs";
import path from "node:path";
import { EvalCase, EvalDataset, EvalFixtureManifest } from "./types";

export const defaultDatasetPath = path.resolve("evals/datasets/code-agent-v1.json");

export function loadDataset(filePath = defaultDatasetPath): EvalDataset {
  const dataset = JSON.parse(readFileSync(filePath, "utf8")) as EvalDataset;
  if (!dataset.dataset?.id || !Array.isArray(dataset.cases)) throw new Error(`无效 Eval 数据集：${filePath}`);
  if (dataset.cases.length !== dataset.dataset.caseCount) {
    throw new Error(`数据集声明 ${dataset.dataset.caseCount} 条 Case，实际为 ${dataset.cases.length} 条。`);
  }
  const ids = new Set<string>();
  for (const item of dataset.cases) {
    if (!/^CAE-\d{3}$/.test(item.caseId)) throw new Error(`无效 Case ID：${item.caseId}`);
    if (ids.has(item.caseId)) throw new Error(`重复 Case ID：${item.caseId}`);
    ids.add(item.caseId);
  }
  return dataset;
}

export function findCase(dataset: EvalDataset, caseId: string): EvalCase {
  const item = dataset.cases.find((candidate) => candidate.caseId === caseId);
  if (!item) throw new Error(`未找到 Eval Case：${caseId}`);
  return item;
}

export function fixtureManifestPath(caseId: string): string {
  return path.resolve("evals/fixtures", caseId, "fixture.json");
}

export function loadFixture(caseId: string): EvalFixtureManifest {
  const filePath = fixtureManifestPath(caseId);
  const fixture = JSON.parse(readFileSync(filePath, "utf8")) as EvalFixtureManifest;
  if (fixture.caseId !== caseId) throw new Error(`Fixture Case ID 不匹配：${fixture.caseId}`);
  if (fixture.status !== "ready") throw new Error(`${caseId} Fixture 尚未就绪。`);
  const points = fixture.assertions.reduce((total, assertion) => total + assertion.points, 0);
  if (points !== 30) throw new Error(`${caseId} 的任务结果断言总分必须为 30，当前为 ${points}。`);
  return fixture;
}
