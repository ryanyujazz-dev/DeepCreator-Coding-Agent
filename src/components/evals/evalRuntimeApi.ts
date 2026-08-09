import { StartEvalBatchInput, StartEvalRunInput } from "../../../shared/contracts/evals";
import {
  decodeEvalBatchResponse,
  decodeEvalBatchesResponse,
  decodeEvalCasesResponse,
  decodeEvalRunResponse,
  decodeEvalRunsResponse,
  decodeSessionResponse
} from "../../../shared/schemas/api";
import { runtimeApi } from "../../runtimeApi";

export const evalRuntimeApi = {
  getRunSession: (evalRunId: string) => runtimeApi.request(`/api/evals/runs/${encodeURIComponent(evalRunId)}/session`, decodeSessionResponse),
  listBatches: () => runtimeApi.request("/api/evals/batches", decodeEvalBatchesResponse),
  listCases: () => runtimeApi.request("/api/evals/cases", decodeEvalCasesResponse),
  listRuns: () => runtimeApi.request("/api/evals/runs", decodeEvalRunsResponse),
  pauseBatch: (batchId: string) => runtimeApi.request(`/api/evals/batches/${encodeURIComponent(batchId)}/pause`, decodeEvalBatchResponse, {
    method: "POST"
  }),
  resumeBatch: (batchId: string) => runtimeApi.request(`/api/evals/batches/${encodeURIComponent(batchId)}/resume`, decodeEvalBatchResponse, {
    method: "POST"
  }),
  startRun: (input: StartEvalRunInput) => runtimeApi.request("/api/evals/runs", decodeEvalRunResponse, {
    body: JSON.stringify(input),
    method: "POST"
  }),
  startBatch: (input: StartEvalBatchInput) => runtimeApi.request("/api/evals/batches", decodeEvalBatchResponse, {
    body: JSON.stringify(input),
    method: "POST"
  })
};
