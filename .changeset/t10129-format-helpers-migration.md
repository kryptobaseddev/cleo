---
"@cleocode/cleo": patch
"@cleocode/core": minor
---

refactor(T10129): migrate format-helpers (kvBlock, dataTable, truncated) from packages/cleo → packages/core/render (B4)

Pure structural move — zero behavior change. Resolves AGENTS.md Package-Boundary Check violation: rendering logic belongs in `packages/core/`, not in the CLI thin shell. All callers updated to import from `@cleocode/core`.

Closes T10129. Epic: T10114. ADR: adr-077-human-render-contract.
