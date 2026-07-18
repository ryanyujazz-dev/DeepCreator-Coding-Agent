# ADR 001: Event-driven Agent Runtime

## Status

Superseded by [ADR 004](./004-clean-runtime-architecture.md)

## Context

The first prototype stores a complete agent run in memory and publishes that whole object after every mutation. This makes reconnects expensive, loses conversations on restart, and forces the UI to infer lifecycle state from loosely related model events.

DeepSeeker needs a stable product protocol that is independent from any model provider. DeepSeek response fields are transport details, not UI domain concepts.

## Historical Decision (V1)

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

Provider continuation state is stored outside the public signal protocol. Ordinary reasoning is scoped to one model step and is not added to later cycles. For DeepSeek tool-call assistant messages, the corresponding `reasoning_content`, structured `tool_calls`, and paired tool results are retained together for as long as that trajectory remains in model context, including later user cycles. Stable system instructions and tool schemas stay at the beginning of requests to preserve prefix-cache opportunities.

## V2 Resolution

ADR 004 keeps the event-driven principle but replaces the V1 vocabulary and storage model:

- `Session -> Run -> Activity`, with immutable `Event` facts;
- `deepseeker.events/v2` replaces `deepseeker.flow/v1` in active writes;
- SQLite replaces JSONL as the only authoritative store;
- Event append and projection update commit atomically;
- V1 JSONL is accepted only through `LegacyDecoder` when no SQLite Event history exists.

The names and JSONL authority described above remain here only to document the format consumed by the compatibility decoder.

## Historical Consequences

- Runtime and UI can evolve independently from DeepSeek response formats.
- Restart recovery and SSE resume are deterministic.
- The event log is append-only, while SQLite projections can be rebuilt later.
- Schema migrations and projection versioning become explicit responsibilities.
