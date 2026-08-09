---
name: verify-change
description: Select and run proportionate verification for a code change, from focused tests through type checks, builds, packaging, and cross-platform checks. Use after implementation or before merge and release.
---

# Verify Change

Choose verification from the changed behavior and risk, not from habit.

## Workflow

1. Inspect the actual diff and map each change to its user-visible or runtime contract.
2. Run the smallest focused test that can fail for each changed behavior.
3. Add type checking, linting, integration tests, build, or packaging when the affected boundary requires them.
4. For platform-sensitive paths, shells, filesystem operations, Electron packaging, or native modules, identify what was tested on each supported platform.
5. Confirm every managed command reaches a terminal state and distinguish assertion failures from cleanup-only platform errors.
6. Recheck the final diff for generated or incidental changes.

## Report

List commands and outcomes, what each result proves, skipped checks with reasons, and remaining risk. Never report a check as passing if it was not run or its process did not finish.
