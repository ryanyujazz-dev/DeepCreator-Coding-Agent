# DeepSeeker CodeAgent

DeepSeeker is a local coding-agent desktop platform with DeepSeek as its default model. The current repository contains the React client and a modular TypeScript Runtime served over HTTP and SSE.

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
```

See [ADR 004](docs/adr/004-clean-runtime-architecture.md), [context architecture](docs/adr/003-context-operating-system.md), and the [naming conventions](docs/naming-conventions.md).

## Development

Requirements: Node.js 22 or newer and a configured DeepSeek API key.

```bash
npm install
npm run dev:all
```

The frontend opens at `http://127.0.0.1:5173`. The Runtime defaults to `http://127.0.0.1:8787`.

Useful commands:

```bash
npm run dev
npm run dev:runtime:watch
npx tsc --noEmit
npm test
npm run build
```

Runtime data is stored under the selected project's `.deepseeker/runtime.sqlite`. V1 JSONL histories are read only through the compatibility decoder and are never written by V2.

## Runtime API

```text
POST /api/sessions/:sessionId/runs
GET  /api/runs/:runId
POST /api/runs/:runId/cancel
GET  /api/sessions/:sessionId/events?afterOffset=<offset>
GET  /api/sessions/:sessionId/stream
```

DeepSeek-native response fields remain inside `server/infra/deepseek.ts`; public Events are provider-neutral and presentation-neutral.
