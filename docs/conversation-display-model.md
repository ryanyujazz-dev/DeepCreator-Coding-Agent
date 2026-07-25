# Conversation Display Model

## Purpose

This document captures the agreed frontend display model for agent execution flow. It is intentionally stricter than the raw event stream, because the UX goal is not "render every backend activity as one row", but "render a stable set of slots that reuse screen space without visual jumping".

The model below is the authority for future timeline redesign work unless superseded by a newer ADR or spec.

## Visible Data Sources

The conversation view only needs to render three user-visible categories of model/runtime output:

1. `reasoning_content`
2. `content`
3. tool execution

Anything else must be projected into those categories before it reaches the timeline UI.

## Event Truth vs Render Truth

There are two separate layers:

- Event truth: backend `start` / `done` timing for thinking, text, and tool execution.
- Render truth: the stable slot state the user sees.

The renderer may hold the previous visible label for a slot when the logical state becomes empty, but it must never rewrite, delay, or falsify the underlying `start` / `done` facts.

In short:

```text
logical empty != visual empty
```

## Live File Mutations

`write_file` and `edit_file` may expose a throttled `liveFiles` preview while their arguments stream. The active slot shows its current `+x -x` metrics and remains expandable so the user can watch code arrive. This preview is render state, not workspace truth.

After the tool writes to disk, replace the preview with the Git-derived `activity.files` and `run.changes` snapshot before emitting tool `done`. Rejected, cancelled, or failed operations clear `liveFiles`; previews must never enter aggregate counts or completed change history.

## Segment Boundary

A display segment is the unit that owns one main text area, one aggregate header, and a dynamic list of activity slots.

The boundary rule is:

- Before the first `content`, thinking or tool activity may create a pending segment and occupy its seed slot.
- If that pending segment contains only thinking, the first `content` anchors it and replaces its seed slot in place; it does not allocate a second DOM segment.
- If the pending segment has already started tool work, preserve it as a tool-only segment. The arriving `content` replaces its activity row visually while starting the next segment, so an existing aggregate header never jumps below the content.
- Once a segment is anchored by `content`, the next `content` emission starts a new display segment.
- When that next `content` arrives, it visually replaces the previous segment's activity slot. Do not keep the held activity label as an extra row above the new content.
- Tools that happen after that `content` belong to that segment's aggregate header.
- A valid standalone `tools_use_statement` with `mode="new"` starts a new tool-purpose segment even when no `content` appears between tool batches.
- A valid `mode="continue"` keeps subsequent tools in the active purpose segment. Runtime, not the renderer, resolves this relationship and persists one shared `groupId`.
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

The aggregate header combines an optional model-declared purpose with Runtime-derived facts.

Rules:

- If the aggregate result is empty, there is no aggregate header slot.
- For legacy or undeclared tools, the header appears only after the first tool `done`.
- For a valid declared group, the purpose title may appear while its first real tool is running. The declaration control call itself is never visible or counted.
- The header summarizes completed work, for example:
  - `[Inspect project architecture | Read 1 file]`
  - `[Trace the authentication failure | Searched 2 items · Read 2 files]`
  - `[Implement session persistence | Edited 1 file]`

The model owns only the purpose title. Runtime owns tool counts, targets, status, and failure facts. The aggregate header must update immediately when a tool finishes.

#### Tool-use statement protocol

`tools_use_statement` is a control-only declaration that occupies its own model turn.

- `new` creates a new purpose group and requires a concise title.
- `continue` reuses the active group's title and `groupId`.
- A valid declaration response contains exactly one `tools_use_statement` call and arms a one-use Runtime gate.
- The immediately following provider response may contain one or more ordinary tools and consumes that gate.
- Any non-empty model `content` closes the active group; the next declaration must use `new`.
- Missing, malformed, duplicated, mixed, or stacked declarations reject the affected tool-call turn.
- Undeclared ordinary tools are rejected before execution and never enter the visible event stream.
- The declaration receives a normal tool result so provider history remains protocol-complete.
- Runtime persists one internal `statement` Activity only as a durable stage boundary. The renderer consumes it semantically; it never becomes a control-tool row, count, approval, or workspace fact.
- The resolved statement metadata is copied onto each permitted ordinary tool's durable `ToolState`, so refresh, SSE replay, and Runtime restart produce the same grouping.
- A declared stage remains visually active after its tools finish while the model is interpreting their returned facts.
- `mode="continue"` keeps that stage active. A different `mode="new"`, non-empty model `content`, a waiting state, or a terminal Run state closes it.
- Only the first `thinking` seed before any visible stage or content is projected. Later reasoning does not create another “正在思考” row; the active statement title carries the ongoing visual state instead.

### 4. Activity Slots

Activity slots display transient live states for the segment. Every independently running tool object owns one slot. If another tool starts before it completes, append another stable slot instead of replacing the existing one.

It may display:

- `[Thinking]`
- `[Reading xxx.py]`
- `[Editing xxx.py]`
- other tool-in-progress labels

When one of several tools completes, remove only its slot and move that tool into the aggregate header. When the last active tool completes:

- keep the logical state as empty
- keep the visual content as the previous visible label
- replace it only when the next non-empty transient state arrives

This is a render-layer hold, not an event-layer mutation.

`reasoning_content` uses an available empty slot or allocates a new one. It must not hide another running tool. A `content` boundary consumes its own reasoning slot while unrelated running tool slots remain visible in their originating segment.

## Managed Commands

`run_command` has no total runtime limit. It waits for at most 60 seconds and returns either a terminal result or a live `commandId`. A live command remains attached to its original activity slot and continues streaming bounded output.

- `wait_command(commandId)` waits for another checkpoint and updates the original command.
- `stop_command(commandId)` terminates the original process tree and settles the original activity.
- Neither control tool creates a new visible activity slot or aggregate member.
- Normal Agent completion may leave managed commands alive; cancelling the run stops every command owned by that run.
- Command completion, cancellation, and process errors must converge on one authoritative `done` event.

## Empty-Slot Rules

### Aggregate Header

If an undeclared aggregate header has never been created, do not reserve space for it. A declared purpose title is meaningful content and may occupy the header while tools are running.

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
activity slot [Reading a.py] -> [logical empty, visually keep Reading a.py] -> [Editing c.py]
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
aggregate slot [Read 1 file]
activity slot  [logical empty, visually keep Reading settings.py]
```

### Case B: existing content segment enters a new thinking/tool step

```text
main slot      [I will inspect the config first.]
aggregate slot [Read 2 files | Edited 1 file]
activity slot  [Thinking]

main slot      [I will inspect the config first.]
aggregate slot [Read 2 files | Edited 1 file]
activity slot  [logical empty, visually keep Thinking]

main slot      [I will inspect the config first.]
aggregate slot [Read 2 files | Edited 1 file]
activity slot  [Reading b.py]
```

### Case C: tool-only segment with no content

```text
t1
seed slot [Thinking]

t2
seed slot [Reading a.py]

t3
aggregate slot [Read 1 file]
activity slot  [logical empty, visually keep Reading a.py]

t4
aggregate slot [Read 1 file]
activity slot  [Editing b.py]

t5
aggregate slot [Read 1 file | Edited 1 file]
activity slot  [logical empty, visually keep Editing b.py]
```

### Case D: next content starts a new segment

```text
before next content
main slot      [I will inspect the config first.]
aggregate slot [Read 2 files | Edited 1 file]
activity slot  [logical empty, visually keep Editing runner.ts]

after next content
previous segment
main slot      [I will inspect the config first.]
aggregate slot [Read 2 files | Edited 1 file]

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
3. Never create an empty aggregate-header slot; a non-empty declared purpose title is not empty.
4. Never let later `thinking` overwrite a segment's main content slot.
5. Allow activity-slot logical emptiness, but preserve its previous visual label until the next transient state arrives.
6. Prefer one tool call per independent object; batch tools need child-level progress semantics.
7. Give every independently running object its own stable activity slot.
8. Make command control calls update the original command instead of creating duplicate activities.
9. Never finish an Agent run while one of its managed commands is running; use `wait_command` or `stop_command` first.
10. Normalize a repeated `new` declaration with the same title into the active group when no assistant content intervened.
11. Do not let thinking from the standalone declaration turn split an existing statement group.
12. Keep a declared stage active while the model digests completed tool facts; tool completion alone is not a stage boundary.
13. Project only the initial thinking seed, without a leading icon, and use the same active-title animation as statement headers.
