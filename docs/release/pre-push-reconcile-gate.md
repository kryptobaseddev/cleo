# Pre-Push Reconcile Gate (T1595)

This document describes the pre-push reconcile gate that closes the
drift-recurrence pattern that left T1408–T1413 shipped-but-pending in
`tasks.db` even though the release that introduced the invariant
runner had already been tagged.

## Why this exists

`cleo reconcile release --tag <tag>` runs the registered post-release
invariants (e.g. `archive-reason-invariant`, T1411) and reports any
tasks that shipped in the tag's commit range but were never marked
`done` + stamped with `archive_reason='verified'`. Without an
automated gate, operators routinely forgot to run reconcile, so the
drift accumulated silently.

The pre-push hook now runs reconcile in **dry-run** mode against the
most recent tag and **refuses the push** if drift is detected. The
push is only allowed when drift is zero, or when the operator
explicitly bypasses the gate via the `CLEO_ALLOW_DRIFT_PUSH=1`
environment variable (audited).

## Behaviour

| Condition                                            | Result                       |
|------------------------------------------------------|------------------------------|
| `reconcile.reconciled == 0` (no drift)               | push allowed                 |
| `reconcile.reconciled > 0` (drift detected)          | push **refused**, exit 1     |
| `CLEO_ALLOW_DRIFT_PUSH=1`                            | push allowed + audit entry   |
| `cleo` CLI not on PATH (default)                     | warn + allow                 |
| `cleo` CLI not on PATH + `CLEO_RECONCILE_STRICT=1`   | refuse                       |
| Repo has no tags yet                                 | push allowed (nothing to gate)|

The hook reads the pending tag with:

```sh
git tag --sort=-v:refname | head -n 1
```

This is **shape-agnostic** — it works for CalVer (`v2026.4.145`) and
SemVer (`v1.2.3`) alike. Reconcile itself is also project-agnostic;
no version scheme is hardcoded into the hook.

## How to override (with audit consequences)

```sh
CLEO_ALLOW_DRIFT_PUSH=1 git push
```

Every bypass appends a JSONL line to:

```
${XDG_DATA_HOME:-~/.local/share}/cleo/audit/drift-push-bypass.jsonl
```

Example entry:

```json
{"ts":"2026-04-29T12:34:56Z","user":"keaton","repo":"/mnt/projects/cleocode","head":"a1b2c3d","tag":"v2026.4.145","reason":"CLEO_ALLOW_DRIFT_PUSH=1"}
```

`git push --no-verify` also bypasses the gate (it bypasses **all**
pre-push hooks, including the T1588 T-ID validator), so the env-var
override is the preferred path when only the drift gate should be
skipped.

## Configuration knobs

| Env var                  | Default | Effect                                         |
|--------------------------|---------|------------------------------------------------|
| `CLEO_ALLOW_DRIFT_PUSH`  | unset   | `=1` bypasses the gate, writes audit entry     |
| `CLEO_RECONCILE_STRICT`  | unset   | `=1` refuses push when `cleo` CLI is missing   |
| `CLEO_RECONCILE_BIN`     | `cleo`  | Override the `cleo` binary path (testing only) |

## Integration with T1411 reconcile + T1597 release pipeline

- **T1411 (`cleo reconcile release`)** — supplies the invariant runner.
  This hook is purely a consumer; all reconciliation logic lives in
  `packages/core/src/release/invariants/`.
- **T1588 (commit-msg + pre-push hooks)** — owns the unified pre-push
  hook. T1595 plugs in at the sentinel:

  ```sh
  # T1595:reconcile-extension-point
  # Pre-push reconcile gate hooks here (see T1595 worker)
  ```

  Until T1588 lands the unified hook, the T1595 logic lives in
  `packages/cleo/templates/hooks/pre-push.t1595-extension.sh`. When
  T1588 lands, the body of `reconcile_gate()` in the extension file
  is inlined at the sentinel point.
- **T1597 (release pipeline)** — runs reconcile in **enforce** mode
  (not dry-run) as the final post-release step. The pre-push gate is
  the early-warning system that catches pre-tag pushes that would
  ship a release without reconcile having run.

## Files

- Hook extension: `packages/cleo/templates/hooks/pre-push.t1595-extension.sh`
- Tests: `packages/cleo/src/cli/__tests__/pre-push-reconcile.test.ts`
- Reconcile CLI: `packages/cleo/src/cli/commands/reconcile.ts`
- Invariant registry: `packages/core/src/release/invariants/registry.ts`
