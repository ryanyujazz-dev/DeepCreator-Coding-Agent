import assert from "node:assert/strict";
import test from "node:test";
import { MutationArgumentStream } from "../server/app/mutationStream";

test("streams a created file as an expanding line diff", () => {
  const raw = JSON.stringify({ path: "src/new.ts", content: "const one = 1;\nconst two = 2;\n" });
  const stream = new MutationArgumentStream("write_file");
  const updates = [...raw].flatMap((chunk) => stream.push(chunk) ?? []);
  const final = stream.flush() ?? updates.at(-1);
  assert.equal(final?.path, "src/new.ts");
  assert.equal(final?.additions, 2);
  assert.equal(final?.deletions, 0);
  assert.match(final?.patch ?? "", /\+const two = 2;/);
  assert.ok(updates.length > 0, "newline boundaries publish progress before the tool call completes");
});

test("streams an edit with accurate changed-line metrics", () => {
  const raw = JSON.stringify({
    path: "src/value.ts",
    oldText: "export function value() {\n  return 1;\n}\n",
    newText: "export function value() {\n  return 2;\n  return 3;\n}\n"
  });
  const stream = new MutationArgumentStream("edit_file");
  let latest;
  for (let index = 0; index < raw.length; index += 7) latest = stream.push(raw.slice(index, index + 7)) ?? latest;
  const final = stream.flush() ?? latest;
  assert.deepEqual(
    final && { additions: final.additions, deletions: final.deletions, operation: final.operation, path: final.path },
    { additions: 2, deletions: 1, operation: "edited", path: "src/value.ts" }
  );
  assert.match(final?.patch ?? "", /-{1} {2}return 1;/);
  assert.match(final?.patch ?? "", /\+ {2}return 3;/);
});
