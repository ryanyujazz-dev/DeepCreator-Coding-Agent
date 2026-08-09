# DeepCreator Skill Package Format

Required:

```text
skill-name/
├── SKILL.md
└── skill.json
```

Optional directories are `references/`, `scripts/`, `assets/`, and product-specific metadata such as `agents/`.

`SKILL.md` begins with YAML frontmatter containing only `name` and `description`. The directory and name must match `/^[a-z0-9]+(?:-[a-z0-9]+)*$/`.

`skill.json` fields:

- `schemaVersion`: exactly `1`;
- `displayName`, `publisher`: non-empty strings;
- `version`, `minDeepCreatorVersion`: SemVer;
- `permissions`: declared package permissions;
- `scripts`: optional map whose entries have `entry`, `description`, and `permissions`.

Script entries must be `.mjs` files inside `scripts/`. Keep the archive below 20 MiB compressed, 50 MiB expanded, and 500 files.

When a Skill declares scripts, its `SKILL.md` must tell the future Agent to use the top-level `run_skill_script` tool with the loaded Skill `capabilityId` and the exact manifest `scriptId`. Package paths are private implementation details. Never instruct the Agent to execute `node scripts/...`, `bun scripts/...`, or similar relative shell commands.

## Installation handoff

After packaging, call the top-level DeepCreator Runtime tool `preview_skill_install` directly when installation is requested. It is not a manifest script or deferred capability. Local sources must remain inside the current project; public GitHub sources must use HTTPS. The preview returns an `installRequest` bound to the exact publisher, version, permissions, scripts, source, and SHA-256.

Pass that object unchanged to the top-level Runtime tool `install_skill`. The user must confirm each installation, including under full-access mode. `project` installs into the active project resolved by Runtime; `global` installs for the current operating-system user resolved by the desktop host. Do not construct either destination path in Skill instructions or scripts.

If either installer tool is missing from the current callable tool set, preserve the package and report that the DeepCreator Runtime must be restarted or updated. Do not call `run_skill_script`, `invoke_capability`, `search_capabilities`, or an MCP discovery flow to find substitutes, because none of those surfaces can provide the trusted installer.

After `install_skill` returns, verify its installed record and search for the exact Skill name with `search_capabilities`. This post-install search verifies discovery; it is not a substitute for the installer.
