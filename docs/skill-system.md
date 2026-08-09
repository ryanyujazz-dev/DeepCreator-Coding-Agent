# DeepCreator Skill System

DeepCreator ships a progressively disclosed Skill catalog. The capability index contains short metadata; `invoke_capability` loads the selected `SKILL.md`, and references, assets, or scripts are accessed only through their dedicated tools.

## Package layout

```text
skill-name/
├── SKILL.md
├── skill.json
├── references/
├── scripts/
└── assets/
```

`SKILL.md` frontmatter permits only `name` and `description`. Names use lowercase hyphen-case and must match the directory. `skill.json` uses schema version 1, SemVer versions, declared permissions, and optional `.mjs` scripts. A script must declare `local_code_execution`, must stay under `scripts/`, and cannot request permissions absent from its package.

Directories containing only `SKILL.md` remain compatible as legacy Skills. They can provide instructions but cannot run scripts or participate in updates.

## Discovery and precedence

The Runtime receives the built-in directory through `RuntimeOptions.builtinSkillDirectory`. Development reads the repository `skills/` directory; packaged Electron builds read `process.resourcesPath/skills`. Runtime infrastructure does not infer an Electron path.

Third-party locations are:

- global: `~/.deepcreator/skills/<name>`;
- project: `<project>/.deepcreator/skills/<name>`.

For a scratch task, project scope means that task's isolated workspace rather than a persistent user project. The Settings page labels this scope as “当前临时任务”, lists its installed Skills, and reloads the catalog whenever the user opens the Skills page. Global scope remains available to the current operating-system user across projects and tasks.

For identical names, built-in always wins. Otherwise, the current-project version wins over the global version. Disabled or shadowed Skills do not enter the effective capability index. Built-ins are locked against replacement, update, and removal, but can be disabled.

## Installation and trust

Electron Main owns `SkillStore` and exposes a typed `DesktopBridge.skills` API. Local folders, `.deepcreator-skill` ZIP packages, public GitHub repository URLs, and public GitHub Release URLs follow the same preview and installation path.

Before installation, DeepCreator stages content in application data and rejects absolute/traversal paths, backslashes in ZIP names, symlinks, devices, duplicate case-folded names, malformed metadata, missing script entries, incompatible application versions, more than 500 files, downloads above 20 MiB, or expanded content above 50 MiB. It computes a deterministic SHA-256 over names and contents and displays publisher, version, permissions, files, and scripts.

Installation uses same-filesystem prepare, backup, replace, registry update, and rollback steps. The personal registry stores enabled state, update source, content hash, and trust decision. Project files cannot declare themselves trusted. A content-hash change invalidates trust.

Agent-initiated installation uses the same `SkillStore` transaction through two Runtime tools. `preview_skill_install` accepts only current-workspace local sources or public GitHub HTTPS sources, requires an explicit `project` or `global` scope, and returns a temporary `installRequest`. `install_skill` requires that request unchanged, verifies it against the retained preview and staged SHA-256, and always pauses for a one-shot user confirmation. Full-access mode cannot bypass this trust gate, and the approval cannot be promoted to a Run- or Session-wide grant.

Installation destinations are host-injected rather than model-authored. Electron supplies the current operating-system user's global Skill directory and preview directory; Runtime supplies the active session project root for project scope. The Agent never constructs a username, home directory, application-data path, or arbitrary project destination.

Removal uses the operating-system trash. GitHub update checks are rate-limited to once per 24 hours per installed source and never replace content automatically. `update` returns a fresh preview so the user can review and trust the new hash.

## Runtime tools

- `search_capabilities`: searches concise metadata, including version, origin, publisher, and permissions.
- `invoke_capability`: loads the full instruction body as a ContextUpdate.
- `read_skill_resource`: reads text under `references/` without escaping its Skill root.
- `materialize_skill_asset`: atomically copies one `assets/` file into the project and records a normal workspace change.
- `run_skill_script`: runs a trusted manifest-declared `.mjs` file from the project root.
- `preview_skill_install`: stages and validates a local or public GitHub Skill and returns its hash-bound installation request.
- `install_skill`: presents the retained preview for one-shot user trust and atomically installs it to the host-resolved project or global scope.

The stable Agent environment includes `workspaceKind`, so installation guidance can distinguish a persistent project from a scratch task without inferring meaning from a filesystem path. A Skill that declares scripts must instruct the Agent to use `run_skill_script` with the loaded `capabilityId` and exact manifest `scriptId`; direct package-relative commands such as `node scripts/...` are rejected by the `create-skill` validator.

Skill scripts share the managed-command lifecycle: command IDs, wait, stop, cancellation, terminal states, output redaction/truncation, and Git-derived change collection. They receive a minimal environment and do not inherit model keys, Runtime tokens, GitHub tokens, `NODE_OPTIONS`, or unrelated process variables.

Installation trust means the user accepts that a script runs as the current operating-system user. It is not a full operating-system sandbox and cannot bypass the Runtime's existing approval rules for destructive or external operations.

## Built-in delivery and release

The repository contains eight built-ins: `orient-repository`, `diagnose-failure`, `review-changes`, `verify-change`, `security-review`, `publish-github`, `release-electron`, and `create-skill`. They are copied beside the packaged application through Electron Forge `extraResource` and update only with DeepCreator. `create-skill` provides declared `init`, `validate`, and `pack` scripts, requires unfinished templates to be completed, verifies script-dispatch instructions, and confirms post-install discovery through the capability index.

`npm run make:mac` and `npm run make:windows` create downloadable ZIP artifacts. The release workflow builds on native macOS and Windows runners, uploads both artifacts, and publishes them for `v*` tags. Production distribution still requires the signing, notarization, installer, smoke-test, and auto-update credentials described by `release-electron` before a release is presented as fully trusted.
