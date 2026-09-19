---
id: release-installability-verdict
tasks: [T12251]
kind: fix
summary: A release run can no longer report success over a package that does not exist on npm
---

**gh#1474, gh#1416, gh#1479.** v2026.9.6 and v2026.9.7 both concluded `success`
over a package that was not on npm. The pipeline had already measured that
correctly and written it to an artifact —
`{"name":"@cleocode/cleo","verified":false,"reason":"metadata 404"}`,
`"failed": 1` — and one line of YAML discarded it.

`continue-on-error: true` was there for a real reason: *a transient propagation
delay must never roll back a good publish*. But nothing in that job **can** roll
anything back. By the time it runs, the tag, the Release and all 18 publishes
are irreversible, and the workflow triggers on tag push, so a red gates no merge
and blocks no required check. The mask bought nothing.

**The split.** A run conclusion is stamped once and never revised, while
`@cleocode/cleo` has taken 4m55s, 55m11s and 2h55m09s across three consecutive
releases. So the run cannot be the durable answer:

- the **run** answers *"did THIS RUN prove installability inside its budget?"* —
  bounded, permanently true either way;
- a **tracking issue**, updated by a cron watcher and closed on convergence,
  answers *"is this version installable NOW?"*.

**Three outcomes, not two.** `pending` and `defect` previously shared one exit
code and one `ok: false`. The `pending` annotation is the anti-false-alarm
mechanism and says so explicitly: this red means the run did not PROVE
installability, **not** that the release is broken — do not roll back, re-tag,
re-publish or bump. A missing or unparseable verdict is `infra` and fails
closed.

**A third rung nothing was checking.** `npm i -g @cleocode/cleo` resolves
through the packument's `dist-tags` — a third document propagating
independently of the per-version doc and the tarball. The strongest check could
be fully green while the command users type returned the previous version. A
stale tag is `pending`, never `mismatch`: on a `--tag beta` release `latest` is
*supposed* to lag, and that false alarm has its own regression test.

Stated plainly because it would be easy to overclaim: **both incident releases
failed at rung 1 (`metadata 404`), so this rung would have changed nothing
there.** It closes a real hole; it is not the fix for gh#1474.

**Budget 1800000 → 900000, cap 40 → 25.** The old value was derived from a
size→propagation causal claim that is falsified (gh#1478): six releases at a
byte-identical 80.6 MB spanned 4m55s–55m11s, v2026.9.7 cut the package 60% and
took 3.2× longer, and `core` — larger, 7× the files — converged in 3m47s in that
same run. 55m and 2h55m both exceed any workable job cap, so no poll budget fits
inside a job at all. The comment is now policy rather than prediction and
carries a `budget-basis:` line so the next change must restate its evidence.

Also: `publish_pkg` records per-package call/return timestamps (gh#1479) via a
**wrapper**, so no branch can be silently missed — an untagged outcome reads
`UNKNOWN` rather than vanishing. And `execute-payload`'s duplicate `Get version`
step is deleted: it re-derived VERSION with a copy of the release job's shell
that dropped the dist-tag branch entirely.
