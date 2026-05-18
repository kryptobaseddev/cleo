# Release-pipeline integration tests (T9543)

12 Vitest integration scenarios that exercise the release pipeline against
the 3 archetype fixtures landed in T9542. Each scenario maps to one or more
forensics failure modes (`F1-F10`) and acceptance criteria from
`SPEC-T9345-release-pipeline-v2.md`.

## Source of truth

- `.cleo/rcasd/T9345/research/test-matrix-T9345.md` §2 (scenarios)
- `.cleo/rcasd/T9345/research/failure-forensics-10-modes.md` (F1-F10)
- `packages/cleo/test/fixtures/release-test-*/` (T9542 fixtures)
- `packages/contracts/src/release/plan.ts` (`ReleasePlanSchema`, T9527)

## Scenario × forensics × archetype matrix

| #   | Scenario                       | Forensics  | monorepo | npm-lib | rust-crate |
| --- | ------------------------------ | ---------- | -------- | ------- | ---------- |
| S1  | happy path                     | —          | yes      | yes     | yes        |
| S2  | wedged-git recovery            | F1         | yes      | yes     | yes        |
| S3  | epic scope confined            | F2         | yes      | yes     | yes        |
| S4  | gate runners execute           | F3, F4     | yes      | yes     | yes        |
| S5  | tag on merge SHA               | F6         | yes      | yes     | yes        |
| S6  | hotfix bypass                  | F2 (hotfix)| yes      | yes     | yes        |
| S7  | resume after CI fail           | F8         | yes      | yes     | yes        |
| S8  | provenance populated           | audit Q4   | yes      | yes     | yes        |
| S9  | orphan detect                  | —          | yes      | yes     | yes        |
| S10 | rollback clean (no force-push) | —          | yes      | yes     | yes        |
| S11 | npm-lib ships                  | —          | n/a      | yes     | n/a        |
| S12 | rust-crate ships               | —          | n/a      | n/a     | yes        |

S11/S12 are archetype-specific by design — they validate that the pipeline
works against a non-monorepo project type. S1-S10 cover the full set.

## Forensics failure-mode legend

| Mode | Symptom (source: failure-forensics-10-modes.md)                                                 |
| ---- | ----------------------------------------------------------------------------------------------- |
| F1   | Wedged git commit — no child-process timeout, pipeline hangs indefinitely                       |
| F2   | Epic completeness scope leak — `--epic A` fails on unrelated epic B's children                  |
| F3   | Gate runners not wired — gate marked `passed` without invoking the tool                         |
| F4   | Gate `status` field unconditionally set to `passed` regardless of exit code                     |
| F5   | (covered by adjacent scenarios)                                                                 |
| F6   | Tag created against the release branch tip rather than the merge commit SHA                     |
| F7   | (covered by adjacent scenarios)                                                                 |
| F8   | No idempotent resume from durable checkpoints — partial state requires manual cleanup           |
| F9   | (covered by adjacent scenarios)                                                                 |
| F10  | (covered by adjacent scenarios)                                                                 |

Modes F5/F7/F9/F10 are touched indirectly by the scenarios above — see
the parent test-matrix file for the verbatim reproduction recipes.

## Helpers

| File                          | Exports                                                                  |
| ----------------------------- | ------------------------------------------------------------------------ |
| `_helpers/synthetic-release.ts` | `createSyntheticRelease`, `writePlanFile`, `fixturePathFor`              |
| `_helpers/mock-gh.ts`           | `installGhMock`, `mockGhPrView`, `mockGhReleaseView`, `mockGhCommand`   |
| `_helpers/fixture-runner.ts`    | `runPlanForFixture`, `runReconcileForFixture`, `hasReleasePlanImpl`     |

The helpers are intentionally minimal — they consume the T9542 fixtures
verbatim and emit `ReleasePlan`-shaped envelopes validated against
`@cleocode/contracts`.

## Real-verb gating

The plan (T9525) and reconcile (T9526) verbs are landing in parallel with
this PR. Tests that genuinely depend on the real verb implementation are
wrapped in `it.skipIf(!hasReleasePlanImpl)` / `it.skipIf(!hasReleaseReconcileImpl)`
so they auto-activate the moment those tasks merge to `main`.

This PR is the **scaffold** — fixtures consumed, helpers wired, mapping
table accurate, all 12 scenarios laid out. Real integration assertions are
a follow-up triggered automatically by T9525 / T9526 landing.

## Running

```bash
# From the monorepo root:
pnpm --filter @cleocode/cleo run test --run packages/cleo/test/integration/release-pipeline/

# Single scenario:
pnpm --filter @cleocode/cleo run test --run packages/cleo/test/integration/release-pipeline/S1-happy-path.test.ts
```

Tests do not make real network calls. The `gh` CLI is mocked via vitest's
`spyOn(child_process, 'execFileSync')`. Git invocations against the
synthetic tmp repo use real git but with a hard 5s timeout to guarantee the
test runner never wedges (the F1 failure mode being defended against).
