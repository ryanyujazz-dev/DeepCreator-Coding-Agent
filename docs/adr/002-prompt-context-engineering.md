# ADR 002: Layered Prompt and Context Engineering

## Status

Accepted

## Context

The initial Runtime rebuilt model history from each successful WorkCycle's user prompt and final response. This discarded tool requests, tool evidence, failures, and intermediate assistant messages. Compaction concatenated text and cut it by character count, while dynamic project state was embedded in the system prompt. The result was difficult to recover, expensive for prefix caching, and incompatible with DeepSeek V4's tool-call reasoning continuation rules.

## Decision

The public product protocol remains:

```text
WorkspaceSession -> WorkCycle -> ActivityUnit -> AgentSignal
```

Model context is now a private Runtime subsystem with three boundaries:

1. `ContextRecord` is the durable, provider-neutral model ledger stored in SQLite.
2. `ProviderMessage` is the normalized request representation used by adapters.
3. DeepSeek `messages`, `reasoning_content`, and `tool_calls` exist only inside `DeepSeekProvider`.

Context records distinguish human text, agent text, tool results, Runtime facts, and compaction checkpoints. Assistant tool calls and their results remain paired. Tool-call reasoning is retained only when DeepSeek requires it; ordinary reasoning is not persisted.

## Prompt layers

`PromptBlueprintRegistry` owns versioned and hashed templates for identity, coding behavior, tool policy, plan policy, final responses, protocol repair, and compaction. Stable system content does not contain the project root or live state.

`InstructionResolver` loads DeepSeeker-owned instruction files:

- `~/.deepseeker/INSTRUCTIONS.md` for user preferences.
- `DEEPSEEKER.md` and `.deepseeker/INSTRUCTIONS.md` for shared project rules.
- `DEEPSEEKER.local.md` for local project rules.
- `.deepseeker/rules/**/*.md` for optional path-scoped rules.
- Nested `DEEPSEEKER.md` files after a file under that directory is accessed.

Every resolved instruction records scope, source path, priority, loading reason, applicable paths, and content hash. Broad rules are rendered before more specific rules.

## Request layout and caching

Provider requests use this order:

```text
tools field
stable system blueprint
stable project instruction snapshot
compaction checkpoint
recent structured trajectory
late Runtime facts
latest user message
```

Tool schemas are never copied into messages. Live project root, recovery facts, and permission-sensitive state stay at the tail so their changes do not invalidate the historical cache prefix. Tool selection uses a deterministic interaction-mode router. Direct conversation has no tools; agent and recovery modes use one stable core catalog.

## Evidence and compaction

Raw, redacted tool output is written to Runtime-owned artifacts. The model receives a bounded head/tail excerpt with command status, byte counts, digest, and an explicit truncation marker. Public ActivityUnit presentation continues to use the existing semantic projection.

The effective input budget is:

```text
model context window - reserved output - safety margin
```

Automatic compaction defaults to 85 percent of that budget and prefers provider-reported usage over estimates. The effective window is clamped to the active Provider capability so a model switch cannot inherit an unsafe threshold from an older session. A checkpoint retains the objective, constraints, decisions, authoritative current plan, inspected and changed files, validation evidence, failures, pending work, and next actions. Recent complete trajectories and unclosed tool calls remain verbatim; an exceptionally long current WorkCycle can compact its older closed trajectories. Project instructions are resolved again after compaction.

## Persistence and migration

`context_records` and `context_telemetry` are private SQLite tables and do not add AgentSignal topics. Existing JSONL logs remain authoritative for the UI. When an old terminal cycle has no ContextRecord entries, SignalStore projects its prompt and final result into legacy records before the next model request. New cycles are written natively and are not duplicated by migration.

Context telemetry stores blueprint versions, section token estimates, prefix hashes, retained record keys, dropped-record reasons, bounded-output truncation facts, compact before/after estimates, and provider cache usage. It never stores message bodies, secrets, or full reasoning. In development, `DEEPSEEK_CONTEXT_DEBUG=1` writes a request-layout snapshot containing roles, sources, hashes, record keys, and token costs, but not message bodies or secrets.

## Consequences

- Multi-turn agent behavior can recover from actual execution evidence instead of final prose alone.
- DeepSeek V4 tool reasoning is replayed correctly without turning ordinary chain-of-thought into long-term memory.
- Prompt and instruction changes are observable and regression-testable.
- Large tool outputs and old sessions have bounded, explicit migration paths.
- The frontend and persisted AgentSignal contract remain backward compatible.
