---
"@cleocode/cleo": minor
---

feat(T10103): release verb matrix + remove ship verb + ship-e2e-smoke

Adds docs/release/verb-matrix.md mapping every release state transition
to its owning verb. Removes the deprecated cleo release ship shim
(post-T9540 follow-up — the migration window closed). Adds new
cleo release ship-e2e-smoke one-shot walker that walks plan → open →
wait-for-PR → wait-for-tag → verify-npm-published (dry-run by default,
--execute to run for real).

Side-effects:
- Adds the SSoT defineCommand factory at packages/cleo/src/cli/lib/
  define-cli-command.ts (long-pending T10072 enablement). The new
  ship-e2e-smoke command is the first consumer.
- Updates ct-release-orchestrator SKILL.md to match the post-cleanup
  verb surface.
- Updates AGENTS.md Release section.
- Updates user-facing fix strings in core that still recommended the
  deleted `cleo release ship` verb.

Saga: T10099
Closes: T10103
