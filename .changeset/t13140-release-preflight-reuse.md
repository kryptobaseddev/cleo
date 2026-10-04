---
id: t13140-release-preflight-reuse
tasks: [T13140, T13050]
kind: fix
summary: cleo release open reuses main's tested CI run for the release commit, and --no-commit-plan dispatches the merged plan by hash
---

`release-prepare` re-ran the whole Linux suite (15–19 min) and macOS suite (32–42 min) on every
release, for a tree main's CI had already tested. There were two reasons:

- **The release commit never carries a tested run.** It is the merge of the release-plan PR (the
  plan file, `CHANGELOG.md`, `.changeset/` moves). Main's push CI for it is green, but its
  `Detect Changes` gate skips every `Unit Tests` shard, so `cleo release open` never granted the
  skip. It now walks first parents from main's HEAD. It steps only past push runs that are green,
  whose `Detect Changes` job succeeded, and whose every `Unit Tests` job was skipped, which is CI's
  own judgment that the push changed nothing the tests read. A step is taken only past a
  release-plan commit: every file it changes is under `.cleo/release/` or `.changeset/`, or is a
  `CHANGELOG.md`, so the walk never relies on the changes gate being complete. The walk stops at the
  nearest commit whose push run ran every Linux shard green, at most 10 steps back, and every check
  together gets 60 seconds. The skip is forwarded with `verified-sha` set to main's HEAD, and the
  reason names the tested commit and the commits stepped past.
- **macOS:** the newest completed run with macOS jobs of any commit on the walk decides, whether it
  is a nightly or a main-push run. A newer failure outranks an older pass. Any doubt still runs the
  tests.
- **CI's `code` filter** now includes `.cleo/adrs/**`, `.cleo/cant/**` and `.cleo/deprecations*`.
  Unit tests read those files, so a push that changes only them runs the unit tests.
- **`--no-commit-plan` could not dispatch (T13050).** After a release-plan PR merged, `cleo release
  open --no-commit-plan` sent no `plan-blob-sha256`, so the workflow tried to regenerate the plan on
  the runner and failed ("No release scope supplied"). v2026.10.3 was therefore dispatched by hand,
  which dropped the skip inputs. It now verifies the plan on the default branch and forwards its
  sha256. When this checkout lacks the plan file, it reads the copy on the default branch. When the
  plan is not on the default branch yet, or differs from the local copy, it refuses before
  dispatching.
