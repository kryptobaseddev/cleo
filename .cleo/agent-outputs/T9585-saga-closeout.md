# Saga T9585 — Closeout Manifest

**Status:** All work merged to `main`. Release v2026.5.81 cut and tagged.
**Pending HITL:** npm publish (`pnpm -r publish --access public`) — requires owner credentials.

## Saga structure delivered

```
SG-T9585 — Worktree-aware verify + setup-v2 + CORE-first arch unification
├── E-T9586 — Worktree IVTR (getEffectiveHead + verify) — DELIVERED
├── E-T9587 — Audit V2 fixes — DELIVERED
├── E-T9591 — CLEO setup-v2 (progressive wizard) — DELIVERED
└── E-T9592 — CORE-first architecture enforcement — DELIVERED
```

## Tag & main state

- **Tag:** `v2026.5.81` on commit `572630ee6`
- **Tag:** `v2026.5.80` on commit before (also merged to main)
- **Open PRs:** 0

## Final release path used

Per owner directive — `cleo release` commands not used. Manual git only:
1. Worker worktrees → `git worktree add -B task/T#### …`
2. Push → `gh pr create`
3. Merge sweep → `gh pr merge --merge --delete-branch`
4. `release/v2026.5.81` cut from main with version bumps + CHANGELOG
5. PR → green CI → merge
6. `git tag v2026.5.81 && git push origin v2026.5.81`

## What shipped under each epic

### E-T9586 (Worktree IVTR)
- `packages/core/src/worktree/effective-head.ts` — new primitive
- `packages/core/src/tasks/evidence.ts` — wired `getEffectiveHead` + `resolveCanonicalProjectRoot`
- `validateCommit` now uses task-branch HEAD when worktree active
- spawn-verify E2E regression test
- ADR-051 addendum

### E-T9587 (Audit V2)
- `cleo update --relates` writer fix
- Project-root normalization across CLI/dispatch (T9582)
- gh-cli-seeder removed from BUILTIN_SEEDERS (T9594)
- `cleo auth consent` command (T9598)

### E-T9591 (Setup V2)
- `WizardSection` union extended (integrations + verification — 8 sections)
- `WizardInterruptError` / `StdinClosedError`
- Bracketed-paste sanitization
- Skip logic + first-run marker + progress prefix
- Studio `/setup` API parity

### E-T9592 (CORE-first arch)
- `packages/core/src/memory/public-api.ts` — 9 functions promoted
- `packages/core/src/agents/public-api.ts` — 4 functions promoted
- Studio routes migrated off raw `.prepare()`
- CLI commands (memory, agent, brain, sentient, doctor, backup, restore) migrated off `/internal`
- `scripts/lint-core-first.mjs` CI gate
- `docs/api/CORE-API-AGENT-GUIDE.md`

## Worker count

- 36+ PRs merged across the session
- Every worker used a git worktree (`~/.local/share/cleo/worktrees/cleocode/T####/` or `/tmp/work-T####`)
- Zero direct pushes to `main`

## Pending HITL: npm publish

Owner must run from main:
```bash
cd /mnt/projects/cleocode
npm login            # if token expired
pnpm -r publish --access public --no-git-checks
```

This publishes all 20+ `@cleocode/*` packages at version `2026.5.81`.
Currently npm `latest` is at `2026.5.79` (v2026.5.80 also un-published).

## Files modified in this session (top-level summary)

```
packages/core/src/worktree/      (new package barrel)
packages/core/src/tasks/         (evidence.ts overhaul)
packages/core/src/setup/         (wizard runner + sections)
packages/core/src/memory/        (public-api.ts)
packages/core/src/agents/        (public-api.ts)
packages/cleo/src/cli/           (consent, setup, memory, agent migrations)
packages/studio/src/routes/api/  (CORE migration)
scripts/lint-core-first.mjs      (CI gate)
.cleo/adrs/ADR-051-…             (addendum)
.cleo/adrs/ADR-073-…             (hierarchy charter as SSoT)
docs/plans/E-WORKTREE-IVTR.md    (epic spec)
docs/plans/E-AUDIT-V2-FIXES.md
docs/plans/E-CLEO-SETUP-V2.md
docs/plans/E-CORE-FIRST-ARCH.md
docs/api/CORE-API-AGENT-GUIDE.md
CHANGELOG.md                     (v2026.5.80 + v2026.5.81 entries)
```
