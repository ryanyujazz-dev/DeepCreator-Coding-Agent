---
name: release-electron
description: Plan and execute a production Electron release across macOS and Windows, including versioning, clean builds, signing, notarization, GitHub Release artifacts, checksums, and auto-update metadata. Use for release preparation or publication.
---

# Release Electron

Build release artifacts from the reviewed release commit, normally the protected release branch or an immutable tag. Keep ordinary development on feature branches.

## Workflow

1. Confirm release version, release commit, supported platforms/architectures, changelog, and rollback plan.
2. Verify the clean release commit with full tests, type checking, production build, and dependency audit.
3. Build each platform on a compatible runner. Do not treat a macOS cross-build of Windows artifacts as equivalent to Windows smoke testing.
4. Sign Windows installers and macOS applications; notarize and staple macOS artifacts.
5. Smoke-test install, first launch, upgrade, uninstall, and preserved user data on each platform.
6. Generate SHA-256 checksums and auto-update metadata from final signed artifacts.
7. Create a draft GitHub Release, upload immutable artifacts, verify downloads, then publish with explicit authorization.

Read `references/macos.md`, `references/windows.md`, and `references/auto-update.md` only for the platform or stage in scope.

Use the top-level `run_skill_script` tool with this Skill's loaded `capabilityId` and the declared script IDs `verify-artifacts` or `checksums` for local artifact inspection. These scripts do not sign or publish anything; never run their package-relative paths as shell commands.
