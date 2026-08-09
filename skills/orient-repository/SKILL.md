---
name: orient-repository
description: Build an evidence-based map of an unfamiliar repository, including project rules, architecture, technology stack, entry points, and verification commands. Use at the start of substantial work or when repository conventions are unclear.
---

# Orient Repository

Use this Skill before substantial work in an unfamiliar repository.

## Workflow

1. Read repository guidance files from the workspace root down to the target files. Treat the closest applicable guidance as authoritative.
2. Inspect the root file tree, package/build manifests, lockfiles, CI configuration, and main source directories.
3. Identify runtime entry points, shared contracts, persistence boundaries, generated code, and test locations from actual imports and scripts.
4. Read only the files necessary to verify the map. Do not infer a framework or command from filenames alone.
5. Check the working tree before proposing changes so existing user edits are not mistaken for task changes.
6. Report a compact repository map with evidence, relevant commands, and unresolved questions.

## Output

Include:

- repository rules that affect the task;
- technology stack and package manager;
- key directories and ownership boundaries;
- development, focused-test, full-test, type-check, build, and packaging commands when present;
- likely files for the requested task;
- dirty-worktree risks and unknowns.

Do not modify files while orienting unless the user also requested implementation.
