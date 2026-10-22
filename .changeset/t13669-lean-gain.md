---
id: t13669-lean-gain
tasks: [T13669]
kind: feat
summary: "`cleo lean gain`: the measured ct-lean scoreboard, benchmark averages only"
---

`cleo lean gain` mirrors Ponytail 5.1.0's `/ponytail-gain` (MIT). It shows the
T13424 benchmark measurements (research doc
`t13424-ct-lean-vs-ponytail-benchmark`) for source lines, output tokens, cost
and wall time, each as ct-lean's share of the no-skill baseline, next to
Ponytail's share. It also shows hidden-check pass counts for all three arms.

It prints a LAFS envelope by default, or text bars with `--card`.

The honesty boundary carries over: these are benchmark averages, never a
per-repo savings number. The card points to `cleo lean debt` for figures
counted in the repo.
