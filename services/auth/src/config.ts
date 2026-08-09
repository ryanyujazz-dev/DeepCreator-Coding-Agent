import { createPrivateKey, KeyObject } from "node:crypto";
import { importJWK, importPKCS8, JWK } from "jose";

type PrivateKey = Awaited<ReturnType<typeof importPKCS8>>;
type PublicKey = Awaited<ReturnType<typeof importJWK>>;

export type AuthConfig = {
  audience: string;
  githubApiUrl: string;
  githubAuthorizeUrl: string;
  githubClientId: string;
  githubClientSecret: string;
  githubTokenUrl: string;
  host: string;
  issuer: string;
  keyId: string;
  port: number;
  privateKey: PrivateKey;
  privateKeyObject: KeyObject;
  publicJwk: JWK;
  publicKey: PublicKey;
  publicBaseUrl: string;
  tokenPepper: string;
  trustProxy: false | number;
};

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value.replaceAll("\\n", "\n");
}

function normalizedBaseUrl(value: string): string {
  const url = new URL(value);
  const development = process.env.NODE_ENV !== "production";
  if (url.protocol !== "https:" && !(development && url.protocol === "http:")) {
    throw new Error("AUTH_PUBLIC_BASE_URL must use HTTPS outside development.");
  }
  if (url.username || url.password || url.search || url.hash) throw new Error("AUTH_PUBLIC_BASE_URL must not contain credentials, a query, or a fragment.");
  return url.toString().replace(/\/$/, "");
}

function trustProxySetting(): false | number {
  const raw = process.env.AUTH_TRUST_PROXY_HOPS?.trim();
  if (!raw) return false;
  const hops = Number(raw);
  if (!Number.isInteger(hops) || hops < 1 || hops > 10) throw new Error("AUTH_TRUST_PROXY_HOPS must be an integer between 1 and 10.");
  return hops;
}

export async function loadAuthConfig(): Promise<AuthConfig> {
  const publicBaseUrl = normalizedBaseUrl(required("AUTH_PUBLIC_BASE_URL"));
  const privateKeyPem = required("AUTH_SIGNING_PRIVATE_KEY");
  const tokenPepper = required("AUTH_TOKEN_PEPPER");
  if (Buffer.byteLength(tokenPepper, "utf8") < 32) throw new Error("AUTH_TOKEN_PEPPER must contain at least 32 bytes.");
  const port = Number(process.env.PORT || 8080);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("PORT must be an integer between 1 and 65535.");
  const privateKeyObject = createPrivateKey(privateKeyPem);
  if (privateKeyObject.asymmetricKeyType !== "ed25519") throw new Error("AUTH_SIGNING_PRIVATE_KEY must be an Ed25519 private key.");
  const exported = privateKeyObject.export({ format: "jwk" });
  const { d: _private, ...publicJwk } = exported;
  return {
    audience: "deepcreator-desktop",
    githubApiUrl: (process.env.GITHUB_API_URL?.trim() || "https://api.github.com").replace(/\/$/, ""),
    githubAuthorizeUrl: process.env.GITHUB_AUTHORIZE_URL?.trim() || "https://github.com/login/oauth/authorize",
    githubClientId: required("GITHUB_CLIENT_ID"),
    githubClientSecret: required("GITHUB_CLIENT_SECRET"),
    githubTokenUrl: process.env.GITHUB_TOKEN_URL?.trim() || "https://github.com/login/oauth/access_token",
    host: process.env.HOST?.trim() || "0.0.0.0",
    issuer: publicBaseUrl,
    keyId: process.env.AUTH_SIGNING_KEY_ID?.trim() || "deepcreator-auth-1",
    port,
    privateKey: await importPKCS8(privateKeyPem, "EdDSA"),
    privateKeyObject,
    publicJwk,
    publicKey: await importJWK(publicJwk, "EdDSA"),
    publicBaseUrl,
    tokenPepper,
    trustProxy: trustProxySetting()
  };
}
