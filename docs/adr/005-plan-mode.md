# ADR 005: Plan Mode Product and Runtime Design

## Status

Accepted and implemented (2026-07-18)

## Executive summary

DeepSeeker needs a Plan Mode, but not merely a prompt that asks the model to "think first". A useful Plan Mode is a product contract enforced by the Runtime:

1. the user or model can deliberately enter a planning state;
2. the agent may inspect the project and ask questions, but cannot mutate the workspace;
3. the result is a durable, editable, reviewable implementation proposal;
4. only an explicit user decision can authorize the transition from planning to implementation;
5. the approved plan becomes implementation context without being confused with the execution task list.

The recommended design borrows the strongest ideas from Codex, Claude Code, Gemini CLI, and Cursor while fitting DeepSeeker's existing `Session -> Run -> Activity -> Event` architecture and DeepSeek's prefix-cache behavior.

The key product decision is:

> Plan Mode is a governed workflow, not a writing style and not a renamed task list.

DeepSeeker should therefore separate three concepts:

- `Mode`: whether the agent is planning or implementing;
- `Plan`: the versioned proposal reviewed by the user;
- `Task`: the model-maintained progress items used during execution.

This separation is the foundation for predictable behavior, honest UI, safe tool use, reliable recovery, and future provider portability.

## Why this matters now

DeepSeeker already supports multi-turn Sessions, streamed Runs, structured tool calls, approvals, context compaction, file review, and multi-surface UI. The next product risk is no longer whether the model can edit a file. It is whether users can trust the agent with larger, ambiguous, and expensive changes.

Without a real Plan Mode, a coding agent tends to fail in four ways:

- it begins changing files before the user agrees with the approach;
- it mistakes a plausible first idea for a decided implementation;
- it hides important tradeoffs inside transient narration;
- it produces a checklist that looks authoritative but is neither reviewable nor enforced.

These are not cosmetic problems. They increase rework, make approvals less meaningful, and reduce user confidence precisely when the task becomes important.

Plan Mode should create a deliberate boundary between understanding and changing. That boundary gives the user a natural moment to correct scope, architecture, migration strategy, risk tolerance, or acceptance criteria before side effects begin.

## Research findings

### OpenAI Codex

Codex treats planning as a collaboration mode rather than as ordinary assistant prose. Its public Plan Mode instructions emphasize repository exploration before finalizing the proposal, clarification of material decisions, non-mutating behavior, and a decision-complete final plan. Codex also distinguishes planning from the separate progress-plan tool used while work is being executed.

The useful lesson is that a plan must be implementable by another engineer without rediscovering major decisions. A list such as "inspect code, modify files, run tests" is not a plan; it is generic process narration.

What DeepSeeker should adopt:

- explicit mode semantics;
- research before proposal;
- clarification only where answers materially affect the design;
- a structured, reviewable plan artifact;
- strict separation between planning and execution progress.

What DeepSeeker should not copy literally:

- provider-specific message conventions;
- product wording or field names;
- treating a final text block as sufficient durable state.

### Anthropic Claude Code

Claude Code exposes Plan as a permission mode. While active, the agent can inspect and reason but cannot perform ordinary mutations. The agent can enter or request exit from planning through explicit tools. The user reviews the plan and chooses whether to continue planning or proceed with an execution permission mode.

Claude's strongest contribution is the coupling of planning to authorization. The safety boundary is not left to a sentence in the system prompt. Planning changes what operations are permitted.

What DeepSeeker should adopt:

- Runtime-enforced read-only planning;
- explicit enter and submit transitions;
- user-controlled approval before implementation;
- an editable plan surface rather than a transient chat-only answer;
- continuation of the same work after approval.

What DeepSeeker should improve:

- keep Plan Mode independent from the general access profile;
- model the transition as durable Events so restart and replay are deterministic;
- preserve a provider-neutral protocol rather than exposing provider tool names to the UI.

### Google Gemini CLI

Gemini CLI also implements planning as an operational policy. Its Plan Mode supports read-only research, user questions, a temporary Markdown plan artifact, explicit approval, and a transition to implementation. The policy engine, not model compliance alone, prevents disallowed tools. Gemini also demonstrates that planning and execution may use different model routing without changing the user-facing workflow.

What DeepSeeker should adopt:

- a policy layer above ordinary access permissions;
- a first-class question interaction during planning;
- a durable Markdown-compatible plan artifact;
- provider and model routing as an implementation detail;
- extensible hooks around plan submission and approval.

What DeepSeeker should defer:

- automatic use of separate planning and execution models until quality and cache measurements justify it;
- a plugin-facing planning API before the core lifecycle is stable.

### Cursor

Cursor presents Plan Mode as a low-friction product workflow: research the codebase, ask clarifying questions, produce an editable Markdown plan, then build from it. Cursor also suggests planning when a request appears complex.

Cursor's strongest contribution is discoverability. Users do not need to understand internal permission architecture to benefit. Plan Mode appears as a product choice at the moment of composition, and the plan becomes a visible working object.

What DeepSeeker should adopt:

- entry from the composer's `+` menu;
- a persistent visible mode indicator after selection;
- an editable plan in the right-side `Surface` system;
- a suggested-planning path for complex requests;
- a direct "start implementation" action.

What DeepSeeker should avoid:

- opaque automatic switching that leaves the user unsure whether changes can occur;
- using heuristics alone as the authority for mode changes.

## Competitive synthesis

The products differ in presentation, but their strongest implementations converge on five principles:

1. **Planning is explicit.** The system knows whether it is planning or implementing.
2. **Planning is constrained.** Read-only behavior is enforced outside the model.
3. **The plan is an artifact.** It can be reviewed, edited, versioned, and resumed.
4. **Implementation requires a transition.** A user decision separates proposal from side effects.
5. **Complexity can trigger a suggestion.** The model may recommend planning, but should not silently seize control of the workflow.

This convergence is more important than any one competitor's exact UI or tool schema. DeepSeeker should implement these principles using its own concise domain language and event-driven Runtime.

## Product position

### The user promise

When Plan Mode is active, DeepSeeker promises:

- it will understand before changing;
- it will show the decisions that matter;
- it will identify unresolved questions and risks;
- it will not modify the workspace before approval;
- it will carry the approved proposal into implementation;
- it will remain recoverable across refresh, reconnect, and restart.

This promise must remain true even if the model hallucinates, emits an invalid tool call, or is instructed by repository content to bypass planning.

### Target use cases

Plan Mode is valuable for:

- changes spanning multiple modules or architectural boundaries;
- data migrations and compatibility work;
- security, authorization, payment, or privacy-sensitive changes;
- work with meaningful product or technical tradeoffs;
- ambiguous requests where implementation would encode an unstated decision;
- destructive or expensive operations;
- unfamiliar repositories where the correct change surface is not yet known.

Plan Mode is usually unnecessary for:

- greetings and ordinary questions;
- explanation of existing code;
- a narrow, clearly specified edit;
- a small bug with an obvious reproduction and local fix;
- formatting, copy, or low-risk mechanical work.

The product should help users choose planning without turning every task into ceremony.

## Domain model

### Keep planning separate from execution tasks

The current `PlanItem[]` and `plan.changed` contract represents an execution checklist maintained through `update_plan`. That behavior is useful, but its name conflicts with Plan Mode.

The implementation should migrate the execution checklist to:

```ts
type TaskStatus = "pending" | "running" | "completed" | "blocked";

type Task = {
  taskId: string;
  label: string;
  status: TaskStatus;
};
```

The corresponding tool and Event should become:

```text
update_tasks
tasks.changed
```

A Plan is a different object:

```ts
type Mode = "work" | "plan";

type PlanStatus = "draft" | "proposed" | "approved" | "rejected" | "superseded";

type Plan = {
  planId: string;
  sessionId: string;
  runId: string;
  revision: number;
  status: PlanStatus;
  title: string;
  markdown: string;
  createdAt: string;
  updatedAt: string;
  approvedAt?: string;
};
```

The names remain consistent with `docs/naming-conventions.md`: core nouns are short, suffixes express real distinctions, lifecycle uses `status`, and identifiers use `Id`.

### Why `Mode`, `Plan`, and `Task` must remain distinct

- `Mode` answers: what is the agent allowed and expected to do now?
- `Plan` answers: what implementation has been proposed and approved?
- `Task` answers: what execution work is currently pending or complete?

Combining them creates ambiguous behavior. For example, completing a Task must not approve a Plan, and approving a Plan must not claim that implementation Tasks are complete.

### Session and Run ownership

The active `Mode` should be durable at the Session level because planning is naturally multi-turn. A user may answer questions, request revisions, close the app, and return later without leaving planning.

Each Run records the mode in which it started and any transition it caused. This gives auditability without duplicating authority:

- Session owns the current mode;
- Run records its mode snapshot and outcome;
- Events record every committed transition;
- Plan owns proposal revisions and review state.

## Lifecycle and state machine

The recommended lifecycle is:

```text
work
  -> plan/researching
  -> plan/waiting_for_user
  -> plan/researching
  -> plan/proposed
  -> plan/revising
  -> plan/proposed
  -> work/implementing
```

The public `Mode` remains only `work | plan`. More detailed states belong to the current Run and Plan status rather than multiplying top-level modes.

### Entry paths

Plan Mode may begin through three routes:

1. **Explicit UI selection.** The user chooses Plan Mode from the composer's `+` menu.
2. **Explicit natural language.** The user asks to plan, investigate first, or avoid changes.
3. **Model suggestion.** During an eligible Run, the model calls `enter_plan` with a concise reason.

The Runtime validates every route and commits `mode.changed` before the next provider request is constructed.

### Submission is not exit

The model should call:

```ts
submit_plan({ title, markdown })
```

It should not call `exit_plan`.

Submitting a proposal means "this revision is ready for review". It does not mean the user has approved it, and it does not grant write access. Conflating submission and exit allows the model to authorize itself.

After submission:

- the Run becomes `waiting`;
- the Plan Surface opens or receives attention;
- the user can edit or comment on the proposal;
- the user chooses `继续规划`, `开始实施`, or `取消`;
- only `开始实施` commits approval and returns the Session to `work`.

### Continue the same Run

Approval should resume the same Run rather than manufacture a disconnected user message. The Runtime returns a structured result to the pending `submit_plan` call containing the approved revision and selected access mode. The Agent Loop then continues with the approved Plan in context.

This preserves causality:

```text
model submits plan
-> user reviews
-> Runtime records decision
-> tool result returns decision
-> model implements approved revision
```

The same mechanism supports "continue planning" by returning review comments while keeping the mode as `plan`.

## Runtime enforcement

### Policy order

The Tool Pipeline should enforce policies in this order:

```text
normalize
-> validate schema
-> PlanPolicy
-> AccessPolicy
-> checkpoint
-> execute
-> record
```

`PlanPolicy` must run before `AccessPolicy` because Plan Mode is a stronger semantic boundary than the user's general access profile.

The rule is:

```text
PlanPolicy > AccessPolicy > temporary grants
```

Selecting `full_access` must never permit a write while Plan Mode is active. Full access answers whether a work-mode operation needs approval; it does not redefine planning.

### Tool policy matrix

| Operation | Plan Mode | Work Mode |
| --- | --- | --- |
| Read file or directory | Allow | Allow |
| Search project | Allow | Allow |
| Inspect Git status or diff | Allow | Allow |
| Ask user | Allow | Allow when needed |
| Submit or revise Plan | Allow | Reject unless entering Plan Mode |
| Update execution Tasks | Usually reject | Allow |
| Modify, create, rename, or delete file | Reject | AccessPolicy decides |
| Run verified read-only command | Allow | AccessPolicy decides |
| Run build, install, server, migration, or arbitrary shell | Reject by default | AccessPolicy decides |
| Network or external side effect | Reject by default | AccessPolicy decides |

Shell commands require particular care. Command strings are not inherently read-only. Plan Mode should use a conservative `planSafe` classifier plus explicit tool metadata. Unknown, chained, redirected, background, package-manager, build, test, server, Docker, and network commands should be denied until classified safely.

### No mutation before planning

Automatic entry into Plan Mode is valid only before the Run has produced a workspace or external mutation. If a model attempts `enter_plan` after mutation, the Runtime should reject the transition and instruct it either to continue in work mode or ask the user how to proceed.

This prevents a misleading timeline where planning appears to have protected a workspace that was already changed.

### Model-step exclusivity

`enter_plan` and `submit_plan` are control tools. A model step containing either control transition should not execute sibling mutating tools. The Provider may stream several tool calls in one response, so the Runtime must normalize the entire step before executing any call.

## Model autonomy

### Recommended policy levels

DeepSeeker should support three product policies:

```ts
type PlanEntry = "manual" | "suggest" | "auto";
```

- `manual`: only explicit user selection or instruction can enter planning;
- `suggest`: the model can recommend and request entry through `enter_plan`;
- `auto`: eligible requests may enter planning without an extra confirmation, while remaining visibly read-only.

The default should be `suggest`.

`manual` provides control but makes the feature easy to miss. `auto` is convenient but can feel obstructive and may incorrectly classify small tasks. `suggest` balances discoverability with user agency and is the best default while DeepSeek behavior is still being measured.

### How the model decides

The model should not infer mode from hidden reasoning, and the Runtime should not parse `reasoning_content` or ordinary `content` for phrases such as "I should plan".

Instead, the stable system prompt should define a small set of criteria and expose `enter_plan({ reason })`. The model uses that structured control tool when one or more criteria materially apply:

- cross-module or architectural scope;
- unresolved product or technical choices;
- migrations, compatibility, or rollback requirements;
- security-sensitive or hard-to-reverse work;
- unfamiliar project structure with uncertain change surface;
- a request that explicitly asks for options, design, or investigation first.

The `reason` is user-facing justification, not hidden chain of thought. The Runtime records the transition as a fact.

### Why the Runtime should not decide from heuristics alone

The Runtime can detect shallow signals such as request length, file count, keywords, or estimated risk, but it cannot reliably understand the semantic scope before repository exploration. Using those heuristics to silently change modes would create false positives and inconsistent behavior.

Runtime heuristics are appropriate for:

- deciding whether the model may offer `enter_plan`;
- displaying a non-blocking suggestion in the composer;
- collecting telemetry for future tuning;
- preventing entry after side effects.

They are not sufficient as the sole source of intent.

## Provider and context design

### Stable prompt, stable tools

DeepSeek benefits from prefix caching. Plan Mode should not rebuild the leading prompt or remove tools from the request every time the mode changes.

The request should preserve:

- one stable system prompt that explains both modes;
- a stable core tool catalog and schemas;
- stable Session context and project guidance;
- append-only History with paired tool calls and results.

The Runtime still exposes the same tool schemas in both modes. A tool being present in the API request means the model understands the capability; it does not mean the Runtime will authorize it. `PlanPolicy` remains the source of truth.

Duplicating tool schemas inside messages is unnecessary and harmful. Schemas belong in the API's `tools` field only.

### Dynamic mode placement

Current mode is dynamic state and should not be inserted ahead of historical messages. Doing so would invalidate an otherwise reusable cached prefix whenever the mode changes.

For a new user turn, the Runtime should append a compact tagged context envelope immediately before the latest real user message:

```text
system: stable platform prompt
user: stable session context
...existing history...
user: <mode_context mode="plan" plan_revision="2" />
user: latest real user message
```

The envelope should use the existing Runtime-context `user` convention from ADR 003 rather than creating a second system message. The leading system prompt remains stable and authoritative; the tagged user envelope supplies current Runtime facts without pretending to be a new human command.

During a suspended tool continuation, the mode change or review decision should arrive through the paired tool result instead of an additional injected message.

### What enters context

In Plan Mode, context should include:

- current mode and Plan revision;
- the user's objective and constraints;
- stable project guidance;
- relevant conversation history;
- bounded evidence from project inspection;
- review comments and unresolved questions;
- the latest Plan revision when revising or implementing.

It should not include:

- raw chain of thought;
- rendered UI labels;
- duplicated tool schemas;
- every intermediate plan draft;
- approval UI state that is not an authoritative decision;
- a constantly repeated execution task list on normal turns.

### Compaction requirements

Compaction must preserve:

- current `Mode`;
- active Plan identity, revision, status, and full approved proposal;
- material review comments and unresolved decisions;
- evidence supporting major Plan decisions;
- pending `submit_plan` interaction;
- implementation Tasks only after execution begins.

Superseded drafts may be reduced to revision metadata once the latest Plan contains all accepted decisions. Durable full revisions remain in storage and can be inspected without consuming model context.

## Event protocol

The V2 Event union should add provider-neutral facts:

```text
mode.changed
plan.proposed
plan.revised
plan.approved
plan.rejected
tasks.changed
```

Suggested semantics:

- `mode.changed`: previous mode, next mode, initiator, reason;
- `plan.proposed`: Plan identity, revision, title, content reference;
- `plan.revised`: previous revision, next revision, editor or model initiator;
- `plan.approved`: approved revision, user decision, selected access mode;
- `plan.rejected`: rejected revision and optional review comment;
- `tasks.changed`: complete replacement projection of execution Tasks.

Plan content may be stored in a Plan table with the Event carrying its identity and revision. This avoids placing large Markdown bodies in every event replay while keeping the transition auditable and transactional.

Rendered labels, modal state, expanded sections, and competitor-specific fields must not enter Event payloads.

## User experience

### Composer entry

The composer's `+` menu should include `计划模式`. Selecting it changes the Session mode before submission. Once active, a compact persistent indicator should appear in the composer so users never have to reopen the menu to discover whether writes are possible.

The indicator should communicate state, not explain the feature. Detailed explanation belongs in a tooltip or the Plan Surface.

### Planning timeline

The timeline should show only useful planning progress:

- concise assistant updates;
- aggregated read and search operations;
- questions requiring user input;
- Plan submitted or revised;
- failures that block planning.

It should not display reasoning content, repetitive "thinking complete" entries, approval controls inside tool aggregation, or one line for every file read.

### Plan Surface

Plan review belongs in the existing right-side `Surface` architecture, not in a special-purpose modal welded to the conversation.

The `plan` Surface should support:

- persistent tabs alongside files, review, browser, and future surfaces;
- rendered Markdown and an editable source mode;
- Plan title, revision, and status;
- unresolved questions and review comments;
- `继续规划`, `开始实施`, and `取消` actions;
- diff or revision comparison later, without blocking the first version.

Opening the Plan should push and resize the conversation layout in the same way as other Surfaces. It should not float over the timeline.

### Approval and access

Plan approval is a product decision, not a tool permission prompt. It should not be aggregated into the execution timeline.

When the user chooses `开始实施`, the UI may ask for or reuse an `AccessMode`. This decision is separate:

- Plan approval authorizes the proposed direction;
- AccessMode governs how individual side effects are approved during implementation.

Approving a Plan must never silently grant unrestricted filesystem, shell, network, or external access.

## Recovery and failure behavior

The feature is incomplete unless every transition survives interruption.

Required behavior:

- a refresh restores active mode and latest Plan revision;
- reconnect resumes Events after the last offset;
- a submitted Plan remains waiting after Runtime restart;
- duplicate approval commands are idempotent;
- only the latest non-superseded revision may be approved;
- a rejected or revised Plan cannot later be implemented by a stale callback;
- an interrupted planning Run may resume without re-reading its entire history;
- a provider failure does not change the Session back to work mode;
- a policy-denied write is recorded as a visible, bounded failure rather than executed.

SQLite must commit the Plan transition, Session mode projection, Run status, and affected Event in one transaction.

## Observability and product metrics

Plan Mode should be evaluated by whether it improves outcomes, not by how often it appears.

Useful metrics include:

- explicit, suggested, and automatic entry rates;
- suggestion acceptance and dismissal rates;
- time spent researching versus waiting for user review;
- number of Plan revisions before approval;
- percentage of approved Plans that later require major scope changes;
- policy-denied mutation attempts during planning;
- implementation completion and failure rates after approval;
- provider cache hit and miss tokens across mode transitions;
- user cancellation and return-to-planning rates;
- compacted versus retained Plan context cost.

Metrics must not store chain of thought, secrets, raw repository content, or full user prompts by default.

## Delivery plan

### Stage 1: Correct the language

- Rename execution `PlanItem` to `Task`.
- Rename `plan.changed` to `tasks.changed`.
- Rename `update_plan` to `update_tasks`.
- Add compatibility decoding for existing persisted Events and tool history.
- Update prompts, tests, projections, and UI labels without changing behavior.

This stage must land first. Building Plan Mode on top of ambiguous names would spread confusion through every new contract.

### Stage 2: Mode and policy foundation

- Add `Mode` to Session state and Run snapshots.
- Add mode transition Events and persistence migrations.
- Implement `PlanPolicy` before `AccessPolicy` in the Tool Pipeline.
- Add a tested read-only command classifier.
- Reject sibling mutations in control-tool model steps.
- Cover replay, restart, and idempotency.

### Stage 3: Manual Plan Mode

- Add Plan Mode to the composer `+` menu.
- Add the persistent composer mode indicator.
- Add `enter_plan`, `ask_user`, and `submit_plan` tools.
- Add Plan storage and revision Events.
- Implement waiting and resume behavior.

Manual entry provides the smallest end-to-end trustworthy slice.

### Stage 4: Review Surface

- Register the `plan` Surface.
- Render and edit Plan Markdown.
- Add continue, approve, and cancel actions.
- Select or confirm AccessMode when implementation begins.
- Ensure layout, tabs, resize, and close behavior reuse the common Surface framework.

### Stage 5: Suggested entry

- Add `PlanEntry = manual | suggest | auto` configuration.
- Default to `suggest`.
- Teach the model bounded entry criteria in the stable prompt.
- Add non-blocking UI suggestions and telemetry.
- Evaluate DeepSeek adherence, false positives, and cache behavior.

### Stage 6: Refinement

- Add Plan revision comparison and comments if usage justifies them.
- Evaluate separate planning and execution model routing.
- Tune command classification from denied-operation telemetry.
- Consider policy hooks for plugins only after the lifecycle is stable.

## Acceptance criteria

The first production-ready release must satisfy all of the following:

- A user can enter Plan Mode from the composer before sending a request.
- The active mode is always visible near the composer.
- Planning may span multiple Runs in one Session.
- Planning can read and search but cannot mutate files or external state.
- `full_access` cannot bypass PlanPolicy.
- The model can request entry only through `enter_plan`.
- Runtime never parses reasoning or ordinary content to infer a mode transition.
- Tool schemas remain stable across mode changes.
- Dynamic mode context is appended near the latest user message.
- The model submits a versioned Plan through `submit_plan`.
- Submission waits for a user decision and does not grant execution rights.
- The user can continue planning, approve implementation, or cancel.
- Approval resumes the same causal Agent Loop with the approved revision.
- Plan approval and AccessMode remain separate decisions.
- Execution Tasks are not represented as a Plan.
- Mode, Plan, Run status, and Events recover after refresh and Runtime restart.
- Duplicate and stale approvals are safely rejected or treated idempotently.
- The timeline aggregates research operations and never renders chain of thought.
- The Plan opens in the shared right-side Surface system.
- V1 persisted task-plan records remain readable through compatibility code.
- Unit, integration, reducer, policy, recovery, SSE replay, and frontend interaction tests pass.

## Risks and mitigations

### The model overuses planning

Mitigation: default to `suggest`, define narrow entry criteria, allow immediate dismissal, and measure false positives.

### The model underuses planning

Mitigation: keep explicit UI entry prominent, support direct natural-language intent, and use Runtime heuristics for suggestions rather than forced transitions.

### Read-only shell classification is bypassed

Mitigation: deny unknown command forms, validate full model steps before execution, avoid relying on keyword prefixes, and keep PlanPolicy above user grants.

### Approved plans become stale during implementation

Mitigation: treat the Plan as authoritative direction rather than immutable code, expose material deviations to the user, and allow re-entry into planning before further side effects.

### Context cost grows with revisions

Mitigation: keep only the latest active revision in normal context, store full revisions durably, compact superseded drafts, and preserve stable prompt/tool prefixes.

### Product UI becomes too ceremonial

Mitigation: keep entry optional, keep the composer indicator compact, aggregate research activity, and reserve Plan Mode for meaningful uncertainty or risk.

## Alternatives rejected

### Prompt-only Plan Mode

Rejected because the model can still call mutating tools, prompt injection can conflict with the instruction, and Runtime recovery cannot prove which policy was active.

### Reuse `update_plan` as the Plan artifact

Rejected because execution progress items and an architectural proposal have different lifecycle, ownership, review, persistence, and UI requirements.

### Let the model call `exit_plan`

Rejected because it allows the proposer to authorize implementation. The model may submit; the user approves.

### Remove mutating tool schemas in Plan Mode

Rejected as the primary mechanism because it destabilizes DeepSeek's cached request prefix and makes mode behavior depend on provider request construction. Runtime policy enforcement is still required. Stable schemas plus hard rejection provide a cleaner boundary.

### Put dynamic mode state near the beginning of History

Rejected because every mode or revision change would invalidate the cached conversation prefix. Append-only placement immediately before the latest user input preserves more reusable context.

### Force planning from Runtime complexity heuristics

Rejected as the default because surface-level heuristics cannot reliably understand repository semantics and would make the product feel unpredictable.

## Decision

DeepSeeker will implement Plan Mode as a first-class, Runtime-enforced workflow integrated with the existing event protocol, Tool Pipeline, context operating system, and Surface UI.

The default entry policy will be `suggest`. The user remains the authority for approving implementation. The model may research, ask, propose, and revise; the Runtime enforces allowed operations and records transitions; the user authorizes the move from proposal to work.

Implementation must begin by renaming the existing execution-plan vocabulary to Tasks. No Plan Mode code should be added until that semantic migration has a tested compatibility path.

## Implementation record

The first implementation now follows this ADR across the full product boundary:

- `shared/contracts/runtime.ts` defines `Mode`, `Plan`, `Task`, `Question`, revision status, review decisions, and their public Events.
- V1 execution-plan data is decoded as `Task` only inside `shared/legacy`; new code and persisted V2 Events use `tasks.changed`.
- `PlanPolicy` runs before access approval. It rejects writes, external effects, builds, tests, package operations, network calls, unsafe shell composition, and task updates while planning. `full_access` cannot bypass it.
- `enter_plan`, `ask_user`, and `submit_plan` remain stable provider tools in both modes. Mode changes never rebuild the tool catalog.
- The default `suggest` entry policy creates a durable user decision before changing mode. `manual` rejects model entry; `auto` may enter immediately. Explicit composer or natural-language intent enters directly.
- `submit_plan` and `ask_user` suspend the current Run without manufacturing a new user turn. The corresponding user decision is returned as the result of the original tool call, after which the same Run resumes.
- Plan revisions and questions are persisted in SQLite together with the Event-derived Session projection. A Runtime restart preserves legitimate waiting states instead of failing them as interrupted work.
- The Context Builder places a compact `mode_context` user envelope after retained History and immediately before the latest real user message. Continuations use the paired tool result already at the tail of History. Checkpoints and recovery capsules preserve the latest effective Plan without retaining private reasoning.
- The composer exposes manual Plan Mode under `+` and keeps a compact active-mode indicator visible. Proposed Plans and questions open in the shared, resizable Surface pane alongside file, diff, and browser tabs.
- The Plan Surface renders Markdown, supports user revisions, review comments, clarification answers, cancel/continue/start decisions, and a separate access-mode choice when implementation begins.

The implementation deliberately keeps entry-policy analytics derivable from committed Events rather than adding a second telemetry protocol. More advanced plan-diff comparison, dedicated planning/execution model routing, and provider-specific tuning remain refinement work, not prerequisites for the governed lifecycle.

Verification covers policy precedence, conservative command classification, suggested entry, durable suspension, restart recovery, paired tool results, same-Run continuation, stale and duplicate decisions, context placement and cache-prefix stability, legacy decoding, migrations, reducer replay, production build, and browser layout checks.

## References

- [OpenAI Codex Plan Mode template](https://github.com/openai/codex/blob/main/codex-rs/collaboration-mode-templates/templates/plan.md)
- [How OpenAI uses Codex](https://openai.com/business/guides-and-resources/how-openai-uses-codex/)
- [Claude Code permission modes](https://code.claude.com/docs/en/permission-modes)
- [Claude Code tools reference](https://code.claude.com/docs/en/tools-reference)
- [Claude Code hooks reference](https://code.claude.com/docs/en/hooks)
- [Gemini CLI Plan Mode](https://geminicli.com/docs/cli/plan-mode/)
- [Gemini CLI planning tools](https://geminicli.com/docs/tools/planning/)
- [Cursor Plan Mode](https://cursor.com/blog/plan-mode)
- [ADR 003: DeepSeeker Context Operating System](./003-context-operating-system.md)
- [ADR 004: Clean Runtime Architecture V2](./004-clean-runtime-architecture.md)
- [DeepSeeker Naming Conventions](../naming-conventions.md)
