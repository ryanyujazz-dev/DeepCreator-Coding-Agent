# macOS Release

Build on macOS using the repository's pinned Node and package-manager versions. Produce the supported architecture set, sign nested helpers and the application with the Developer ID identity, then notarize the final distributable and staple the ticket where applicable.

Smoke checks:

- Gatekeeper accepts the downloaded artifact on a clean machine.
- The application launches, opens a workspace, starts its runtime, and persists settings.
- Upgrade preserves user data and old artifacts remain available for rollback.
- Both Apple Silicon and Intel behavior are covered when both are supported.

Keep signing certificates and notarization credentials in CI secret storage; never place them in repository files, logs, or Skill packages.
