---
id: docs-update-refusal-fixes-gate
tasks: [T14663]
kind: fix
summary: "every cleo docs update refusal carries a runnable fix, and gate 42 covers the docs update path"
---
- Every `cleo docs update` refusal, at dispatch and in core, returns a runnable
  `cleo …` command as the envelope's `error.fix` (a missing slug, an invalid
  status, an unknown slug or base, an unreadable file, a strict schema
  mismatch, a blob write failure).
- Gate 42 (`scripts/lint-refusal-fixes.mjs`) now judges the `docs.update`
  dispatch handler and core `docs-update.ts`, including its
  `{ ok: false, error }` result literals, so a fix-less or unrunnable docs
  update refusal fails CI.
