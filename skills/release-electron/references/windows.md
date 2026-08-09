# Windows Release

Build and smoke-test Windows release artifacts on a Windows runner. A macOS-produced Windows package does not validate Windows shell resolution, path behavior, native modules, signing, installer elevation, shortcuts, or uninstall cleanup.

Smoke checks:

- Authenticode signature is valid after download.
- Installer, first launch, workspace selection, runtime startup, update, and uninstall succeed.
- User settings and intended workspace data survive upgrades.
- Long paths, spaces, non-ASCII paths, 125% display scaling, and common endpoint protection behavior are considered.
- Cleanup-only `EPERM` failures are distinguished from failed assertions, but are still tracked when they leak data or processes.
