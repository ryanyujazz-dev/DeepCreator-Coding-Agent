---
name: security-review
description: Review code and configuration for secrets, dependency risk, untrusted input, Electron IPC, filesystem, command execution, network, and authorization vulnerabilities. Use for security review, sensitive boundary changes, or release readiness.
---

# Security Review

Ground findings in repository-specific trust boundaries and reachable behavior.

## Workflow

1. Identify protected assets, attackers, entry points, privilege boundaries, and external effects.
2. Trace untrusted input through validation, normalization, authorization, storage, rendering, filesystem, shell, IPC, and network sinks.
3. Inspect secret handling, log/event redaction, environment inheritance, and persisted credentials.
4. Review Electron context isolation, preload exposure, IPC sender validation, navigation, downloads, and shell usage where applicable.
5. Review path traversal, symlinks, archive extraction, atomic replacement, deletion recovery, command quoting, cancellation, and process-tree cleanup.
6. Check dependency and build-chain risk using repository-supported checks when authorized.

## Findings

For each finding, state severity, preconditions, exploit path, impact, and smallest remediation. Separate confirmed vulnerabilities from hardening suggestions and unknowns. Do not expose discovered secrets in output.

Read `references/electron-and-filesystem.md` when Electron IPC, archives, filesystem writes, or child processes are in scope.
