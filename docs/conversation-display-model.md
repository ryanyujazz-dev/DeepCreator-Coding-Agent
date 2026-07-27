# Conversation Display Model

## Delegated Agents

`delegate` is a completed control-tool fact plus a durable child-run reference. Consecutive delegations aggregate into one header with one member per child. A member displays the child agent, delegated message, and live status; selecting it opens the child Session in the Agent Surface instead of exposing raw tool JSON.

Child conversation content never becomes synthetic parent content. Only the typed terminal result enters parent model context, and child status refreshes must never rewrite the original tool start/done facts. The parent-child control tree is not a shared prompt or cache tree.

## Purpose

This document captures the agreed frontend display model for agent execution flow. It is intentionally stricter than the raw event stream, because the UX goal is not "render every backend activity as one row", but "render a stable set of slots that reuse screen space without visual jumping".

The model below is the authority for future timeline redesign work unless superseded by a newer ADR or spec.

## Visible Data Sources

The conversation view only needs to render three user-visible categories of model/runtime output:

1. normalized reasoning deltas
2. `content`
3. tool execution

Provider-specific fields such as `reasoning_content` must be projected into those categories before they reach the UI. The provider protocol shape is not part of the public Event contract.

## Event Truth vs Render Truth

There are two separate layers:

- Event truth: backend `start` / `done` timing for thinking, text, and tool execution.
- Render truth: the stable slot state the user sees.

The renderer may hold the previous visible label for a slot when the logical state becomes empty, but it must never rewrite, delay, or falsify the underlying `start` / `done` facts.

In short:

```text
logical empty != visual empty
```

## Content Streaming

Assistant content remains independently streamable even when the same provider response later contains tool calls.

- Runtime may coalesce small content deltas, but the buffer has a short maximum latency.
- A newline, size threshold, first tool-call fragment, provider completion, failure, or cancellation flushes the pending content immediately.
- Tool-call arguments remain private until the complete provider step is sealed; this does not permit them to delay preceding content.
- The renderer releases grapheme batches adaptively so its visual backlog stays bounded instead of replaying every received character at a fixed rate.
- Presentation pacing must not change the canonical Activity body.

## Reasoning Inspector

Reasoning has two projections with different jobs. The conversation timeline may use the initial reasoning seed to establish a stable activity slot, while the right-side inspector displays the complete reasoning stream for the current Run.

- Runtime normalizes provider reasoning into durable `reasoning.updated` Run events carrying the current `modelStepId`. Provider field names and response envelopes never enter the Event stream.
- Reasoning is Run-level state, not an Activity and not a tool result. It must not create timeline rows, aggregate counts, tasks, or duplicate lifecycle facts.
- The inspector groups reasoning by model step. Every step owns one bullet and one vertical guide whose height is bounded by that step's text; deltas for the same `modelStepId` update that node in place.
- A visual node requires an explicit `modelStepId`. Legacy aggregate reasoning without a recoverable step boundary may remain in compatibility state, but it must not be rendered as one fake Run-level step.
- The inspector section sits below Plan and Runtime Environment. During an active or waiting Run it is expanded, appends deltas with bounded visual latency, and follows the latest text.
- Upward wheel or scroll movement pauses following so new deltas cannot pull the user away from history. While paused, show a floating scroll-to-bottom control. Clicking it returns to the bottom and resumes adaptive following; manually returning within the bottom threshold does the same.
- When the Run reaches `completed`, `failed`, or `cancelled`, the section automatically collapses. The completed trace remains available through manual expansion.
- Bullets and vertical guides are presentation of model-step grouping only. They do not represent Activities, tools, or additional Runtime execution facts.
- After the first reasoning delta, the inspector header starts as `正在思考`. The first thinking step may produce one early title after a natural paragraph, a hard size boundary, or a bounded wait. After that exception, Runtime submits reasoning only when each model step seals, so one step can produce at most one title candidate.
- A successful early title consumes the first step's title opportunity; the step boundary does not generate a second title. If that first attempt fails validation or transport, the sealed boundary may retry it once.
- Runtime asynchronously persists accepted titles through `reasoning.title.updated`; a title summarizes the current thinking stage and never replaces or edits the underlying reasoning text. If summary work falls behind, only the latest sealed pending step is retained, preventing old titles from replaying late.
- The reasoning title is presentation state, not a tool, task, completion claim, or lifecycle boundary. Summary failures leave the previous title intact and must not delay ordinary model or tool execution.

## Live File Mutations

Tool-call argument fragments are buffered inside Runtime and never create public Activities or file previews. A tool Activity starts only when the complete provider step has been received, its arguments have been parsed, and execution actually begins.

After a file tool writes to disk, publish the Git-derived `activity.files` and `run.changes` snapshot before emitting tool `done`. Rejected, cancelled, or failed operations must never enter aggregate counts or completed change history. Real executor progress, such as stdout from an already-running command, may still stream into the original Activity.

## Segment Boundary

A display segment is the unit that owns one main text area, one aggregate header, and one reusable activity slot.

The boundary rule is:

- Before the first `content`, thinking or tool activity may create a pending segment and occupy its seed slot.
- If that pending segment contains only thinking, the first `content` anchors it and replaces its seed slot in place; it does not allocate a second DOM segment.
- If the pending segment has already started tool work, preserve it as a tool-only segment. The arriving `content` replaces its activity row visually while starting the next segment, so an existing aggregate header never jumps below the content.
- Once a segment is anchored by `content`, the next `content` emission starts a new display segment.
- When that next `content` arrives, it visually replaces the previous segment's activity slot. Do not keep the held activity label as an extra row above the new content.
- Tools that happen after that `content` belong to that segment's aggregate header.
- The next `content` starts the next segment and resets aggregation for subsequent tools.

Do not use `thinking` completion as the segment boundary.
Do not use tool completion as the segment boundary.

## Slot Model

### 1. Seed Slot

Each new segment starts with only one visible slot.

That slot displays the first user-visible state that appears in the segment:

- `[Thinking]` when the first visible state is `reasoning_content`
- `[Reading xxx.py]` or `[Editing xxx.py]` when the first visible state is a tool start
- `content` when the first visible state is model text

### 2. Main Slot

Once a segment receives its first `content`, the seed slot becomes the main slot.

After that:

- the main slot is reserved for that segment's `content`
- later `thinking` must not overwrite it
- later tool execution must not overwrite it

### 3. Aggregate Header

The aggregate header is lazy-created.

Rules:

- If the aggregate result is empty, there is no aggregate header slot.
- The header appears only after the first tool `done`.
- After the header appears, it remains visually active while any tool in the segment is running or while the Agent is still reasoning after those tool results. The dominant headline and the held activity label use the same motion class and rate. Motion stops when new user-facing content starts the next segment, the Run waits for input, or the Run reaches a terminal state; the settled headline then returns to the single neutral execution gray.
- Runtime buffers the complete tool-call step and derives one dominant work intent before executing it.
- Headline arbitration uses tool semantics, targets, command effects, and confidence rather than call counts. Shell plumbing such as `cd`, `echo`, and `sleep` has no headline weight.
- Generic command execution is a fallback and must not automatically outrank an explicit file mutation. Recognized effects such as dependency installation, service startup, database initialization, verification, and deployment may outrank reads or edits when they describe the step's actual result.
- Comparable modification and verification work may use a combined intent such as `Modify and verify project`.
- The dominant intent supplies a stable, non-past-tense headline such as `Locate related content`, `Configure project environment`, `Start database`, or `Verify runtime`.
- The icon before the headline represents that dominant intent rather than a generic completion checkmark.
- The headline may promote at most once per sealed model step and never demotes inside one display segment.
- Completed facts remain separate from the headline, for example:
  - `[Read related information | Read 1 file]`
  - `[Modify project files | Matched 1 file · Searched 2 items · Read 4 files · Edited 1 file]`
- Only successfully completed objects use `completed` wording. Failed and cancelled calls are reported separately.
- When command failures are present, make successful and failed counts unambiguous, for example `Successfully ran 2 commands · 1 failed`.
- A legacy failed tool whose persisted snapshot lacks detailed ToolState still belongs to the aggregate. Keep its raw error available in expanded details; never promote that error body to a first-level timeline row.

The aggregate header must update immediately when a tool finishes.

### 4. Activity Slot

The segment owns one activity slot. Tool-call fragments do not enter it. Among real running tools, it displays the last tool in stable model-call order that is still running.

It may display:

- `[Thinking]`
- `[Reading xxx.py]`
- `[Editing xxx.py]`
- other tool-in-progress labels

When the displayed tool completes while another tool is still running, select the last remaining running tool. Completed tools move into the aggregate header immediately. When the last active tool completes:

- keep the logical state as empty
- keep the visual content as the previous visible label
- replace it only when the next non-empty transient state arrives

This is a render-layer hold, not an event-layer mutation.

Only the initial reasoning seed may display `Thinking`. After a tool has occupied the slot, later reasoning keeps the previous tool label visually held instead of replacing it with `Thinking`. This hold is render truth only; the finished tool remains terminal in Event truth. A `content` boundary consumes the held slot according to the segment-boundary rules.

## Managed Commands

`run_command` has no total runtime limit. It waits for at most 60 seconds and returns either a terminal result or a live `commandId`. A live command remains attached to its original activity slot and continues streaming bounded output.

- `wait_command(commandId)` waits for another checkpoint and updates the original command.
- `stop_command(commandId)` terminates the original process tree and settles the original activity.
- Neither control tool creates a new visible activity slot or aggregate member.
- An Agent Run must not finish while a managed command remains alive. A candidate final response is rejected until the model waits for the command or stops it; cancellation and failure still stop every command owned by the Run as cleanup.
- Command completion, cancellation, and process errors must converge on one authoritative `done` event.

## Empty-Slot Rules

### Aggregate Header

If the aggregate header has never been created, do not reserve space for it.

This means:

```text
main slot     [I will inspect the config first.]
activity slot [Reading settings.py]
```

is correct before the first tool completion, while:

```text
main slot      [I will inspect the config first.]
aggregate slot [empty]
activity slot  [Reading settings.py]
```

is not.

### Activity Slot

Once the activity slot exists for a segment, it may become logically empty, but it should keep rendering the previous visible label until the next transient label arrives.

Examples:

```text
activity slot [Thinking] -> [logical empty, visually keep Thinking] -> [Reading b.py]
activity slot [Reading a.py] -> [logical empty, visually keep Reading a.py during reasoning] -> [Editing c.py]
```

## Canonical Timelines

### Case A: thinking -> content -> tool

```text
t1
seed slot [Thinking]

t2
main slot [I will inspect the config first.]

t3
main slot     [I will inspect the config first.]
activity slot [Reading settings.py]

t4
main slot      [I will inspect the config first.]
aggregate slot [Read related information | Read 1 file]
activity slot  [logical empty, visually keep Reading settings.py]
```

### Case B: existing content segment enters a new thinking/tool step

```text
main slot      [I will inspect the config first.]
aggregate slot [Modify project files | Read 2 files · Edited 1 file]
activity slot  [logical empty, visually keep Editing runner.ts while reasoning]

main slot      [I will inspect the config first.]
aggregate slot [Modify project files | Read 2 files · Edited 1 file]
activity slot  [Reading b.py]
```

### Case C: tool-only segment with no content

```text
t1
seed slot [Thinking]

t2
seed slot [Reading a.py]

t3
aggregate slot [Read related information | Read 1 file]
activity slot  [logical empty, visually keep Reading a.py]

t4
aggregate slot [Modify project files | Read 1 file]
activity slot  [Editing b.py]

t5
aggregate slot [Modify project files | Read 1 file · Edited 1 file]
activity slot  [logical empty, visually keep Editing b.py]
```

### Case D: next content starts a new segment

```text
before next content
main slot      [I will inspect the config first.]
aggregate slot [Modify project files | Read 2 files · Edited 1 file]
activity slot  [logical empty, visually keep Editing runner.ts]

after next content
previous segment
main slot      [I will inspect the config first.]
aggregate slot [Modify project files | Read 2 files · Edited 1 file]

next segment
main slot [I found the root cause and will patch it now.]
```

## Expansion Hierarchy

The agreed expansion hierarchy is:

1. aggregate header
2. completed per-object item
3. item detail

Example:

```text
Read 2 files | Edited 1 file
|- Read a.py
|  \- file content or matched snippets
|- Read b.py
|  \- file content or matched snippets
\- Edited runner.ts
   \- diff, patch, or edit detail
```

## Tool Granularity Rule

Future tools should prefer:

```text
one tool_call = one independent object or work unit
```

Examples:

- `read_file(path)` should read one file per call
- `edit_file(path, ...)` should edit one file per call
- if the model wants multiple files, it should emit multiple tool calls

This matches the Runtime design: parallel-safe calls in one model step execute concurrently as separate activities, while workspace mutations and control calls remain ordered.

## Batch Tool Fallback

The project still needs a fallback rule for unavoidable batch tools.

If a future tool processes multiple independent objects inside one call, the implementation must also define child-level progress semantics, so the UI can still project stable per-object completion.

At minimum, a batch tool must expose an internal model equivalent to:

```text
outer tool start
  child object A start/done
  child object B start/done
  child object C start/done
outer tool done
```

Without that child-level contract, the conversation UI cannot truthfully render:

- per-object aggregation
- expandable second-level completed items
- a stable activity slot for the current object

## Non-Negotiable Invariants

The following invariants must remain true:

1. Never falsify tool `start` or `done`.
2. Never delay aggregate-header updates past real tool completion.
3. Never create an empty aggregate-header slot.
4. Never let later `thinking` overwrite a segment's main content slot.
5. Allow activity-slot logical emptiness, but preserve its previous visual label until the next transient state arrives.
6. Prefer one tool call per independent object; batch tools need child-level progress semantics.
7. Project at most one activity slot: the last real tool in stable call order that is still running.
8. Make command control calls update the original command instead of creating duplicate activities.
9. Never finish an Agent run while one of its managed commands is running; use `wait_command` or `stop_command` first.
10. Buffer tool-call fragments until the provider step is complete; fragments never create public Activities.
11. Derive one dominant headline for the complete step and carry it on durable tool facts.
12. Keep a segment headline monotonic; completed counts may update independently after every real tool terminal event.
13. Project only the initial thinking seed. Later reasoning visually holds the previous tool label.
14. Bound content-delta latency independently of tool-call argument streaming.
15. Treat generic command execution as a fallback headline; only a recognized, higher-impact command intent may outrank explicit read or mutation work.
16. Keep the complete reasoning trace grouped by model step as Run-level inspector state, preserve user-controlled history scrolling, and collapse it automatically when the Run becomes terminal.
