# T1597 — Foundation Worker 7 — Canonical Release Pipeline

**Mission**: Standardize `cleo release start → verify → publish → reconcile` as the
project-agnostic canonical release flow. Resolves the v2026.4.154 "ad-hoc release,
forgot reconcile" failure mode by making reconcile step 4 of a single sequence.

## New / Modified Files

| File | LOC | Status |
|---|---:|---|
| `packages/contracts/src/release/pipeline.ts` | 100 | **new** — type contracts |
| `packages/contracts/src/index.ts` | +9 | extended — exports release types |
| `packages/core/src/release/pipeline.ts` | 478 | **new** — pipeline domain |
| `packages/core/src/release/index.ts` | +14 | extended — barrel re-exports |
| `packages/core/src/release/__tests__/pipeline.test.ts` | 419 | **new** — 19 test cases |
| `packages/cleo/src/cli/commands/release.ts` | +63 | extended — 4 thin shims |
| `docs/adr/ADR-063-release-pipeline.md` | 144 | **new** — accepted ADR |

## ADR

`/mnt/projects/cleocode/docs/adr/ADR-063-release-pipeline.md` — Status: Accepted (2026-04-29).
Supersedes the ad-hoc release process; canonicalizes the 4-step flow.

## Test Results

- `pnpm --filter @cleocode/core exec vitest run src/release/__tests__/pipeline.test.ts`
  → **19 passed / 19** (~640ms)
- `pnpm --filter @cleocode/core exec vitest run src/release/`
  → **93 passed / 93** across all 8 release test files (no regressions)
- `pnpm biome check` on all changed files → **clean, no fixes applied**
- `pnpm --filter @cleocode/contracts run build` → green
- `pnpm --filter @cleocode/core run build` → green for the pipeline file
  (an unrelated `src/sentient/tick.ts` import in another worker's working tree
  surfaces a TS6192 — pre-existing, NOT in my scope)
- `pnpm --filter @cleocode/cleo run build` → green (CLI shims compile + shebang check passes)

## Project-Context Dependencies

The pipeline reads ONLY these keys from `.cleo/project-context.json`:

| Key | Purpose | Fallback |
|---|---|---|
| `publish.command` | Step 3 publish invocation | `primaryType` lookup |
| `version.scheme` | Step 1 version validation (`calver`/`semver`/`sha`/`auto`) | `auto` |
| `primaryType` | Per-language publish-command default | `node` (→ `npm publish`) |

`primaryType` fallbacks: `node`→`npm publish`, `rust`→`cargo publish`,
`python`→`twine upload dist/*`, `go`→`goreleaser release`, `ruby`→`gem push`.

## Project-Agnostic Verification

- ✅ NO hardcoded `npm publish` — `defaultPublishCommandFor()` switches per `primaryType`.
- ✅ NO hardcoded `main` branch — `detectBranch()` uses
  `git rev-parse --abbrev-ref HEAD`, falls back to `HEAD` if git missing.
- ✅ Version scheme respects `.cleo/project-context.json` — calver/semver/sha all
  enforced by `validateVersion()` with explicit rejection messages.
- ✅ Test fixtures cover node, rust, python primaryTypes. Tests for cargo and
  npm both pass with their respective command resolution paths.
- ✅ Quality gate names match ADR-061 canonical aliases: `test`, `lint`,
  `typecheck`, `audit`, `security-scan`.
- ✅ All shared types live in `@cleocode/contracts` (`PublishResult`,
  `ReleaseHandle`, `ReleaseGateStatus`, `VerifyResult`, `ReleaseReconcileResult`,
  `ReleaseVersionScheme`).
- ✅ CLI shims average 8 LOC each (just dispatch to `release.releaseStart` etc.).

## Pipeline Surface

```
cleo release start <version> [--epic T###] [--branch <name>]
cleo release verify
cleo release publish [--dry-run]
cleo release reconcile [--dry-run]
```

State is persisted between steps at `.cleo/release/handle.json` and cleared on
successful reconcile. Existing `cleo release ship`, `list`, `show`, `cancel`,
`changelog`, `rollback`, `rollback-full`, `channel` are preserved verbatim
(additive, not replacing).
