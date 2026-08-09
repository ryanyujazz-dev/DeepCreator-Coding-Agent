---
name: create-skill
description: Create, validate, package, install, and verify a DeepCreator Skill with progressive disclosure, declared scripts, minimal permissions, and hash-bound trust. Use when authoring or updating a Skill or producing a .deepcreator-skill package.
---

# Create Skill

Create the smallest reliable package that teaches one coherent workflow.

## Workflow

1. Establish concrete positive, error, and non-trigger examples for the requested workflow.
2. Choose a lowercase hyphenated, preferably verb-led name. Use the declared `init` script to create the Skill skeleton inside the current workspace; provide a real description and publisher.
3. Replace every TODO. Keep `SKILL.md` frontmatter to `name` and `description`, put all trigger conditions in the description, and keep the body concise and imperative.
4. Move platform-specific or detailed material into `references/`; put reusable output templates in `assets/`. Do not add auxiliary README or installation guides.
5. Add scripts only for deterministic work. Scripts must be package-local `.mjs` files declared in `skill.json` with the smallest permissions.
6. In the created Skill's instructions, tell the future Agent to call the top-level `run_skill_script` tool with the loaded `capabilityId` and exact manifest `scriptId`. Never instruct it to run `node scripts/...` or another package-relative shell command.
7. Run the declared `validate` script. Forward-test at least one correct trigger, one error path, and one non-trigger; then run `pack` to create the distributable.
8. If installation was requested, choose the scope deliberately. Use `project` for the active persistent project. If the environment says `workspaceKind` is `scratch`, explain that `project` means only the current temporary task and ask the user to choose it or `global`; never call it the current project.
9. Call the top-level Runtime tool `preview_skill_install` directly with the package path and chosen scope. Read the returned security preview, then pass its `installRequest` to `install_skill` unchanged. Treat refusal as final.
10. Require the `install_skill` result to report the expected name, scope, enabled state, trusted state, version, and hash. Then use `search_capabilities` with the exact Skill name to confirm discovery. Do not claim success from packaging or file existence alone.

## Installation Tool Boundary

`preview_skill_install` and `install_skill` are DeepCreator Runtime tools. They are never Skill script IDs, capabilities, MCP tools, files, or shell commands.

- Call them directly from the current run's top-level tool set.
- Never send either name to `run_skill_script`, `invoke_capability`, or `search_capabilities`.
- Never inspect the package manifest to find them; `skill.json.scripts` contains only package-local scripts such as `validate` and `pack`.
- If either Runtime tool is absent from the callable tool set, stop the installation step immediately. Keep the validated package, explain that this DeepCreator Runtime must be restarted or updated to expose the installer, and do not search for an alternative installation route.

Read `references/package-format.md` before editing metadata and `references/security.md` before adding scripts or downloadable assets.

The `init` script accepts a name plus `--description`, `--publisher`, optional `--display-name`, `--path`, and `--resources`. The `validate` script accepts a Skill directory. The `pack` script accepts a Skill directory and optional output file; it validates first and writes a ZIP-compatible `.deepcreator-skill` package.

Never guess a user's home directory, username, application-data directory, or installation path. Never copy a Skill directly into `.deepcreator/skills`; the Runtime resolves the active project and current user's global directory and the installer owns staging, trust, rollback, and registry updates. Do not claim installation succeeded until `install_skill` returns the installed Skill record.
