# Runtime V2 Migration Record

## Status

Implemented on the `main` branch after baseline commit `195477a`.

## Result

DeepCreator now uses one concise product language:

```text
Session -> Run -> Activity
              |
            Event
```

- `Session` is a durable project conversation.
- `Run` contains all work caused by one user request.
- `Activity` is one visible or auditable occurrence.
- `Event` is an immutable ordered fact.

The canonical contract is `deepcreator.events/v2`. New code writes V2 only.

## Module Map

```text
server/bootstrap   composition and process startup
server/transport   HTTP and SSE adapters
server/app         Runner, use cases, ports, ToolPipeline
server/domain      access and evidence policy
server/infra       SQLite, DeepSeek, filesystem, commands, config
shared/contracts   provider-neutral public contracts
shared/domain      pure state and Event reducer
shared/projections derived activity groups for the UI
shared/legacy      isolated V1 decoder
src                React client and workspace surfaces
```

The dependency direction is:

```text
bootstrap / transport / infra -> app -> domain / contracts
```

`app`, `domain`, and `shared` do not read environment variables or import filesystem, process, HTTP, or SQLite implementations.

## Persistence

`.deepcreator/runtime.sqlite` is the only authority.

- Ordered SQL files in `server/infra/migrations` own schema evolution.
- `EventStore` commits an Event and its reduced Session projection in one transaction.
- Subscribers are notified only after commit.
- Clients reconnect with `sessionId + afterOffset` and deduplicate by `eventId` and offset.
- Startup deterministically marks interrupted Runs as failed.
- JSONL is not part of the active write path.

Durable responsibilities are split into `EventStore`, `SessionStore`, `ContextStore`, `MemoryStore`, `MetricStore`, and `EvidenceStore`. `RuntimeStore` is a concrete infrastructure facade; application code depends on the narrower `RuntimeRepo` port.

## Runtime Flow

```text
HTTP/IPC command
      |
    Runner
      |
 ContextBuilder -> Provider
      |              |
      +--------- ToolCall
                    |
              ToolPipeline
 normalize -> validate -> authorize -> checkpoint -> execute -> record
                    |
                  Event
```

`RunRegistry` owns only ephemeral abort controllers and pending approvals. `AccessPolicy` decides side-effect permission. Project Rules guide the model but cannot grant authority.

## Transport

The V2 local API uses:

```text
POST /api/sessions/:sessionId/runs
GET  /api/runs/:runId
POST /api/runs/:runId/cancel
GET  /api/sessions/:sessionId/events?afterOffset=<offset>
GET  /api/sessions/:sessionId/stream
POST /api/approvals/:approvalId/resolve
```

`createHttp` receives its dependencies and does not construct the Runtime. This keeps Electron IPC, tests, and future transports outside Runner.

## DeepSeek Boundary

The Provider normalizes `reasoning_content`, `content`, `tool_calls`, streaming chunks, usage, and finish causes. Those private fields never enter public Events.

Ordinary reasoning is not rendered or persisted as public state. Provider-required reasoning is retained only with the assistant tool call and paired tool results while that trajectory remains in model History.

## V1 Compatibility

`shared/legacy/decoder.ts` is the only active source allowed to understand `deepcreator.flow/v1` names such as `sessionKey`, `cycleKey`, `signalKey`, and `cycle.executing`.

At startup, V1 JSONL is imported only when SQLite contains no Events for that Session. Imported facts are normalized into V2 before reduction. The Runtime never dual-writes V1 and V2 and never prefers V1 over committed SQLite history.

## Verification

The acceptance suite proves:

- real V1 fixtures decode into V2 state;
- interrupted imported and native Runs settle deterministically;
- Event and projection writes roll back together;
- replay after an offset is ordered and deduplicated;
- migrations are idempotent;
- DeepSeek private fields do not leak into Event JSON;
- V2 REST and SSE routes register correctly;
- prompt ordering, cache-prefix stability, tool pairing, compaction, approval, grouping, and UI projections remain compatible.

Run the checks with:

```bash
npx tsc --noEmit
npm test
npm run build
```

## Deferred

This migration intentionally does not introduce microservices, a broker, an ORM, remote execution, multi-agent orchestration, or desktop-process business logic. Those additions should extend the contracts and ports above rather than bypass them.
