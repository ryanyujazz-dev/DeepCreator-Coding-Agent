# ADR 004: Clean Runtime Architecture V2

## Status

Accepted

## Context

DeepSeeker has validated a local coding-agent vertical slice: durable conversations, a streamed agent loop, tool execution, approvals, context compaction, change review, and a multi-surface frontend. The prototype now has two structural problems.

First, its vocabulary exposes implementation history rather than product concepts. Names such as `WorkspaceSessionView`, `WorkCycle`, `ActivityUnitView`, and `AgentSignal` create distinctions that do not exist in the current model and repeat architectural context in every symbol.

Second, `SignalStore` owns unrelated responsibilities: JSONL logging, SQLite schema creation, events, projections, context history, memory, metrics, subscriptions, and startup recovery. JSONL and SQLite are both treated as durable authorities, so an interrupted write can leave two competing histories.

The Runtime needs a stable foundation before adding desktop IPC, browser control, terminal surfaces, plugins, multiple providers, or remote execution.

## Decision

### Domain language

The canonical domain is:

```text
Session -> Run -> Activity
Event records their changes.
```

- `Session` is a durable project conversation.
- `Run` is all work caused by one user request.
- `Activity` is one visible or auditable occurrence inside a Run.
- `Event` is an immutable, ordered fact.

The complete vocabulary and suffix rules are defined in `docs/naming-conventions.md` and are normative.

### Event protocol

New events use `deepseeker.events/v2` and the envelope:

```text
version, eventId, offset, type, scope, at, data
```

The protocol is provider-neutral and presentation-neutral. Provider fields, rendered labels, expansion state, and activity grouping are not durable Event data.

V1 data is accepted only through `LegacyDecoder`. The Runtime does not dual-write V1 and V2.

### Module boundaries

The Runtime remains a modular monolith with this dependency direction:

```text
transport / infra -> app -> domain / contracts
```

- `domain` owns state, Events, transitions, and pure reducers.
- `app` owns use cases and Run orchestration.
- `infra` owns SQLite, DeepSeek, the file system, processes, and clocks.
- `transport` maps HTTP and SSE to application use cases.
- `bootstrap` composes concrete implementations.
- `shared/contracts` contains provider-neutral client contracts.
- `shared/schemas` validates wire input at runtime.

The frontend consumes contracts and projections. It does not infer execution truth from labels or raw provider streams.

### Persistence

`runtime.sqlite` is the only authoritative store.

- Event append and affected Session/Run projection writes occur in one SQLite transaction.
- Live subscribers are notified only after commit.
- A disconnected client resumes with `sessionId + afterOffset`.
- JSONL is an optional audit export and is not part of the write transaction.
- Schema changes use ordered, idempotent migrations.
- Existing V1 JSONL may be imported when SQLite has no corresponding history, but it is never preferred over committed SQLite Events.

An Outbox is not required for the local single-process Runtime. A missed in-memory notification is recovered by Event replay.

### Runtime boundaries

- `Runner` coordinates a Run but does not implement HTTP, SQL, provider parsing, or UI grouping.
- `Provider` normalizes model requests, deltas, responses, usage, and protocol failures.
- `ContextBuilder` creates provider requests from CorePrompt, Rules, History, Evidence, and Checkpoints.
- `ToolPipeline` performs normalize, validate, authorize, checkpoint, execute, and record stages.
- `AccessPolicy` is a hard Runtime boundary. `Rules` are model guidance.
- `RunRegistry` owns only ephemeral abort handles, processes, and pending approvals.
- `GroupProjector` derives user-facing activity groups.
- `Surface` is the frontend extension boundary for files, reviews, terminals, browsers, Markdown, and artifacts.

### DeepSeek boundary

DeepSeek `reasoning_content`, `content`, `tool_calls`, finish reasons, SSE chunks, and cache fields are normalized inside the Provider implementation.

Reasoning is not public Event data and is not rendered. Provider-required reasoning for a tool continuation may be retained in History with its assistant tool call and paired tool results.

### Transport

REST commands and SSE Events remain the V2 local transport. Application use cases must not depend on Fastify so Electron IPC or another transport can be added later without moving agent logic.

## Migration

1. Preserve and verify current behavior.
2. Introduce V2 contracts, pure reducer, state machine, and LegacyDecoder.
3. Migrate Runtime producers and frontend consumers vertically.
4. Move SQLite schema changes to ordered migrations.
5. Make SQLite Events authoritative and remove synchronous JSONL writes.
6. Split stores and Runtime roles along the boundaries above.
7. Remove temporary aliases and old names from active source.

Rollback before completion uses the last V1-compatible Git commit and the existing `.deepseeker` directory. Once V2 writes production data, rollback requires retaining the V2 decoder or restoring a pre-migration data backup.

## Deferred

- Microservices and remote execution
- A package workspace or published SDK
- JSON-RPC or WebSocket transport
- Multi-agent coordination
- Semantic indexing
- Plugin marketplace
- Electron main-process business logic
- ORM, CQRS framework, Outbox, or message broker

## Consequences

- Product, Runtime, frontend, and persistence share one concise language.
- Existing data requires an explicit compatibility decoder.
- SQLite transaction boundaries become testable and authoritative.
- Runtime files can be split incrementally without changing deployment.
- Future providers and clients depend on stable contracts rather than DeepSeek or Fastify details.
