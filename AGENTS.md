# Repository Guidelines

## Project Structure & Module Organization

`src/` contains the React renderer, timeline components, stream helpers, and global styles. `server/` contains the runtime, tool pipeline, persistence, and HTTP transport. Shared event contracts, reducers, and projections live in `shared/`; Electron entry points live in `desktop/`. Tests are in `tests/` and mirror runtime concerns with files such as `runner.test.ts` and `displaySegments.test.ts`. Architecture decisions and display specifications are under `docs/`.

## Build, Test, and Development Commands

- `npm run dev:all` starts the runtime and Vite renderer together.
- `npm run dev:desktop` launches the Electron application.
- `npm run build` runs TypeScript validation and creates the production Vite bundle.
- `npm test` executes all Node test files through `tsx`.
- `npx tsx --test tests/displaySegments.test.ts` runs one focused suite.

## Coding Style & Naming Conventions

Use strict TypeScript, two-space indentation, semicolons, and double quotes. React components and exported types use PascalCase; functions, variables, and file-local helpers use camelCase. Keep domain rules in `shared/` instead of duplicating them in components. Prefer small pure projection functions and discriminated unions. Follow existing filenames: PascalCase for React components and camelCase for services or projections. Run `npm run build` before submitting changes.

Route runtime commands through `resolveRuntimeShell`; never hard-code `/bin/zsh`, `/tmp`, or another platform-specific shell path. Tests that need a workspace must allocate it with `tmpdir()`.

## Testing Guidelines

Tests use `node:test` with `node:assert/strict`. Name files `*.test.ts` and describe observable behavior, not implementation details. Add projection tests for every timeline state transition and runtime tests when event production changes. Windows may report `EPERM` while deleting SQLite-backed temporary directories; confirm whether assertions passed before treating cleanup failures as product regressions.

## Commit & Pull Request Guidelines

History uses short imperative subjects, often with prefixes such as `feat:`, `fix:`, or `refactor:`. Keep commits focused. Pull requests should explain user-visible behavior, list verification commands, link relevant issues or ADRs, and include screenshots for renderer changes.

## Agent Execution Flow

Treat [the conversation display model](docs/conversation-display-model.md) as authoritative. Preserve real tool `start` and `done` facts. First content anchors a thinking-only seed; content after tool work starts the next segment. Aggregate headers are lazy, and logically empty activity slots retain their previous visual label. Prefer one tool call per independent object. Batch tools require child-level progress semantics.

Long-running commands are managed objects: `run_command` yields a `commandId`, while `wait_command` and `stop_command` control the original activity without creating another slot. Never reintroduce a hard command timeout or duplicate a still-running command to poll it.
An Agent run must not finish while one of its managed commands is still running. Continue with `wait_command` or end it with `stop_command`; final content is valid only after every command reaches a terminal state.
Every persisted assistant `tool_calls` message must have exactly one result per `tool_call_id`. Cancellation and failure paths must append explicit interrupted results before closing the Run, and provider-bound history must still be protocol-normalized to repair legacy or out-of-order records.

For file mutations, keep streamed `liveFiles` previews separate from authoritative Git-derived `activity.files` and `run.changes`. Never aggregate a preview as a completed workspace change.
