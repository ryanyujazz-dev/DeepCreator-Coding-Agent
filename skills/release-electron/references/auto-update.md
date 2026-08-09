# Auto-update and GitHub Release

- Publish update metadata only after final signed artifacts exist; metadata must reference the exact uploaded files.
- Keep version, Git tag, release title, artifact names, checksums, and update metadata consistent.
- Use a draft release while validating download URLs and signatures.
- Do not replace an already-published artifact under the same version. Publish a new patch version.
- Rollout should tolerate an unavailable update server and must not corrupt the currently installed version.
- Release notes should include supported operating systems, known issues, data migrations, and rollback instructions.
