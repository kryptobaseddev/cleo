---
id: t9797-real-world-validation
tasks: [T9797]
kind: feat
summary: Saga T9787 closing Epic — 9-step E2E real-world validation + agent-accountability harness (canon-lint).
---

The closing Epic of Saga T9787 (SG-DOCS-CANON-CLOSURE). Three deliverables:

1. **9-step E2E validation script** (`scripts/saga-T9787-e2e-validation.mjs`):
   exercises the LIVE docs SSoT on cleocode itself — fetch ADR by slug, list
   by type without `--project` (T9792), search by similarity, `cleo docs add`
   with slug validation, `publish-pr` surface check, drift detection via
   `cleo docs status`, the canon-docs CI gate's negative path against an
   isolated git repo (NO mutation of the live worktree), and duplicate-slug
   detection returning `E_SLUG_TAKEN` with 3 alternative suggestions. The
   transcript is ingested into the SSoT as
   `sg-docs-canon-closure-dogfood-meta-<ts>` — the meta-circular evidence
   atom that closes the saga.

2. **Agent-accountability harness**
   (`packages/core/src/session/canon-lint.ts`): SDK function that walks a
   Claude Code-style `*.jsonl` transcript for `Write`/`Edit`/`MultiEdit`
   tool calls writing to canonical doc paths flagged by `.cleo/canon.yml`
   (T9796). Surfaced as `cleo session lint --transcript <path>` returning
   a LAFS violation envelope. The deferred-detection complement to T9796's
   PR-time CI gate.

3. **Multi-agent race test**
   (`packages/cleo/src/cli/__tests__/saga-T9787-multi-agent-race.test.ts`):
   spawns two parallel `cleo docs fetch` processes against the same ADR
   slug, asserts both return identical sha256 bytes within overlapping
   wall-clock windows, no SQLite_BUSY noise.

4. **Saga closure report generator**
   (`scripts/saga-T9787-closure-report.mjs`): builds a per-Epic summary
   from `cleo saga rollup` + `cleo show` + `git log` + `gh pr list`, then
   ingests it as `sg-docs-canon-closure-report` (slug-fetchable).

Closes T9797. Closes Saga T9787 (10/10 epics shipped — T9788–T9797).
