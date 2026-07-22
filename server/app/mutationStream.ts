import { FileChange } from "../../shared/contracts/runtime";

type Field = "path" | "content" | "oldText" | "newText";
type MutationTool = "write_file" | "edit_file";

function decodedEscape(value: string): string {
  return ({
    '"': '"',
    "\\": "\\",
    "/": "/",
    b: "\b",
    f: "\f",
    n: "\n",
    r: "\r",
    t: "\t"
  } as Record<string, string>)[value] ?? value;
}

function lines(value: string): string[] {
  if (!value) return [];
  const result = value.split(/\r?\n/);
  if (result.at(-1) === "") result.pop();
  return result;
}

function editPreview(path: string, before: string, after: string): FileChange {
  const oldLines = lines(before);
  const newLines = lines(after);
  let prefix = 0;
  while (prefix < oldLines.length && prefix < newLines.length && oldLines[prefix] === newLines[prefix]) prefix += 1;
  let suffix = 0;
  while (
    suffix < oldLines.length - prefix &&
    suffix < newLines.length - prefix &&
    oldLines[oldLines.length - suffix - 1] === newLines[newLines.length - suffix - 1]
  ) suffix += 1;
  const removed = oldLines.slice(prefix, oldLines.length - suffix);
  const added = newLines.slice(prefix, newLines.length - suffix);
  const contextStart = Math.max(0, prefix - 3);
  const contextEndOld = Math.min(oldLines.length, oldLines.length - suffix + 3);
  const beforeContext = oldLines.slice(contextStart, prefix);
  const afterContext = oldLines.slice(oldLines.length - suffix, contextEndOld);
  const oldCount = beforeContext.length + removed.length + afterContext.length;
  const newCount = beforeContext.length + added.length + afterContext.length;
  const patch = removed.length === 0 && added.length === 0 ? undefined : [
    `diff --git a/${path} b/${path}`,
    `--- a/${path}`,
    `+++ b/${path}`,
    `@@ -${contextStart + 1},${oldCount} +${contextStart + 1},${newCount} @@`,
    ...beforeContext.map((line) => ` ${line}`),
    ...removed.map((line) => `-${line}`),
    ...added.map((line) => `+${line}`),
    ...afterContext.map((line) => ` ${line}`)
  ].join("\n");
  return { additions: added.length, deletions: removed.length, operation: "edited", patch, path };
}

function writePreview(path: string, content: string): FileChange {
  const added = lines(content);
  const patch = added.length === 0 ? undefined : [
    `diff --git a/${path} b/${path}`,
    "new file mode 100644",
    "--- /dev/null",
    `+++ b/${path}`,
    `@@ -0,0 +1,${added.length} @@`,
    ...added.map((line) => `+${line}`)
  ].join("\n");
  return { additions: added.length, deletions: 0, operation: "created", patch, path };
}

/** Decodes streamed file-mutation arguments without exposing raw JSON syntax to the timeline. */
export class MutationArgumentStream {
  private state: "key" | "colon" | "value" | "comma" | "skip" = "key";
  private stringRole: "key" | "value" | null = null;
  private token = "";
  private currentKey = "";
  private escaping = false;
  private unicode = "";
  private values: Partial<Record<Field, string>> = {};
  private completed = new Set<Field>();
  private lastEmittedBefore = 0;
  private lastEmittedAfter = 0;
  private emittedPath = "";

  constructor(private readonly tool: MutationTool) {}

  push(chunk: string): FileChange | undefined {
    for (let index = 0; index < chunk.length; index += 1) {
      const character = chunk[index];
      if (this.stringRole) {
        if (this.unicode) {
          if (/^[0-9a-f]$/i.test(character)) {
            this.unicode += character;
            if (this.unicode.length === 5) {
              this.append(String.fromCharCode(Number.parseInt(this.unicode.slice(1), 16)));
              this.unicode = "";
              this.escaping = false;
            }
            continue;
          }
          this.append("u");
          this.unicode = "";
          this.escaping = false;
        }
        if (this.escaping) {
          if (character === "u") this.unicode = "u";
          else {
            this.append(decodedEscape(character));
            this.escaping = false;
          }
          continue;
        }
        if (character === "\\") {
          this.escaping = true;
          continue;
        }
        if (character === '"') {
          this.finishString();
          continue;
        }
        this.append(character);
        continue;
      }

      if (/\s/.test(character) || character === "{") continue;
      if (this.state === "key" && character === '"') {
        this.stringRole = "key";
        this.token = "";
      } else if (this.state === "colon" && character === ":") {
        this.state = "value";
      } else if (this.state === "value" && character === '"') {
        this.stringRole = "value";
        this.token = "";
      } else if (this.state === "value") {
        this.state = "skip";
      } else if ((this.state === "comma" || this.state === "skip") && character === ",") {
        this.state = "key";
      }
    }
    return this.preview(false);
  }

  flush(): FileChange | undefined {
    return this.preview(true);
  }

  private append(value: string): void {
    this.token += value;
    if (this.stringRole !== "value" || !this.isField(this.currentKey)) return;
    this.values[this.currentKey] = this.token;
  }

  private finishString(): void {
    if (this.stringRole === "key") {
      this.currentKey = this.token;
      this.state = "colon";
    } else {
      if (this.isField(this.currentKey)) {
        this.values[this.currentKey] = this.token;
        this.completed.add(this.currentKey);
      }
      this.state = "comma";
    }
    this.stringRole = null;
    this.token = "";
  }

  private isField(value: string): value is Field {
    return value === "path" || value === "content" || value === "oldText" || value === "newText";
  }

  private preview(force: boolean): FileChange | undefined {
    const path = this.completed.has("path") ? (this.values.path ?? "") : "";
    const before = this.tool === "edit_file" ? (this.values.oldText ?? "") : "";
    const after = this.tool === "edit_file" ? (this.values.newText ?? "") : (this.values.content ?? "");
    if (!path) return undefined;
    const beforeDelta = before.slice(this.lastEmittedBefore);
    const afterDelta = after.slice(this.lastEmittedAfter);
    const firstBeforeLine = this.lastEmittedBefore === 0 && beforeDelta.includes("\n");
    const firstAfterLine = this.lastEmittedAfter === 0 && afterDelta.includes("\n");
    const shouldEmit = force || firstBeforeLine || firstAfterLine || beforeDelta.length >= 512 || afterDelta.length >= 512;
    if (!shouldEmit) return undefined;
    if (path === this.emittedPath && before.length === this.lastEmittedBefore && after.length === this.lastEmittedAfter) return undefined;
    this.emittedPath = path;
    this.lastEmittedBefore = before.length;
    this.lastEmittedAfter = after.length;
    return this.tool === "write_file" ? writePreview(path, after) : editPreview(path, before, after);
  }
}
