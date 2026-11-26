---
id: cant-import-root-nearest
tasks: [T14645]
kind: fix
summary: "cleo cant validate roots import containment at the nearest .cleo or .git ancestor, and treats backslash import paths as relative"
---

A `.cant` file in a git repository without its own `.cleo/`, under a home
directory holding `~/.cleo/`, was rooted at the home directory: import
containment covered the whole home directory and `@name` resolved to
`~/.cleo/skills`. The project root is now the nearest ancestor holding
`.cleo/` or `.git`.

- `.\` and `..\` import specifiers are relative, and `..\` escapes are refused
  with S09, on every host.
- A Windows verbatim canonical path (`\\?\C:\...`) is compared in its plain
  form, so containment holds on Windows.
