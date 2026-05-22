---
"@cleocode/cleo": minor
"@cleocode/core": minor
---

feat(T9985): packages/cleo is dispatch-only (E8-CLI-LAYERING)

Migrates SDK business logic from packages/cleo to packages/core per the
AGENTS.md Package-Boundary Check. Verifies dispatch/domains/worktree.ts
is pure router by re-exporting destroyWorktree through core. Drops
@cleocode/cleo's direct dependency on @cleocode/worktree — the funnel
is now cleo → core → worktree exactly as the layering contract requires.

Migrations in this PR:
- backup-inspect tar/manifest helpers (extractManifestFromTar,
  verifyManifestHash, detectEncryption, fmtBytes) → core/store/backup-inspect.ts
- restore-conflicts.md parser (parseConflictReport, parseMarkdownValue,
  setAtPath, RESTORE_VALID_JSON_FILENAMES) → core/store/restore-conflict-parser.ts
- setup wizard --config-json merger (mergeConfigJson, WIZARD_SECTION_IDS)
  → core/setup/config-json-merge.ts

lint-cli-package-boundary baseline: 28 → 25 (-3 violations).
lint-core-first baseline: unchanged at 87 — new SDK primitives are
re-exported through @cleocode/core (public barrel) so CLI commands
import them without violating RULE-3.

Closes T10040-T10044.
Saga: T9977
Decision: D010
