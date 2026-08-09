---
name: diagnose-failure
description: Reproduce, isolate, and explain build, test, runtime, packaging, or CI failures using the smallest reliable experiment. Use when something fails or behaves inconsistently; without fix authorization, stop after diagnosis.
---

# Diagnose Failure

Separate diagnosis from repair authority.

## Workflow

1. Capture the exact failing command, environment, exit status, and earliest actionable error.
2. Reproduce with the narrowest existing command. Do not repeatedly run an unchanged expensive command.
3. Compare the failing path with adjacent passing paths and recent workspace changes.
4. Form competing hypotheses, then run one discriminating check at a time.
5. Trace the failure to the responsible boundary: input, configuration, dependency, platform, process, persistence, or product logic.
6. Explain root cause, evidence, blast radius, and confidence. Distinguish root-cause errors from downstream noise.

## Authority Boundary

If the user asked only to diagnose, do not edit files, install dependencies, restart external services, or publish changes. Provide the smallest credible fix direction separately.

When a command remains running, manage its original command ID until it reaches a terminal state.
