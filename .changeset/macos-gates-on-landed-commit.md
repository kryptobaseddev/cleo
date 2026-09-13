---
id: macos-gates-on-landed-commit
tasks: [T12177]
kind: fix
summary: macOS unit tests gate on the commit that lands, not on every PR push — the coverage was real but aimed at a commit `strict` guaranteed to discard
---

**gh#1359.** macOS was 49% of CI cost and 100% of the PR critical path, and it
validated a commit that could never become main.

Measured on a green PR run (`34760144636`, 52 jobs, 8,290 job-seconds):

```
33.0 min  Unit Tests (macos-latest, shard 1)   <- the ENTIRE critical path
27.7 min  Unit Tests (macos-latest, shard 2)
18.6 min  Unit Tests (ubuntu-latest, shard 2)
18.0 min  Unit Tests (ubuntu-latest, shard 1)
```

Every other job finishes *inside* macOS shard 1. With
`required_status_checks.strict: true`, the commit macOS certified is guaranteed
to be invalidated by the next merge to main. The coverage was genuine; the
commit it covered was never the one that shipped.

macOS now runs on `push` to `main` and on `merge_group` — the commit that
actually landed. The tradeoff is stated rather than hidden: a macOS-only
regression now reaches main before detection instead of blocking the PR, and is
caught on the very next push run against the exact commit that introduced it.

**The merge-queue arm is deliberate and currently dead.** Merge queue requires
an organization-owned repository; this one is personal. Verified by a controlled
pair against `POST /rulesets`, same endpoint and conditions:

```
{"type":"merge_queue"}  -> 422 Invalid rule 'merge_queue'
{"type":"deletion"}     -> 201 Created
```

Keeping the arm means macOS becomes a pre-merge gate again by enabling the
queue, with no change to `ci.yml`. An earlier draft gated on `merge_group`
*alone*, which — with no queue to fire it — would have meant macOS never ran at
all. Gating on an event that cannot fire is indistinguishable from deleting the
job.

Also pins `dorny/paths-filter`'s `base:` for `merge_group`. A merge-queue ref is
neither a push nor a pull_request, so the event supplies no diff point and the
answer would come from the action's default rather than from `ci.yml`. Had that
resolved to "no code changed", `unit-tests` would be **skipped** — and the `ci`
aggregator accepts `skipped` as a pass. A queue batch would merge with no test
run and report green.

**Measured effect, not predicted.** Freeing the macOS pool collapsed the NAPI
prebuild's runner wait, which had been starving on the same runner pool:

```
before  darwin-arm64  queue=52.6 min  run=1.8 min   (total run 54.5 min)
after   darwin-arm64  queue= 0.1 min  run=2.1 min   (total run  3.2 min)
```

Every prebuild target had always *built* in 1-3 minutes; the 12.6-71.5 min
spread across six runs was entirely macOS queueing. CI's `worktree-napi-gate`
carries `timeout-minutes: 15`, so in four of those six runs it could not
possibly have waited long enough — and a gate timeout records as `cancelled`,
which the `ci` aggregator counts as a failure.
