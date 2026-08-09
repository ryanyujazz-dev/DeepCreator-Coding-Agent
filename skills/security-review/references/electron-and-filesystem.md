# Electron, Filesystem, and Process Checklist

## Electron

- Keep `contextIsolation` enabled and expose the smallest typed preload API.
- Validate every IPC argument again in Main; do not trust renderer-provided paths or project roots.
- Validate IPC senders for privileged operations and reject unexpected origins/windows.
- Avoid renderer access to Node.js, unrestricted navigation, arbitrary downloads, and `shell.openExternal` without URL allowlisting.

## Filesystem and Archives

- Resolve targets under an explicit root and reject absolute paths, `..`, symlinks, devices, duplicate case-folded names, and unexpected file kinds.
- Enforce compressed size, expanded size, and file-count limits before committing installation.
- Stage on the same filesystem as the target, then replace atomically with rollback.
- Send user-requested removals to the operating-system trash when recovery is expected.

## Commands

- Use the runtime shell resolver and platform-safe quoting.
- Start from a minimal environment; never inherit provider tokens into third-party scripts.
- Track child processes as managed objects through completion, cancellation, or stop.
- Preserve output redaction, truncation, and workspace-change collection on every terminal path.
