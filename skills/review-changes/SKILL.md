---
name: review-changes
description: Review a working tree, commit, or pull request for correctness, regressions, concurrency, error handling, security-sensitive behavior, and missing tests. Use when the user requests code review or merge readiness.
---

# Review Changes

Review observable behavior, not style preferences.

## Workflow

1. Establish the review baseline and enumerate changed files without altering them.
2. Read repository rules and the surrounding implementation, not only the diff.
3. Trace changed inputs through state transitions, persistence, async boundaries, cleanup, and user-visible output.
4. Check callers and consumers for contract drift.
5. Look for correctness defects, regressions, races, cancellation gaps, incomplete error handling, unsafe path or command behavior, and absent tests.
6. Verify suspicious findings with focused reads or tests where permitted.

## Findings

Report only actionable findings. Order them by severity and include a tight file and line range, the triggering scenario, and concrete impact. Do not claim a bug solely because code looks unusual.

If there are no findings, say so and list residual test or platform risks. A review request does not authorize edits, commits, pushes, or merges.
