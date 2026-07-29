import { readFileSync } from "node:fs";
import { finalizeExistingEvalRun } from "./finalize";

async function main(): Promise<void> {
  const inputIndex = process.argv.indexOf("--input");
  const inputPath = inputIndex >= 0 ? process.argv[inputIndex + 1] : undefined;
  if (!inputPath) throw new Error("缺少 --input。");
  const input = JSON.parse(readFileSync(inputPath, "utf8")) as Parameters<typeof finalizeExistingEvalRun>[0];
  await finalizeExistingEvalRun(input);
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
