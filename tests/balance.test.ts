import assert from "node:assert/strict";
import { createServer } from "node:http";
import { type AddressInfo } from "node:net";
import test from "node:test";
import { DeepSeekProvider } from "../server/infra/deepseek";

// ─────────────────────────────────────────────────────────────────────────────
// balance 功能测试。
//
// 覆盖范围(对标 AGENTS.md "事件生产变更时必须加运行时测试"):
//   1. getBalance() URL 构造逻辑(从 chat/completions origin 拼 /user/balance)
//   2. snake_case → camelCase 字段映射
//   3. 字符串余额 → Number 转换
//   4. 缺失 API key 时抛错
//   5. 非 2xx 响应抛错
//   6. 自定义 DEEPSEEK_API_URL 时余额 URL 跟随同一 host
//   7. balance_infos 为空数组时正常返回空列表
//   8. 多币种返回
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 创建一个 mock HTTP server,对每个请求用 responder 回调决定返回的 [status, body]。
 * responder 还可以断言请求的 method/url/headers。
 * 返回 server 实例(测试结束后需手动 close)。
 */
type Responder = (method: string, url: string, authHeader: string | undefined) => [number, unknown];

async function startMockServer(responder: Responder): Promise<{ port: number; close: () => void }> {
  const server = createServer((request, response) => {
    let _body = "";
    request.on("data", (chunk) => (_body += chunk.toString()));
    request.on("end", () => {
      const [status, payload] = responder(request.method ?? "", request.url ?? "", request.headers.authorization);
      response.writeHead(status, { "Content-Type": "application/json" });
      response.end(JSON.stringify(payload));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    port,
    close: () => server.close()
  };
}

test("getBalance: constructs /user/balance URL from chat-completions origin and maps snake_case fields", async () => {
  const { port, close } = await startMockServer((method, url, auth) => {
    assert.equal(method, "GET");
    assert.equal(url, "/user/balance");
    assert.equal(auth, "Bearer test-key");
    return [200, {
      is_available: true,
      balance_infos: [{
        currency: "CNY",
        total_balance: "10.50",
        granted_balance: "8.00",
        topped_up_balance: "2.50"
      }]
    }];
  });
  try {
    // 传入含 /chat/completions 路径的 URL,getBalance 应只取 origin
    const provider = new DeepSeekProvider("test-key", `http://127.0.0.1:${port}/chat/completions`);
    const balance = await provider.getBalance();
    assert.equal(balance.isAvailable, true);
    assert.equal(balance.balanceInfos.length, 1);
    assert.equal(balance.balanceInfos[0].currency, "CNY");
    assert.equal(balance.balanceInfos[0].totalBalance, 10.5);
    assert.equal(balance.balanceInfos[0].grantedBalance, 8);
    assert.equal(balance.balanceInfos[0].toppedUpBalance, 2.5);
  } finally {
    close();
  }
});

test("getBalance: handles empty balance_infos array", async () => {
  const { port, close } = await startMockServer(() => [200, { is_available: false, balance_infos: [] }]);
  try {
    const provider = new DeepSeekProvider("test-key", `http://127.0.0.1:${port}`);
    const balance = await provider.getBalance();
    assert.equal(balance.isAvailable, false);
    assert.equal(balance.balanceInfos.length, 0);
  } finally {
    close();
  }
});

test("getBalance: throws when API key is missing", async () => {
  const { port, close } = await startMockServer(() => [200, { is_available: true, balance_infos: [] }]);
  try {
    const provider = new DeepSeekProvider("", `http://127.0.0.1:${port}`);
    await assert.rejects(
      () => provider.getBalance(),
      /DEEPSEEK_API_KEY/
    );
  } finally {
    close();
  }
});

test("getBalance: throws on non-2xx response", async () => {
  const { port, close } = await startMockServer(() => [403, { error: "forbidden" }]);
  try {
    const provider = new DeepSeekProvider("test-key", `http://127.0.0.1:${port}`);
    await assert.rejects(
      () => provider.getBalance(),
      /HTTP 403/
    );
  } finally {
    close();
  }
});

test("getBalance: handles multiple currencies", async () => {
  const { port, close } = await startMockServer(() => [200, {
    is_available: true,
    balance_infos: [
      { currency: "CNY", total_balance: "100.00", granted_balance: "80.00", topped_up_balance: "20.00" },
      { currency: "USD", total_balance: "15.00", granted_balance: "10.00", topped_up_balance: "5.00" }
    ]
  }]);
  try {
    const provider = new DeepSeekProvider("test-key", `http://127.0.0.1:${port}`);
    const balance = await provider.getBalance();
    assert.equal(balance.balanceInfos.length, 2);
    assert.equal(balance.balanceInfos[0].currency, "CNY");
    assert.equal(balance.balanceInfos[1].currency, "USD");
    assert.equal(balance.balanceInfos[1].totalBalance, 15);
  } finally {
    close();
  }
});
