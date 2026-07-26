import assert from "node:assert/strict";
import test from "node:test";
import { stableDigest, utf8ByteLength } from "../shared/domain/digest";

test("stableDigest is deterministic and distinguishes input order", () => {
  const digest = stableDigest("DeepSeeker 思维摘要");
  assert.match(digest, /^[\da-f]{64}$/);
  assert.equal(stableDigest("DeepSeeker 思维摘要"), digest);
  assert.notEqual(stableDigest("摘要思维 DeepSeeker"), digest);
});

test("utf8ByteLength counts ASCII and multibyte code points", () => {
  assert.equal(utf8ByteLength("abc"), 3);
  assert.equal(utf8ByteLength("思考"), 6);
  assert.equal(utf8ByteLength("A😀"), 5);
});
