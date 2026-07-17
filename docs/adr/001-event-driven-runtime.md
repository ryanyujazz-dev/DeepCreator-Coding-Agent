# ADR 001: Event-driven Agent Runtime

## Status

Accepted

## Context

The first prototype stores a complete agent run in memory and publishes that whole object after every mutation. This makes reconnects expensive, loses conversations on restart, and forces the UI to infer lifecycle state from loosely related model events.

DeepSeeker needs a stable product protocol that is independent from any model provider. DeepSeek response fields are transport details, not UI domain concepts.

## Decision

The runtime uses these domain objects:

- `WorkspaceSession`: a durable project conversation.
- `WorkCycle`: one user request and all agent work caused by it.
- `ActivityUnit`: one typed piece of visible or auditable work.
- `AgentSignal`: an immutable fact published by the runtime.
- `SessionView` and `CycleView`: materialized read models.

Every signal contains `contract`, `signalKey`, `offset`, `topic`, `scope`, `emittedAt`, and `payload`. Offsets increase within a session. Clients deduplicate by `signalKey` and resume after their last applied offset.

Lifecycle transitions are explicit:

```text
cycle.accepted -> cycle.executing -> cycle.settled
unit.opened -> zero or more typed deltas -> unit.sealed
```

`unit.sealed` and `cycle.settled` are authoritative. Plans and workspace changes are replacement projections, not inferred incremental claims.

## State layers

1. An append-only JSONL signal log is the durable fact stream.
2. SQLite stores queryable session and cycle projections plus a signal index.
3. A live registry owns abort controllers, pending approvals, and running processes.
4. The frontend store hydrates a snapshot once and then reduces incremental signals.

## Provider boundary

Providers emit normalized fragments: thinking, answer, tool-call, usage, and finish fragments. DeepSeek-specific `reasoning_content`, `content`, and `tool_calls` never appear in the public domain protocol.

Provider continuation state is scoped to one `WorkCycle`. It may retain reasoning required to continue a DeepSeek tool loop, but historical reasoning is not added to later user cycles. Stable system instructions and tool schemas stay at the beginning of requests to preserve prefix-cache opportunities.

## Consequences

- Runtime and UI can evolve independently from DeepSeek response formats.
- Restart recovery and SSE resume are deterministic.
- The event log is append-only, while SQLite projections can be rebuilt later.
- Schema migrations and projection versioning become explicit responsibilities.

