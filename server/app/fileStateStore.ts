import { stableDigest } from "../../shared/domain/digest";
import { workspaceRelativeTarget } from "../infra/tools/security";

// Per-run file content hash map:read_file 写入,edit_file/write_file/apply_patch 校验+更新。
// 隐式 stale 防护 —— 模型不感知 hash,runtime 内部比对;不强制 read(无记录不校验)。
// runId 为空(单测路径)时全跳过,向后兼容。run 终态由 RunLauncher.finally 调 clear。
export class FileStateStore {
  private readonly runs = new Map<string, Map<string, string>>();

  /** read_file 读后记录全文 hash(hash 全文,非截断切片,保证 read→edit 可比)。 */
  recordRead(runId: string | undefined, projectRoot: string, rawPath: string, contents: string): void {
    if (!runId) return;
    const rel = workspaceRelativeTarget(projectRoot, rawPath);
    let map = this.runs.get(runId);
    if (!map) {
      map = new Map();
      this.runs.set(runId, map);
    }
    map.set(rel, stableDigest(contents));
  }

  /** edit_file 读后取 expected hash(无记录 → undefined,不校验)。 */
  hashFor(runId: string | undefined, projectRoot: string, rawPath: string): string | undefined {
    if (!runId) return undefined;
    return this.runs.get(runId)?.get(workspaceRelativeTarget(projectRoot, rawPath));
  }

  /** write_file/edit_file/apply_patch 写盘后更新 hash。 */
  recordWrite(runId: string | undefined, projectRoot: string, rawPath: string, contents: string): void {
    if (!runId) return;
    this.runs.get(runId)?.set(workspaceRelativeTarget(projectRoot, rawPath), stableDigest(contents));
  }

  /** run 终态清理(RunLauncher.finally 调)。 */
  clear(runId: string): void {
    this.runs.delete(runId);
  }
}
