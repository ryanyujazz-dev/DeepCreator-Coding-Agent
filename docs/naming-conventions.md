# DeepSeeker Naming Conventions

## Status

Accepted

This document defines the vocabulary and naming rules for DeepSeeker. It is the authority for active source, public contracts, persistence schemas, tests, and documentation. Earlier names are valid only inside V1 compatibility code, migrations, and explicit historical discussion.

## Goals

- Keep the core language short, stable, and easy to discuss.
- Use module boundaries to express architecture instead of repeating them in every symbol.
- Distinguish genuinely different data shapes without inventing false abstractions.
- Keep model-provider, persistence, transport, and presentation terminology out of the domain core.
- Make names predictable across TypeScript, JSON, SQLite, HTTP, tests, and documentation.

## Rules

Normative words such as **MUST**, **SHOULD**, and **MUST NOT** are intentional.

1. A core domain concept MUST use one noun whenever one noun is sufficient.
2. A name MUST describe what a value is, not where it happened to be created.
3. Directory and module boundaries SHOULD carry architectural context. Symbols MUST NOT repeat `Agent`, `Runtime`, `Workspace`, or `DeepSeeker` without a real ambiguity.
4. Two declarations with different responsibilities MUST NOT be mechanically renamed to the same symbol.
5. A suffix MUST describe a real data shape or role. Generic suffixes such as `View`, `Data`, `Info`, `Object`, `Manager`, and `Helper` MUST NOT be used as substitutes for design.
6. Identifiers MUST use `Id`. New code MUST NOT introduce `Key` for entity identity.
7. Lifecycle state MUST use `status`. New code MUST NOT mix `phase`, `state`, and `status` for the same kind of lifecycle.
8. Provider-native names MUST stop at the provider boundary.
9. UI wording and aggregation MUST NOT become persisted domain vocabulary.
10. Abbreviations SHOULD be avoided unless they are established protocol or platform terms such as `API`, `HTTP`, `SSE`, `SQL`, `MCP`, or `UI`.

## Core Language

DeepSeeker uses four primary nouns:

```text
Session
└── Run
    └── Activity

Event records changes to those objects.
```

### Session

A durable conversation associated with a project root. A Session contains user requests, Runs, context history, access settings, and recoverable state.

### Run

All work caused by one user request. A Session MAY have many Runs but MUST have at most one active Run in the current local Runtime.

### Activity

One visible or auditable occurrence inside a Run, such as an assistant message, tool call, file change, command, approval, or final answer.

### Event

An immutable, ordered fact that changes or explains Session, Run, or Activity state. Event is provider-neutral and presentation-neutral.

## Canonical Types

The canonical state types use the core nouns without a `View` suffix:

```ts
type Session = { /* complete reduced session state */ };
type Run = { /* complete reduced run state */ };
type Activity = { /* complete reduced activity state */ };
type Event = { /* immutable event envelope */ };
```

This is valid because the current system does not contain separate `WorkspaceSession` and `WorkspaceSessionView` domain declarations. Its write facts are Events, while Session, Run, and Activity are the reduced current state.

If two distinct declarations exist, they MUST keep distinct semantic names. The migration MUST inspect declarations before renaming and MUST NOT merge types merely because a mapping table mentions the same concept.

## Shape Suffixes

Use a suffix only when a second, meaningfully different representation exists.

| Suffix | Meaning | Example |
| --- | --- | --- |
| `Summary` | Small list or search result | `SessionSummary` |
| `Meta` | Identity and descriptive metadata only | `SessionMeta` |
| `Input` | Validated input for creating or starting something | `RunInput` |
| `Row` | Persistence-specific database representation | `EventRow` |
| `Snapshot` | State captured at a specific offset or time | `SessionSnapshot` |
| `Schema` | Runtime validation or wire schema | `EventSchema` |
| `Config` | Parsed configuration values | `ModelConfig` |
| `Stats` | Aggregated measurements | `ContextStats` |
| `Pane` | A substantial UI region | `SurfacePane` |
| `Dialog` | Modal interaction | `ApprovalDialog` |
| `Registry` | Lookup of replaceable implementations by identity | `SurfaceRegistry` |
| `Store` | Durable access boundary | `EventStore` |

Do not use a suffix when the base noun is already unambiguous:

```text
SessionView  -> Session
RunData      -> Run
ActivityInfo -> Activity
EventObject  -> Event
```

React components MAY use a visual-role suffix when they would otherwise collide with a domain type:

```text
SessionPane
RunTimeline
ActivityList
ApprovalDialog
```

## Identity And Lifecycle

Identifiers use `Id` consistently:

```text
sessionId
runId
activityId
eventId
callId
approvalId
recordId
```

`Key` is reserved for map keys, cache keys, cryptographic keys, configuration keys, or external protocols that explicitly call a value a key.

Lifecycle fields use `status`:

```ts
type RunStatus = "queued" | "running" | "waiting" | "completed" | "failed" | "cancelled";
type ActivityStatus = "running" | "completed" | "failed" | "cancelled";
```

Use `state` only for interactive sub-state that is not the object's lifecycle, such as an approval choice or editor selection.

## Event Language

The V2 envelope uses concise, stable fields:

```ts
type Event<T = unknown> = {
  version: "deepseeker.events/v2";
  eventId: string;
  offset: number;
  type: EventType;
  scope: {
    sessionId: string;
    runId?: string;
    activityId?: string;
  };
  at: string;
  data: T;
};
```

Event types use `<noun>.<past-tense-change>`:

```text
session.created
run.started
tasks.changed
changes.changed
activity.started
activity.updated
activity.finished
approval.requested
approval.resolved
run.finished
```

Event names MUST describe facts. Commands such as `startRun` and `cancelRun` use imperative verbs, but persisted Events use past-tense facts.

The following MUST NOT appear in Event payloads:

- DeepSeek fields such as `reasoning_content`, `content`, or raw `tool_calls`;
- rendered Chinese or English UI labels;
- expanded/collapsed UI state;
- activity-card aggregation results;
- unredacted command output or secrets.

## State Names

Use these domain names:

| Existing name | V2 name |
| --- | --- |
| `WorkspaceSessionView` | `Session` |
| `CycleView` | `Run` |
| `ActivityUnitView` | `Activity` |
| `AgentSignal` | `Event` |
| `SessionListEntry` | `SessionSummary` |
| `SessionRegistration` | `SessionInput` |
| `CyclePhase` | `RunStatus` |
| `UnitPhase` | `ActivityStatus` |
| `SignalTopic` | `EventType` |
| `SignalScope` | `EventScope` |
| `WorkspaceDeltaView` | `Changes` |
| `FileDeltaView` | `FileChange` |
| `PlanStepView` | `Task` |
| `RecoveryCapsule` | `ResumeState` |
| `UsageView` | `Usage` |

Planning and execution progress use four separate nouns:

| Name | Meaning | Must not mean |
| --- | --- | --- |
| `Mode` | Current `work` or `plan` policy state | Run status or access level |
| `Plan` | Versioned Markdown proposal reviewed by the user | Execution progress checklist |
| `Task` | Model-maintained implementation progress item | User-approved proposal |
| `Question` | Durable interaction that suspends and later resumes a Run | Approval or ordinary chat message |

Use `PlanPolicy` for the hard planning boundary and `AccessPolicy` for work-mode authorization. A Plan can be proposed, revised, approved, rejected, or superseded; a Task can be pending, running, completed, or blocked. Do not share their status types or UI components.

Use these field names:

| Existing field | V2 field |
| --- | --- |
| `sessionKey` | `sessionId` |
| `cycleKey` | `runId` |
| `unitKey` | `activityId` |
| `signalKey` | `eventId` |
| `callKey` | `callId` |
| `approvalKey` | `approvalId` |
| `recordKey` | `recordId` |
| `cycles` / `cycleKeys` | `runs` / `runIds` |
| `units` | `activities` |
| `phase` | `status` |
| `topic` | `type` |
| `payload` | `data` |
| `emittedAt` | `at` |
| `finalResponse` | `answer` |
| `failure` | `error` |
| `workspaceDelta` | `changes` |
| `contextTokenEstimate` | `contextTokens` |
| `permissionProfile` | `accessMode` |
| `permissionGrants` | `grants` |
| `operationClass` | `action` |
| `resourceKind` | `targetKind` |
| `effectKind` | `effect` |
| `aggregationPolicy` | `groupMode` |
| `detailPolicy` | `detail` |

## Runtime Names

Runtime roles use short nouns whose module establishes their context:

| Existing name | V2 name |
| --- | --- |
| `AgentRuntime` / `AgentRunCoordinator` | `Runner` |
| `settleWorkCycle` | `finishRun` |
| `cycleLifecycle` | `runLifecycle` |
| `LiveRegistry` | `RunRegistry` |
| `ProviderAdapter` | `Provider` |
| `ProviderMessage` | `ModelMessage` |
| `ProviderRequest` | `ModelRequest` |
| `ProviderResponse` | `ModelResponse` |
| `ProviderFragment` | `ModelDelta` |
| `ProviderCapabilities` | `ModelCaps` |
| `ProviderToolCall` | `ToolCall` |
| `ProviderUsage` | `Usage` |
| `ToolDefinition` | `ToolSpec` |

`Manager`, `Coordinator`, and `Service` MUST NOT be default suffixes. Use a precise role such as `Runner`, `Builder`, `Resolver`, `Projector`, `Store`, or `Registry`.

## Context Names

| Existing concept | V2 name |
| --- | --- |
| Prompt kernel | `CorePrompt` |
| Guidance graph | `Rules` |
| Capability index | `Capabilities` |
| Conversation ledger | `History` |
| Evidence vault | `Evidence` |
| Checkpoint engine | `Compactor` |
| Request assembler | `ContextBuilder` |
| Context record | `ContextEntry` |
| Context checkpoint | `Checkpoint` |
| Context telemetry / observer | `ContextStats` |
| Prompt blueprint registry | `Prompts` |

The context flow should read naturally:

```text
CorePrompt + Rules + History + Evidence
                    |
              ContextBuilder
                    |
                Provider
```

## Tool And Access Names

| Existing name | V2 name |
| --- | --- |
| `ToolExecutionPipeline` | `ToolPipeline` |
| `ToolExecutionView` | `ToolState` |
| `ToolOperationClass` | `ActionKind` |
| `ToolResourceKind` | `TargetKind` |
| `ToolEffectKind` | `Effect` |
| `ToolAggregationPolicy` | `GroupMode` |
| `ToolDetailPolicy` | `DetailMode` |
| `OperationGroupView` | `ActivityGroup` |
| `OperationGroupProjector` | `GroupProjector` |
| `OperationDetailPanel` | `DetailPanel` |
| `PermissionProfileKey` | `AccessMode` |
| `PermissionPolicy` | `AccessPolicy` |
| `PermissionCapability` | `AccessScope` |
| `PermissionGrantView` | `Grant` |
| `ApprovalView` | `Approval` |
| `ApprovalDecision` | `ApprovalChoice` |

Tool names exposed to the model SHOULD remain stable API identifiers such as `read_file` or `run_command`. Internal TypeScript types and UI labels do not need to copy those identifiers.

## UI Names

| Existing name | V2 name |
| --- | --- |
| `WorkspaceSurface` | `Surface` |
| `WorkspaceSurfacePanel` | `SurfacePane` |
| `WorkspaceInspector` | `Inspector` |
| `ConversationViewport` | `Conversation` |
| `WorkCycleTimeline` | `RunTimeline` |
| `ActivityRenderer` | `ActivityView` |
| `useRuntimeWorkspace` | `useWorkspace` |
| `runtimeClient` | `runtimeApi` |

Use `SurfaceRegistry` for available file, review, browser, terminal, Markdown, and artifact surfaces. Use `ActivityRegistry` only if activity presentation becomes replaceable by registered activity kind. Do not introduce a registry for a closed switch with only a few stable cases.

## Persistence Names

Durable boundaries use `Store`:

```text
EventStore
SessionStore
ContextStore
MemoryStore
MetricStore
EvidenceStore
```

Persistence-specific shapes use `Row` and snake_case columns:

```text
EventRow.event_id
EventRow.session_id
EventRow.run_id
EventRow.activity_id
```

Database terminology MUST NOT leak into domain or UI types.

## File And Module Names

- TypeScript source files use lower camel case: `runLifecycle.ts`, `contextBuilder.ts`.
- React component files use PascalCase: `RunTimeline.tsx`, `SurfacePane.tsx`.
- Tests mirror the subject: `eventStore.test.ts`, `contextBuilder.test.ts`.
- SQL migrations use an ordered prefix and concise action: `002_event_protocol_v2.sql`.
- ADR files use an ordered prefix and kebab case: `004-clean-runtime-architecture.md`.
- Barrel files MUST NOT hide circular dependencies. Prefer direct imports inside Runtime modules.

## API Names

HTTP resources use plural nouns and `Id` parameters:

```text
GET  /api/sessions
GET  /api/sessions/:sessionId
POST /api/sessions/:sessionId/runs
GET  /api/runs/:runId
POST /api/runs/:runId/cancel
GET  /api/sessions/:sessionId/events?afterOffset=<offset>
POST /api/approvals/:approvalId/resolve
```

Functions use verbs and domain nouns:

```text
createSession
startRun
cancelRun
finishRun
appendEvent
readEvents
resolveApproval
buildContext
```

Boolean names use `is`, `has`, `can`, or `should`. Event handlers use `on` in component props and `handle` only for local UI functions.

## Migration Rules

1. Inventory actual declarations before applying this mapping.
2. Rename one concept vertically across shared contracts, Runtime, transport, frontend, tests, and documentation.
3. Update persisted and wire schemas deliberately; do not rely on TypeScript renaming alone.
4. Decode `deepseeker.flow/v1` through an isolated legacy decoder.
5. Write only `deepseeker.events/v2` after migration. Do not maintain indefinite dual writes.
6. Old terminology MAY appear only in legacy decoding, migrations, historical ADR context, and explicit migration tests.
7. Run tests and build after each vertical concept migration.

## Review Checklist

Before accepting a new name, ask:

- Is there a shorter noun that keeps the meaning?
- Is the prefix already supplied by the module or directory?
- Does a suffix describe a real alternate shape?
- Could a new contributor infer the difference between this name and its base noun?
- Is this domain language, provider language, storage language, transport language, or UI language?
- Will this name remain correct if DeepSeek is replaced or another client is added?
- Does the name create a new concept when the implementation has only one?

If the answer is unclear, improve the boundary before lengthening the name.
