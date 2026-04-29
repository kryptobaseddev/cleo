# ADR-063: Canonical Release Pipeline

- **Status**: Accepted
- **Date**: 2026-04-29
- **Task**: T1597 (Foundation Wave A — Worker 7)
- **Supersedes**: Ad-hoc release process (mid-flight CHANGELOG fixes,
  multi-run GitHub workflows, optional reconcile, hard-coded `npm publish`)

## Context

CLEO releases were shipping through an ad-hoc sequence: edit CHANGELOG, run
`pnpm build`, push tag, hope the GitHub workflow goes green, occasionally
remember to run `cleo reconcile release --tag <…>` afterward. v2026.4.154
shipped only after three workflow runs, a mid-flight CHANGELOG fix, and
`reconcile` was never executed against its own tag — perfect proof that the
process was not codified anywhere CLEO could enforce.

We already had every primitive needed:

- Per-gate evidence collection via ADR-051 / ADR-061 (`tool:test`,
  `tool:lint`, `tool:typecheck`, `tool:audit`, `tool:security-scan`).
- Post-release invariants registry (ADR-056 D5 / T1411) that auto-completes
  shipped tasks and creates follow-ups.
- Project-context-driven tool resolution (ADR-061) so commands aren't
  hard-coded to `npm`/`pnpm`.

What was missing: a **canonical entry point** that strings these together
in a deterministic order, persists state between steps, and refuses to skip
the reconcile.

## Decision

Adopt a 4-step canonical pipeline as the only supported release flow:

```
cleo release start <version>     # Step 1 — validate, capture, persist handle
cleo release verify              # Step 2 — gates + child-task audit
cleo release publish             # Step 3 — invoke project-context publish.command
cleo release reconcile           # Step 4 — run invariants, auto-complete tasks
```

### Pipeline contract

1. **`releaseStart(version, opts)`**

   - Validates `version` against the active scheme from
     `.cleo/project-context.json` (`version.scheme`: `calver` / `semver` /
     `sha` / `auto`).
   - Captures the release branch from `git rev-parse --abbrev-ref HEAD`
     (never hard-coded to `main`).
   - Persists a `ReleaseHandle` to `.cleo/release/handle.json` so
     subsequent steps can resume without re-passing `--version`.

2. **`releaseVerify(handle, opts)`**

   - Runs the canonical gates: `test`, `lint`, `typecheck`, `audit`,
     `security-scan` — each resolved via the ADR-061 alias map.
   - When `handle.epicId` is set, audits every child task for green
     gate state (using the same evidence atoms `cleo verify` writes).
   - Returns `passed: true` only when both axes are clean.

3. **`releasePublish(handle, opts)`**

   - Reads `publish.command` from `.cleo/project-context.json`.
   - Falls back to `primaryType`-specific defaults
     (`node` → `npm publish`, `rust` → `cargo publish`,
     `python` → `twine upload dist/*`, `go` → `goreleaser release`,
     `ruby` → `gem push`).
   - Honors `--dry-run`.
   - **No hard-coded `npm publish`.**

4. **`releaseReconcile(handle, opts)`**

   - Delegates to `runInvariants(handle.tag, …)` (ADR-056 D5 / T1411).
   - Aggregates `details.reconciled[]` and `details.unreconciled[]` into
     `reconciledTasks[]` / `unreconciledTasks[]`.
   - Clears the persisted handle on success — ending the pipeline.

### Type surface

All shared types live in `packages/contracts/src/release/pipeline.ts`:

- `ReleaseHandle`
- `ReleaseGateStatus`
- `VerifyResult`
- `PublishResult`
- `ReleaseReconcileResult` (renamed to avoid colliding with the existing
  `task-sync` `ReconcileResult`)
- `ReleaseVersionScheme`

### Project-agnostic invariants

| Concern         | Resolution                                                       |
|-----------------|------------------------------------------------------------------|
| Publish command | `publish.command` in project-context, then `primaryType` fallback |
| Version scheme  | `version.scheme` in project-context (`calver`/`semver`/`sha`/`auto`) |
| Branch          | `git rev-parse --abbrev-ref HEAD` (never `main`)                  |
| Test runner     | ADR-061 `tool:test` alias map                                    |
| Lint / typecheck| ADR-061 `tool:lint` / `tool:typecheck` alias map                 |
| Tag prefix      | First char `v` only when missing — schemes do not impose prefix  |

## Consequences

### Positive

- **Reconcile cannot be forgotten** — it is step 4 of a single command
  sequence, not an optional follow-up.
- **Mid-flight CHANGELOG fixes are surfaced as `releaseVerify` failures**
  instead of silently rolling forward.
- **Provider-agnostic** — same pipeline works for the cleocode monorepo
  (npm), Rust crates (`cargo publish`), Python wheels, and Go modules.
- **Testable** — `releaseVerify` accepts injected `runGate` and
  `auditChildren` functions so unit tests don't need a live tool runner or
  tasks DB.
- **Backward-compatible** — `cleo release ship` is preserved verbatim. The
  new subcommands (`start` / `verify` / `publish` / `reconcile`) are
  additive.

### Negative / Trade-offs

- A second handle file (`.cleo/release/handle.json`) is now part of the
  release lifecycle. It is gitignored implicitly by the existing
  `.cleo/` rules and cleared by step 4.
- Default gate runner is intentionally a no-op stub — production callers
  must inject `runGate` (CLI does this) or the verify reports
  `passed: false` with `"runner not configured"`. This is by design: the
  tool runner lives in `@cleocode/cleo` and importing it from `core`
  would create a dependency cycle.

### Migration

- No breaking changes. Operators continue using `cleo release ship` until
  they are ready to opt into the canonical pipeline.
- Future work (out of scope for T1597): wire `release.ship` to internally
  call the four steps so a single command remains available, but with the
  new evidence-anchored guarantees underneath.

## References

- T1597 — Foundation lockdown wave A worker 7
- ADR-051 — Evidence-based gate ritual
- ADR-056 D5 — Post-release invariants registry
- ADR-061 — Project-agnostic tool resolution
- T1411 — `cleo reconcile release --tag <…>`
