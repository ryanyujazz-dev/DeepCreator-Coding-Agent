# DeepCreator Auth Service

DeepCreator Auth Service is the portable account boundary used by the desktop application. It runs as a standard Node.js container, stores account/session records in PostgreSQL, and uses GitHub only to verify public user identity.

It does not receive project files, conversations, Skills, model API keys, or GitHub repository permissions.

## Local setup

1. Start PostgreSQL with `docker compose -f services/auth/docker-compose.yml up -d`.
2. Generate an Ed25519 signing key, public JWK, and token pepper with `npm run auth:secrets`.
3. Copy `services/auth/.env.example` to an ignored local environment file and fill in the generated values plus a GitHub OAuth App client ID and secret.
4. Register the callback URL as `http://127.0.0.1:8080/v1/auth/github/callback` for local development.
5. Load the environment variables, then run `npm run auth:migrate` and `npm run dev:auth`.

The desktop application can either connect to the service with `DEEPCREATOR_AUTH_BASE_URL` and `DEEPCREATOR_AUTH_PUBLIC_JWK`, or run with an isolated local developer identity through `npm run dev:desktop:local-auth`.

## Container contract

Build from the repository root:

```sh
docker build -f services/auth/Dockerfile -t deepcreator-auth .
```

The container listens on port `8080`, exposes `/healthz`, runs versioned idempotent migrations during startup, and runs as an unprivileged user. See [the deployment guide](../../docs/auth-service-deployment.md) for the complete environment and rollout checklist.
