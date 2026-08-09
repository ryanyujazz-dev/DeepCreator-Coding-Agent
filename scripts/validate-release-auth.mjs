const authMode = process.env.DEEPCREATOR_AUTH_MODE?.trim() || "local";

if (authMode !== "local" && authMode !== "github") {
  throw new Error("DEEPCREATOR_AUTH_MODE 只支持 local 或 github。");
}

if (authMode === "github") {
  const baseUrl = process.env.DEEPCREATOR_AUTH_BASE_URL?.trim();
  const publicJwk = process.env.DEEPCREATOR_AUTH_PUBLIC_JWK?.trim();

  if (!baseUrl || !publicJwk) {
    throw new Error("GitHub 账号模式打包必须配置 DEEPCREATOR_AUTH_BASE_URL 和 DEEPCREATOR_AUTH_PUBLIC_JWK。");
  }

  const url = new URL(baseUrl);
  if (url.protocol !== "https:") throw new Error("正式打包的账号服务地址必须使用 HTTPS。");

  const parsed = JSON.parse(publicJwk);
  if (parsed.kty !== "OKP" || parsed.crv !== "Ed25519" || typeof parsed.x !== "string" || !parsed.x) {
    throw new Error("DEEPCREATOR_AUTH_PUBLIC_JWK 必须是 Ed25519 公钥 JWK。");
  }
}
