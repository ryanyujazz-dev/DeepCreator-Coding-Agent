import { generateKeyPairSync, randomBytes } from "node:crypto";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";

const envFileFlag = process.argv.indexOf("--env-file");
const envFile = envFileFlag === -1 ? "" : process.argv[envFileFlag + 1];
const publicBaseUrlFlag = process.argv.indexOf("--public-base-url");
const publicBaseUrl = publicBaseUrlFlag === -1 ? "" : process.argv[publicBaseUrlFlag + 1];
const updateBaseUrl = process.argv.includes("--update-base-url");

function normalizedPublicBaseUrl() {
  if (!publicBaseUrl) throw new Error("--public-base-url is required with --env-file.");
  return new URL(publicBaseUrl).toString().replace(/\/$/, "");
}

if (updateBaseUrl) {
  if (!envFile) throw new Error("--update-base-url requires --env-file.");
  const normalizedBaseUrl = normalizedPublicBaseUrl();
  const original = readFileSync(envFile, "utf8");
  const authMatches = original.match(/^AUTH_PUBLIC_BASE_URL=.*$/gm) || [];
  const desktopMatches = original.match(/^DEEPCREATOR_AUTH_BASE_URL=.*$/gm) || [];
  if (authMatches.length !== 1 || desktopMatches.length !== 1) throw new Error("Local auth configuration has an unexpected URL layout.");
  const updated = original
    .replace(/^AUTH_PUBLIC_BASE_URL=.*$/m, `AUTH_PUBLIC_BASE_URL=${normalizedBaseUrl}`)
    .replace(/^DEEPCREATOR_AUTH_BASE_URL=.*$/m, `DEEPCREATOR_AUTH_BASE_URL=${normalizedBaseUrl}`);
  writeFileSync(envFile, updated, { encoding: "utf8", mode: 0o600 });
  chmodSync(envFile, 0o600);
  process.stdout.write(`Updated the public URL in ${envFile}\n`);
  process.exit(0);
}

const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const privatePem = privateKey.export({ format: "pem", type: "pkcs8" });
const publicJwk = publicKey.export({ format: "jwk" });
const secrets = {
  privateKey: String(privatePem).trim(),
  publicJwk,
  tokenPepper: randomBytes(32).toString("base64url")
};

if (envFileFlag !== -1) {
  if (!envFile) throw new Error("--env-file requires a target path.");
  const normalizedBaseUrl = normalizedPublicBaseUrl();
  const publicJwkJson = JSON.stringify({ ...publicJwk, alg: "EdDSA", kid: "deepcreator-auth-dev-1", use: "sig" });
  const escapedPrivateKey = secrets.privateKey.replaceAll("\n", "\\n");
  const contents = [
    "NODE_ENV=development",
    "HOST=0.0.0.0",
    "PORT=8080",
    "DATABASE_URL=postgresql://deepcreator:deepcreator_dev@127.0.0.1:54329/deepcreator_auth",
    "DATABASE_SSL=disable",
    "AUTH_TRUST_PROXY_HOPS=1",
    `AUTH_PUBLIC_BASE_URL=${normalizedBaseUrl}`,
    "AUTH_SIGNING_KEY_ID=deepcreator-auth-dev-1",
    `AUTH_SIGNING_PRIVATE_KEY=\"${escapedPrivateKey}\"`,
    `AUTH_TOKEN_PEPPER=${secrets.tokenPepper}`,
    "GITHUB_CLIENT_ID=",
    "GITHUB_CLIENT_SECRET=",
    `DEEPCREATOR_AUTH_BASE_URL=${normalizedBaseUrl}`,
    `DEEPCREATOR_AUTH_PUBLIC_JWK='${publicJwkJson}'`,
    ""
  ].join("\n");
  writeFileSync(envFile, contents, { encoding: "utf8", flag: "wx", mode: 0o600 });
  process.stdout.write(`Created protected local auth configuration at ${envFile}\n`);
  process.exit(0);
}

process.stdout.write(`${JSON.stringify(secrets, null, 2)}\n`);
