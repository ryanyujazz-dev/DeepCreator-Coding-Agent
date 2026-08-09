# DeepCreator 账号服务部署指南

> DeepCreator 默认使用本地 Profile，用户安装后无需登录即可使用。本指南只适用于需要显式启用 GitHub 云端身份的发行版。

## 交付边界

账号服务是标准 OCI/Docker 容器，只依赖一个可通过 TLS 连接的 PostgreSQL 数据库。它不绑定 CloudBase、腾讯云或其他特定平台；任何能提供稳定 HTTPS 地址、持久环境变量和容器健康检查的平台都可以承载。

当前版本使用 GitHub 浏览器授权。没有自有域名时，可直接使用容器平台分配的 HTTPS 地址，例如：

```text
https://<platform-host>/v1/auth/github/callback
```

此地址必须与 GitHub OAuth App 的 Authorization callback URL 完全一致。

## 必需配置

| 变量 | 作用 |
| --- | --- |
| `DATABASE_URL` | PostgreSQL 连接串 |
| `DATABASE_SSL` | 生产环境保持启用；本地容器可设为 `disable` |
| `AUTH_TRUST_PROXY_HOPS` | 可选；仅在平台明确提供反向代理时填写准确代理跳数，禁止盲目信任转发头 |
| `AUTH_PUBLIC_BASE_URL` | 账号服务的公开 HTTPS 根地址 |
| `AUTH_SIGNING_PRIVATE_KEY` | Ed25519 PKCS#8 私钥，仅存在服务端秘密存储 |
| `AUTH_SIGNING_KEY_ID` | 当前签名密钥标识 |
| `AUTH_TOKEN_PEPPER` | 至少 32 随机字节，用于哈希轮询与刷新令牌 |
| `GITHUB_CLIENT_ID` | GitHub OAuth App Client ID |
| `GITHUB_CLIENT_SECRET` | GitHub OAuth App Client Secret，仅存在服务端 |

运行 `npm run auth:secrets` 可以生成私钥、公开 JWK 和 Token Pepper。私钥及 Pepper 不得提交到仓库；公开 JWK 用于构建桌面发布包。

## GitHub OAuth App

1. 在 GitHub Developer Settings 中创建 OAuth App。
2. Homepage URL 可先填写容器平台公开地址。
3. Authorization callback URL 填写 `<AUTH_PUBLIC_BASE_URL>/v1/auth/github/callback`。
4. 不启用 Device Flow。
5. 将 Client ID 和 Client Secret 注入账号容器。

DeepCreator 不发送 OAuth `scope`，只读取 GitHub 的公开用户 ID、用户名、昵称和头像。临时 GitHub Token 读取身份后会立即撤销，不写入 PostgreSQL。

## 数据库与容器

从仓库根目录构建：

```sh
docker build -f services/auth/Dockerfile -t deepcreator-auth .
```

生产数据库应启用 TLS、自动备份和时间点恢复。账号容器至少配置一个实例；如果平台会缩容到零，需要确认 GitHub 回调和登录轮询不会因冷启动超时。健康检查使用 `/healthz`。

首次启动会按文件名顺序执行 `services/auth/migrations` 中尚未应用的版本迁移，并通过 PostgreSQL advisory lock 避免多实例竞争。生产变更窗口也可以先运行 `npm run auth:migrate`，再发布新镜像。

## 桌面发布配置

本地 Profile 是默认发布模式，不需要账号服务配置：

```text
DEEPCREATOR_AUTH_MODE=local
```

只有 GitHub 账号模式的正式打包才必须同时注入：

```text
DEEPCREATOR_AUTH_MODE=github
DEEPCREATOR_AUTH_BASE_URL=https://<platform-host>
DEEPCREATOR_AUTH_PUBLIC_JWK={"kty":"OKP","crv":"Ed25519",...}
```

GitHub 模式缺少任意配置、账号地址不是 HTTPS，或 JWK 不是 Ed25519 公钥时，Electron Forge 会拒绝生成发布包。开发环境的本地 Profile 可使用：

```sh
npm run dev:desktop:local-auth
```

该命令显式选择本地 Profile；普通的 `npm run dev:desktop` 默认也是本地模式。

仓库默认的 GitHub Release 流水线发布本地 Profile 版本，不读取账号服务变量。如果将发行版切换为 GitHub 模式，账号服务上线并确认 JWKS 后再为流水线配置上述公开变量；私钥绝不能进入桌面构建或 GitHub 仓库变量。

## 上线检查

- `/healthz` 返回 `200`，JWKS 只包含公钥且没有 `d` 字段。
- GitHub 回调成功后桌面端能在 10 分钟内一次性交换会话。
- 旧刷新令牌重放会撤销对应会话。
- 数据库日志、HTTP 日志和平台监控不记录授权码、GitHub Token、刷新令牌或轮询密钥。
- 平台访问日志必须对 GitHub 回调查询参数做脱敏或关闭该路径的查询串记录。
- PostgreSQL 备份恢复经过演练；服务会保留安全审计记录 90 天，并定期清理过期登录事务和会话。
- 启用 GitHub 模式时，macOS 和 Windows 发布包均使用同一个 HTTPS 账号地址和公钥。
