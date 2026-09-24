---
id: portable-project-identity
tasks: [T12325]
kind: feat
summary: "Projects get a tracked, write-once identity (`.cleo/project-id`), so a fresh clone, a move or a new device keeps the same projectId (ADR-094, amends ADR-013 §9)"
---

The only random project identity lived in `.cleo/project-info.json`. That
file is gitignored under ADR-013 §9, so `cleo init` in a fresh clone minted a
new UUID. A restore onto a new machine did the same, because the backup merge
kept a freshly generated `projectId`. One repository therefore had a
different identity on every device.

`cleo init`, `cleo upgrade` and scaffold repair now adopt the project's id
into `.cleo/project-id`. The file is created once with `O_EXCL`, allowed by
the `.cleo/.gitignore` template, and never rewritten. An existing
`project-info.json` id is adopted as-is, so nothing re-keys.

- **Fresh clone:** takes the tracked id.
- **Both files missing:** the id is re-linked from the global registry (a row
  at the same path, the canonical-fingerprint alias, or a live checkout of the
  same remote). The re-link is reported. When several candidates match, CLEO
  refuses to guess. A new id is minted only when nothing can be re-linked, or
  explicitly with `cleo init --new-identity`.
- **Conflict or malformed file:** reported, never overwritten.
- **Moved project:** keeps its id. Its single registry row is re-pointed in
  place.

`regenerateProjectInfoJson` (restore) and `nexusRegister`/`nexusReconcile` on
a checkout where `cleo init` has not run now use the tracked id instead of a
random or path-derived one.
