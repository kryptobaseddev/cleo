---
id: t14281-measured-charges
tasks: [T14281]
kind: fix
summary: "cleo run charges every command from its own measured peaks (one store, one conservative rule), so a one-package tsc -b planned at 12 GiB is charged about 1 GiB once three runs are measured"
---

Admission used to charge a plain command its whole class plan: a one-package
`tsc -b` was charged 12 GiB and measured 0.8 GB, holding back everything queued
behind it. Every `cleo run` command is now measured, keyed by its project and
argv (a git hook or a script keeps its own key). Once three runs are counted it
is charged the largest of its last ten counted peaks plus 25%, never above the
plan. A run whose peak exceeds that charge resets the count, so the plan
applies again until three more runs are counted. Hooks, scripts and plain
commands share this one rule and one store, `<cleoHome>/run/charges.json`; the
old `admission/hook-footprints.json` is read once, until the first write.

A run's charge no longer falls while it runs (the 60 s warm-up lowering is
gone): it is admitted at its measured charge, and a tree that climbs past it
goes back to the plan. `cleo doctor tool-locks` shows each entry's plan and
the measured charge it holds.
