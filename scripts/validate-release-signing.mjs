const platform = process.argv.find((argument) => argument.startsWith("--platform="))?.slice("--platform=".length);

if (platform !== "darwin") throw new Error("签名校验目前只支持 --platform=darwin。");

const required = [
  "APPLE_CERTIFICATE_BASE64",
  "APPLE_CERTIFICATE_PASSWORD",
  "APPLE_ID",
  "APPLE_ID_PASSWORD",
  "APPLE_SIGNING_IDENTITY",
  "APPLE_TEAM_ID"
];
const missing = required.filter((name) => !process.env[name]?.trim());
if (missing.length > 0) {
  throw new Error(`正式 macOS 发布缺少签名或公证配置：${missing.join(", ")}`);
}
if (!process.env.APPLE_SIGNING_IDENTITY.includes("Developer ID Application")) {
  throw new Error("APPLE_SIGNING_IDENTITY 必须使用 Developer ID Application 证书。");
}

console.log("macOS Developer ID 签名与 Apple 公证配置已准备。");
