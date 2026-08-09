import assert from "node:assert/strict";
import test from "node:test";
import { parseUserConfig } from "../server/infra/userConfig";

test("user config parser fills optional defaults without changing explicit values", () => {
  const config = parseUserConfig(JSON.stringify({ model: "glm-5.2", locale: "zh-CN" }));
  assert.equal(config.model, "glm-5.2");
  assert.equal(config.locale, "zh-CN");
  assert.equal(config.contextWindowTokens, 1_000_000);
  assert.deepEqual(config.permissions, { allow: [], deny: [] });
  assert.equal(config.modelProtocols["deepseek-v4-flash"], "responses");
});

test("user config parser rejects malformed persisted values", () => {
  assert.throws(() => parseUserConfig("[]"), /根节点必须是对象/);
  assert.throws(() => parseUserConfig('{"contextWindowTokens":0}'), /必须是正整数/);
  assert.throws(() => parseUserConfig('{"permissions":{"allow":[1]}}'), /必须是字符串数组/);
  assert.throws(() => parseUserConfig('{"modelProtocols":{"deepseek-v4-flash":"anthropic"}}'), /必须是 chat 或 responses/);
});
