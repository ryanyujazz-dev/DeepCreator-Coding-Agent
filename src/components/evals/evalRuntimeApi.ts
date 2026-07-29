import { StartEvalRunInput } from "../../../shared/contracts/evals";
import {
  decodeEvalCasesResponse,
  decodeEvalRunResponse,
  decodeEvalRunsResponse,
  decodeSessionResponse
} from "../../../shared/schemas/api";
import { runtimeApi } from "../../runtimeApi";

export const evalRuntimeApi = {
  getRunSession: (evalRunId: string) => runtimeApi.request(`/api/evals/runs/${encodeURIComponent(evalRunId)}/session`, decodeSessionResponse),
  listCases: () => runtimeApi.request("/api/evals/cases", decodeEvalCasesResponse),
  listRuns: () => runtimeApi.request("/api/evals/runs", decodeEvalRunsResponse),
  startRun: (input: StartEvalRunInput) => runtimeApi.request("/api/evals/runs", decodeEvalRunResponse, {
    body: JSON.stringify(input),
    method: "POST"
  })
};
