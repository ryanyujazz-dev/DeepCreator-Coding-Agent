import { app, safeStorage, shell } from "electron";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { importJWK, JWK, jwtVerify } from "jose";
import { AuthDeleteInput, AuthMode, AuthState, AuthUser, LocalProfileInput } from "../shared/contracts/auth";
import { DesktopStore } from "./store";

type AuthManagerOptions = {
  onAuthenticated: () => Promise<void>;
  onSignedOut: () => Promise<void>;
  store: DesktopStore;
};

type StoredAuth = {
  deviceId: string;
  offlineGrant?: string;
  offlineUntil?: string;
  refreshToken?: string;
  user?: AuthUser;
};

type ActiveAttempt = {
  abort: AbortController;
  expiresAt: string;
  id: string;
  pollAfterMs: number;
  pollToken: string;
};

type AuthTokenBundle = {
  accessExpiresAt: string;
  accessToken: string;
  offlineGrant: string;
  offlineUntil: string;
  refreshExpiresAt: string;
  refreshToken: string;
  user: AuthUser;
};

type Listener = (state: AuthState) => void;
type AuthStateUpdate = Omit<AuthState, "mode"> & { mode?: AuthMode };

class AuthRequestError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "AuthRequestError";
  }
}

const developmentUser: AuthUser = {
  displayName: "本地开发者",
  githubLogin: "local-development",
  id: "00000000-0000-4000-8000-000000000001"
};

function localUser(id: string, profile: LocalProfileInput): AuthUser {
  return {
    avatar: profile.avatar,
    displayName: profile.displayName,
    githubLogin: "local",
    id
  };
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("账号服务返回了无效数据。");
  return value as Record<string, unknown>;
}

function stringField(value: Record<string, unknown>, key: string): string {
  if (typeof value[key] !== "string" || !value[key]) throw new Error(`账号服务缺少 ${key}。`);
  return value[key];
}

function userFrom(value: unknown): AuthUser {
  const input = record(value);
  let avatarUrl: string | undefined;
  if (typeof input.avatarUrl === "string") {
    try {
      const candidate = new URL(input.avatarUrl);
      if (candidate.protocol === "https:" && candidate.hostname === "avatars.githubusercontent.com") avatarUrl = candidate.toString();
    } catch {
      // Ignore untrusted avatar URLs.
    }
  }
  return {
    avatarUrl,
    displayName: stringField(input, "displayName"),
    githubLogin: stringField(input, "githubLogin"),
    id: stringField(input, "id")
  };
}

function bundleFrom(value: unknown): AuthTokenBundle {
  const input = record(value);
  return {
    accessExpiresAt: stringField(input, "accessExpiresAt"),
    accessToken: stringField(input, "accessToken"),
    offlineGrant: stringField(input, "offlineGrant"),
    offlineUntil: stringField(input, "offlineUntil"),
    refreshExpiresAt: stringField(input, "refreshExpiresAt"),
    refreshToken: stringField(input, "refreshToken"),
    user: userFrom(input.user)
  };
}

function detailFrom(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function runtimeFailureDetail(error: unknown): string {
  return `DeepCreator ${app.getVersion()} 本机运行服务启动失败：${detailFrom(error)}`;
}

export class AuthManager {
  private accessExpiresAt = 0;
  private accessToken = "";
  private activeAttempt?: ActiveAttempt;
  private listeners = new Set<Listener>();
  private readonly baseUrl = __DEEPCREATOR_AUTH_BASE_URL__.replace(/\/$/, "");
  private readonly mode: AuthMode = __DEEPCREATOR_AUTH_MODE__ === "github" ? "github" : "local";
  private readonly bypass = this.mode === "github" && !app.isPackaged && __DEEPCREATOR_DEV_AUTH_BYPASS__ === "1";
  private readonly filePath = path.join(app.getPath("userData"), "auth.json");
  private publicKey?: Awaited<ReturnType<typeof importJWK>>;
  private state: AuthState = { mode: this.mode, phase: "checking" };
  private stored: StoredAuth;

  constructor(private readonly options: AuthManagerOptions) {
    this.stored = this.read();
  }

  async initialize(): Promise<AuthState> {
    if (this.mode === "local") {
      return this.startLocalProfile();
    }
    if (this.bypass) {
      this.stored.user = developmentUser;
      this.options.store.activateProfile(developmentUser.id, { claimLegacy: false });
      try {
        await this.options.onAuthenticated();
        this.setState({ phase: "signed_in", user: developmentUser });
      } catch (error) {
        this.options.store.deactivateProfile();
        this.setState({ detail: runtimeFailureDetail(error), phase: "error" });
      }
      return this.getState();
    }
    if (!this.baseUrl || !__DEEPCREATOR_AUTH_PUBLIC_JWK__) {
      this.setState({ detail: "开发环境尚未配置账号服务。可配置服务地址，或显式启用本地开发身份。", phase: "error" });
      return this.getState();
    }
    try {
      const jwk = JSON.parse(__DEEPCREATOR_AUTH_PUBLIC_JWK__) as JWK;
      this.publicKey = await importJWK(jwk, "EdDSA");
    } catch {
      this.setState({ detail: "账号验签公钥无效。", phase: "error" });
      return this.getState();
    }
    if (!this.stored.user || !this.stored.refreshToken || !this.stored.offlineGrant) {
      if (this.stored.user || this.stored.refreshToken || this.stored.offlineGrant) this.clearCredentials();
      this.setState({ phase: "signed_out" });
      return this.getState();
    }
    let bundle: AuthTokenBundle;
    try {
      bundle = await this.refresh();
    } catch (error) {
      const sessionRejected = error instanceof AuthRequestError && (error.status === 401 || error.status === 403);
      if (!sessionRejected && await this.canUseOffline()) {
        this.options.store.activateProfile(this.stored.user.id);
        try {
          await this.options.onAuthenticated();
          this.setState({
            detail: "当前处于离线模式，联网后会自动刷新账号状态。",
            offlineUntil: this.stored.offlineUntil,
            phase: "offline",
            user: this.stored.user
          });
        } catch (runtimeError) {
          this.options.store.deactivateProfile();
          this.setState({ detail: runtimeFailureDetail(runtimeError), phase: "error" });
        }
      } else {
        this.clearCredentials();
        this.setState({ detail: detailFrom(error), phase: "expired" });
      }
      return this.getState();
    }
    try {
      await this.acceptBundle(bundle, "signed_in");
    } catch (error) {
      this.options.store.deactivateProfile();
      this.setState({ detail: runtimeFailureDetail(error), phase: "error" });
    }
    return this.getState();
  }

  getState(): AuthState {
    return structuredClone(this.state);
  }

  authenticated(): boolean {
    return this.state.phase === "signed_in" || this.state.phase === "offline";
  }

  onState(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async signIn(): Promise<AuthState> {
    if (this.mode === "local") {
      if (this.authenticated()) return this.getState();
      return this.startLocalProfile();
    }
    if (this.bypass) return this.getState();
    if (!this.baseUrl || !this.publicKey) {
      this.setState({ detail: "账号服务尚未配置。", phase: "error" });
      return this.getState();
    }
    await this.cancelSignIn();
    const response = await this.request("/v1/auth/attempts", {
      body: JSON.stringify({ appVersion: app.getVersion(), deviceId: this.stored.deviceId, platform: process.platform }),
      headers: { "content-type": "application/json" },
      method: "POST"
    });
    const input = record(await response.json());
    const authorizeUrl = stringField(input, "authorizeUrl");
    const authorizeTarget = new URL(authorizeUrl);
    if (authorizeTarget.origin !== "https://github.com" || authorizeTarget.pathname !== "/login/oauth/authorize") {
      throw new Error("账号服务返回了无效的 GitHub 授权地址。");
    }
    this.activeAttempt = {
      abort: new AbortController(),
      expiresAt: stringField(input, "expiresAt"),
      id: stringField(input, "attemptId"),
      pollAfterMs: typeof input.pollAfterMs === "number" ? input.pollAfterMs : 2_000,
      pollToken: stringField(input, "pollToken")
    };
    this.setState({ attempt: { expiresAt: this.activeAttempt.expiresAt, provider: "github" }, phase: "authorizing" });
    await shell.openExternal(authorizeUrl);
    void this.poll(this.activeAttempt);
    return this.getState();
  }

  async cancelSignIn(): Promise<AuthState> {
    if (this.mode === "local") return this.getState();
    const attempt = this.activeAttempt;
    this.activeAttempt = undefined;
    attempt?.abort.abort();
    if (attempt && this.baseUrl) {
      void this.request(`/v1/auth/attempts/${encodeURIComponent(attempt.id)}`, {
        body: JSON.stringify({ pollToken: attempt.pollToken }),
        headers: { "content-type": "application/json" },
        method: "DELETE"
      }).catch(() => undefined);
    }
    if (this.state.phase === "authorizing") this.setState({ phase: "signed_out" });
    return this.getState();
  }

  async signOut(): Promise<AuthState> {
    if (this.mode === "local") return this.getState();
    await this.cancelSignIn();
    const refreshToken = this.decrypt(this.stored.refreshToken);
    if (refreshToken && this.baseUrl) {
      await this.request("/v1/auth/sessions/logout", {
        body: JSON.stringify({ refreshToken }),
        headers: { "content-type": "application/json" },
        method: "POST"
      }).catch(() => undefined);
    }
    await this.options.onSignedOut();
    this.options.store.deactivateProfile();
    this.clearCredentials();
    this.setState({ phase: "signed_out" });
    return this.getState();
  }

  async updateLocalProfile(input: LocalProfileInput): Promise<AuthState> {
    if (this.mode !== "local") throw new Error("当前发行版不使用本地 Profile。");
    if (!this.authenticated()) throw new Error("本地 Profile 尚未准备好。");
    const profile = this.options.store.saveLocalProfile(input);
    const user = localUser(this.options.store.localProfileId(), profile);
    this.setState({ phase: "signed_in", profileSetupRequired: false, user });
    return this.getState();
  }

  async deleteAccount(input: AuthDeleteInput): Promise<AuthState> {
    if (input.confirmation !== "DELETE") throw new Error("注销确认无效。");
    if (this.mode === "local") throw new Error("本地 Profile 不属于云端账号，无法注销。");
    if (!this.state.user) throw new Error("用户尚未登录。");
    if (this.state.phase === "offline") throw new Error("注销账号需要连接网络。");
    const accessToken = await this.ensureAccessToken();
    await this.request("/v1/account", { headers: { authorization: `Bearer ${accessToken}` }, method: "DELETE" });
    const profileDirectory = this.options.store.activeProfileDirectory();
    const cleanupIssues: string[] = [];
    try {
      await this.options.onSignedOut();
    } catch (error) {
      cleanupIssues.push(`本机运行服务未能正常停止：${detailFrom(error)}`);
    }
    this.options.store.deactivateProfile();
    this.clearCredentials();
    try {
      await shell.trashItem(profileDirectory);
    } catch (error) {
      cleanupIssues.push(`本机资料未能移入废纸篓：${detailFrom(error)}`);
    }
    this.setState({ detail: cleanupIssues.length ? `账号已注销；${cleanupIssues.join("；")}` : undefined, phase: "signed_out" });
    return this.getState();
  }

  private async poll(attempt: ActiveAttempt): Promise<void> {
    while (this.activeAttempt === attempt && Date.parse(attempt.expiresAt) > Date.now()) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, attempt.pollAfterMs);
        attempt.abort.signal.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
      });
      if (this.activeAttempt !== attempt || attempt.abort.signal.aborted) return;
      try {
        const response = await fetch(`${this.baseUrl}/v1/auth/attempts/${encodeURIComponent(attempt.id)}/exchange`, {
          body: JSON.stringify({ pollToken: attempt.pollToken }),
          headers: { "content-type": "application/json" },
          method: "POST",
          redirect: "error",
          signal: attempt.abort.signal
        });
        if (response.status === 202) {
          const pending = record(await response.json());
          if (typeof pending.pollAfterMs === "number") attempt.pollAfterMs = pending.pollAfterMs;
          continue;
        }
        if (!response.ok) throw new Error(response.status === 410 ? "GitHub 授权已过期，请重试。" : "GitHub 授权未完成。");
        const bundle = bundleFrom(await response.json());
        this.activeAttempt = undefined;
        await this.acceptBundle(bundle, "signed_in");
        return;
      } catch (error) {
        if (attempt.abort.signal.aborted) return;
        this.activeAttempt = undefined;
        this.setState({ detail: detailFrom(error), phase: "error" });
        return;
      }
    }
    if (this.activeAttempt === attempt) {
      this.activeAttempt = undefined;
      this.setState({ detail: "GitHub 授权已过期，请重新登录。", phase: "expired" });
    }
  }

  private async acceptBundle(bundle: AuthTokenBundle, phase: "signed_in" | "offline", startRuntime = true): Promise<void> {
    await this.verifyOfflineGrant(bundle.offlineGrant, bundle.user);
    this.accessToken = bundle.accessToken;
    this.accessExpiresAt = Date.parse(bundle.accessExpiresAt);
    this.stored.user = bundle.user;
    this.stored.offlineUntil = bundle.offlineUntil;
    if (safeStorage.isEncryptionAvailable()) {
      this.stored.refreshToken = this.encrypt(bundle.refreshToken);
      this.stored.offlineGrant = this.encrypt(bundle.offlineGrant);
      this.write();
    } else {
      delete this.stored.refreshToken;
      delete this.stored.offlineGrant;
    }
    this.options.store.activateProfile(bundle.user.id);
    if (startRuntime) await this.options.onAuthenticated();
    this.setState({ offlineUntil: bundle.offlineUntil, phase, user: bundle.user });
  }

  private async canUseOffline(): Promise<boolean> {
    const user = this.stored.user;
    const grant = this.decrypt(this.stored.offlineGrant);
    if (!user || !grant || !this.stored.offlineUntil || Date.parse(this.stored.offlineUntil) <= Date.now()) return false;
    try {
      await this.verifyOfflineGrant(grant, user);
      return true;
    } catch {
      return false;
    }
  }

  private async verifyOfflineGrant(grant: string, user: AuthUser): Promise<void> {
    if (!this.publicKey) throw new Error("账号验签公钥不可用。");
    const result = await jwtVerify(grant, this.publicKey, {
      audience: "deepcreator-desktop",
      issuer: this.baseUrl
    });
    if (result.payload.typ !== "offline" || result.payload.sub !== user.id || result.payload.deviceId !== this.stored.deviceId) {
      throw new Error("离线凭证无效。");
    }
  }

  private async refresh(): Promise<AuthTokenBundle> {
    const refreshToken = this.decrypt(this.stored.refreshToken);
    if (!refreshToken) throw new Error("登录会话已失效。");
    const response = await this.request("/v1/auth/sessions/refresh", {
      body: JSON.stringify({ deviceId: this.stored.deviceId, refreshToken }),
      headers: { "content-type": "application/json" },
      method: "POST"
    });
    return bundleFrom(await response.json());
  }

  private async ensureAccessToken(): Promise<string> {
    if (this.accessToken && this.accessExpiresAt > Date.now() + 30_000) return this.accessToken;
    const bundle = await this.refresh();
    await this.acceptBundle(bundle, "signed_in", false);
    return bundle.accessToken;
  }

  private async request(endpoint: string, init: RequestInit): Promise<Response> {
    const response = await fetch(`${this.baseUrl}${endpoint}`, { ...init, redirect: "error", signal: AbortSignal.timeout(15_000) });
    if (response.ok) return response;
    let detail = "账号服务暂时不可用。";
    try {
      const payload = record(await response.json());
      if (typeof payload.error === "string") detail = payload.error;
    } catch {
      // Preserve the generic transport error.
    }
    throw new AuthRequestError(detail, response.status);
  }

  private clearCredentials(): void {
    this.accessToken = "";
    this.accessExpiresAt = 0;
    delete this.stored.offlineGrant;
    delete this.stored.offlineUntil;
    delete this.stored.refreshToken;
    delete this.stored.user;
    this.write();
  }

  private decrypt(value?: string): string {
    if (!value || !safeStorage.isEncryptionAvailable()) return "";
    try {
      return safeStorage.decryptString(Buffer.from(value, "base64"));
    } catch {
      return "";
    }
  }

  private encrypt(value: string): string {
    return safeStorage.encryptString(value).toString("base64");
  }

  private read(): StoredAuth {
    try {
      const parsed = existsSync(this.filePath) ? JSON.parse(readFileSync(this.filePath, "utf8")) as Partial<StoredAuth> : {};
      let user: AuthUser | undefined;
      if (parsed.user && typeof parsed.user === "object") {
        try {
          user = userFrom(parsed.user);
        } catch {
          user = undefined;
        }
      }
      return {
        deviceId: typeof parsed.deviceId === "string" ? parsed.deviceId : randomUUID(),
        offlineGrant: typeof parsed.offlineGrant === "string" ? parsed.offlineGrant : undefined,
        offlineUntil: typeof parsed.offlineUntil === "string" ? parsed.offlineUntil : undefined,
        refreshToken: typeof parsed.refreshToken === "string" ? parsed.refreshToken : undefined,
        user
      };
    } catch {
      return { deviceId: randomUUID() };
    }
  }

  private write(): void {
    mkdirSync(path.dirname(this.filePath), { recursive: true });
    const temporaryPath = `${this.filePath}.${process.pid}.tmp`;
    writeFileSync(temporaryPath, `${JSON.stringify(this.stored, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    renameSync(temporaryPath, this.filePath);
  }

  private async startLocalProfile(): Promise<AuthState> {
    const id = this.options.store.localProfileId();
    this.options.store.activateProfile(id);
    const user = localUser(id, this.options.store.localProfile());
    this.setState({ phase: "checking", user });
    try {
      await this.options.onAuthenticated();
      this.setState({ phase: "signed_in", profileSetupRequired: this.options.store.localProfileSetupRequired(), user });
    } catch (error) {
      this.options.store.deactivateProfile();
      this.setState({ detail: runtimeFailureDetail(error), phase: "error", user });
    }
    return this.getState();
  }

  private setState(state: AuthStateUpdate): void {
    this.state = { ...state, mode: state.mode ?? this.mode };
    for (const listener of this.listeners) listener(this.getState());
  }
}
