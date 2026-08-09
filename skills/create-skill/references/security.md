# Skill Security

- Treat every third-party package as untrusted until the user reviews its publisher, files, permissions, scripts, version, and SHA-256 content hash.
- Never include secrets, credentials, private keys, tokens, personal registries, or generated logs in a package.
- Do not use absolute paths, `..`, symlinks, devices, sockets, duplicate case-folded paths, or code downloaded at runtime.
- Declare the smallest package and per-script permissions. Do not hide filesystem, network, command, deletion, or external effects in prose.
- Validate all script arguments, resolve writes under the current project, and fail before partial mutation when possible.
- Content changes produce a new hash and require a new trust decision. Version the package accordingly.
