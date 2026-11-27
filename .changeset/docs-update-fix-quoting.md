---
id: docs-update-fix-quoting
tasks: [T14668]
kind: fix
summary: "cleo docs update refusal fixes shell-quote paths and slugs; the strict schema-mismatch fix re-runs the same --strict update with every flag"
---
- Every `cleo docs update` refusal fix that interpolates a path or slug now
  shell-quotes it, so a pasted fix naming a file under `Application Support`
  runs as written.
- The `--strict` schema-mismatch refusal now names the missing `## ` headings
  and its fix re-runs the same `--strict` update with every original flag
  (base version, status, file) instead of `cleo docs fetch`.
- `shellQuote` moved to `packages/core/src/lib/shell-quote.ts`; `done-plan`
  re-exports it.
