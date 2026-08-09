# Pull Request Checklist

- Branch is based on the intended target and has no accidental merge/rebase leftovers.
- Staged files match the requested scope; secrets, local databases, logs, and generated output are excluded.
- Commit subjects are concise, imperative, and focused.
- PR body explains user-visible behavior, implementation boundaries, verification commands, remaining risks, and rollback considerations.
- Relevant issues or architecture decisions are linked.
- Renderer changes include current screenshots and keyboard/theme/responsive notes.
- Required CI checks are passing or failures are clearly explained.
- Merge strategy preserves repository policy and does not rewrite shared history unexpectedly.
