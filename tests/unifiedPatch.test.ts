import assert from "node:assert/strict";
import test from "node:test";
import { modelsFromUnifiedPatch } from "../src/editor/unifiedPatch";

test("reconstructs original and modified models with stable source line numbers", () => {
  const models = modelsFromUnifiedPatch([
    "diff --git a/example.ts b/example.ts",
    "--- a/example.ts",
    "+++ b/example.ts",
    "@@ -4,3 +4,4 @@",
    " const stable = true;",
    "-const oldValue = 1;",
    "+const newValue = 2;",
    "+const extra = 3;",
    " return stable;",
    ""
  ].join("\n"));

  assert.equal(models.original, "\n\n\nconst stable = true;\nconst oldValue = 1;\nreturn stable;");
  assert.equal(models.modified, "\n\n\nconst stable = true;\nconst newValue = 2;\nconst extra = 3;\nreturn stable;");
  assert.equal(models.sourceLineCount, 7);
});

test("preserves omitted gaps between multiple hunks for unchanged-region folding", () => {
  const models = modelsFromUnifiedPatch([
    "@@ -2,2 +2,2 @@",
    "-before",
    "+after",
    " context",
    "@@ -20,2 +20,2 @@",
    " next",
    "-old",
    "+new"
  ].join("\n"));

  assert.equal(models.original.split("\n")[1], "before");
  assert.equal(models.modified.split("\n")[1], "after");
  assert.equal(models.original.split("\n")[19], "next");
  assert.equal(models.modified.split("\n")[20], "new");
  assert.equal(models.sourceLineCount, 21);
});
