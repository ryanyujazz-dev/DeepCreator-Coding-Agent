---
name: publish-github
description: Prepare and publish repository changes through a safe GitHub branch, commit, push, and pull request workflow. Use only when the user explicitly asks to commit, push, publish, open a PR, or merge.
---

# Publish GitHub

External writes require explicit user authorization.

## Workflow

1. Confirm repository, branch, upstream, worktree status, and the exact changes in scope.
2. Preserve unrelated user changes. Stage only intentional files.
3. Run the repository-required verification before publication and report any skipped checks.
4. Use a short imperative commit subject consistent with repository history.
5. Push the current feature branch without force unless force is explicitly requested and justified.
6. Create or update a pull request with user-visible behavior, verification, risks, issue links, and screenshots for renderer changes.
7. Merge only when the user explicitly requested it and required checks and review state are known.

## Safety

Never infer authorization to publish from a request to review, diagnose, or implement. Do not rewrite shared history, delete branches, modify repository settings, or merge through failing checks without explicit direction.

Read `references/pull-request-checklist.md` before opening a pull request.
