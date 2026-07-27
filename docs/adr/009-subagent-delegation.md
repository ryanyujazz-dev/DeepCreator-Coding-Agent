# ADR-009: Independent Subagent Delegation

## Decision

`delegate(agent, message)` creates a durable child Session and Run. The child has its own complete system prompt, fixed tool whitelist, context records, compaction state, and cache prefix. The parent message is the child's first user message; parent history, checkpoints, reasoning, and tool records are never copied.

The parent-child link is a control and presentation tree, not a prompt or cache tree. A child terminal result is the only child content inserted into the parent context, using a typed `delegation_result` Runtime envelope.

## Protocol

The `delegate` tool result acknowledges creation and is persisted exactly once for its `tool_call_id`. Child completion does not append a second tool result. Instead, Runtime records a terminal Delegation event and a separate context entry, then wakes the parent Run. A parent Run cannot finish while one of its originating delegations is active or its result has not been delivered to the model.

Failures and cancellations are terminal results, not successful fallback summaries. Child `content` is preserved verbatim, including an empty string; status and error remain separate fields.

## Control boundaries

- A parent Run may own at most four concurrent children.
- Child profiles do not expose `delegate`, so delegation depth is one.
- Cancelling a parent recursively cancels active children. Steering remains scoped to the selected Run.
- Child follow-up Runs remain in the child Session but do not re-open or block the original parent delegation.
- Sessions share the project root. Workspace-mutating tools use one abort-aware lease per normalized project root; non-read-only managed commands retain that lease until terminal state.

## Presentation

Subagent Sessions are hidden from the ordinary task sidebar. Delegations appear as specialized aggregate members in the parent conversation. Selecting one opens an Agent Surface backed by the child's ordinary Session snapshot and SSE stream, so the same timeline, approvals, cancellation, steering, follow-ups, and file surfaces remain authoritative.
