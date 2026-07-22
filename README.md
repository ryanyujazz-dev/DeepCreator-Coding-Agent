# DeepSeeker CodeAgent

DeepSeeker is a local coding-agent desktop platform with DeepSeek as its default model. The repository contains an Electron shell, a React renderer, and a modular TypeScript Runtime served over an authenticated loopback HTTP/SSE boundary.

## Architecture

The product model is `Session -> Run -> Activity`, with immutable `Event` facts. SQLite is the only durable authority, while the frontend derives conversation timelines, grouped tool activity, plans, changes, approvals, and workspace surfaces from the same Event stream.

```text
server/bootstrap   composition
server/transport   HTTP and SSE
server/app         Runner and use cases
server/domain      policy
server/infra       SQLite, DeepSeek, files, commands
shared             contracts, reducer, projections, V1 decoder
src                React client
desktop            Electron Main, Preload bridge, Runtime worker
```

See [ADR 004](docs/adr/004-clean-runtime-architecture.md), [ADR 006](docs/adr/006-enterprise-modular-monolith.md), the normative [engineering architecture and code placement guide](docs/engineering-architecture.md), [naming conventions](docs/naming-conventions.md), and the [migration record](docs/enterprise-architecture-migration.md).

## Design and typography

The interface uses the unmodified **HarmonyOS Sans SC** variable font. Copyright 2021 Huawei Device Co., Ltd.; used under the HarmonyOS Sans Fonts License Agreement. See [third-party notices](THIRD_PARTY_NOTICES.md) and the [complete bundled license](src/assets/fonts/LICENSE-HarmonyOS-Sans.txt).

## Development

Requirements: Node.js 22 or newer and a configured DeepSeek API key.

```bash
npm install
npm run dev:all
```

The frontend opens at `http://127.0.0.1:5173`. The Runtime defaults to `http://127.0.0.1:8787`.

To run the desktop product, use:

```bash
npm run dev:desktop
```

Electron starts the Runtime in a `utilityProcess` on a random loopback port. The renderer is sandboxed and receives only a typed `window.deepseeker` bridge; it never receives the DeepSeek API key or raw Electron IPC primitives.

Useful commands:

```bash
npm run dev
npm run dev:runtime:watch
npm run dev:desktop
npm run typecheck
npm run test:architecture
npm test
npm run build
npm run check
npm run package:mac
```

Desktop Runtime data is stored in Electron's `userData/runtime` directory. A legacy project `.deepseeker` store is copied once when the desktop data directory is empty. Browser development keeps its local Runtime configuration, so the renderer can still be debugged without Electron.

`package:mac` creates an ad-hoc signed development application under `out/DeepSeeker-darwin-arm64`. It does not perform Developer ID signing, notarization, or distribution packaging. If Electron's GitHub download is unavailable on the local network, install the binary once with a trusted mirror configured through `ELECTRON_MIRROR`, then rerun the package command.

## Runtime API

```text
POST /api/sessions/:sessionId/runs
GET  /api/runs/:runId
POST /api/runs/:runId/cancel
GET  /api/sessions/:sessionId/events?afterOffset=<offset>
GET  /api/sessions/:sessionId/stream
```

DeepSeek-native response fields remain inside `server/infra/deepseek.ts`; public Events are provider-neutral and presentation-neutral.
