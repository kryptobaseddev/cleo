---
id: acceptance-drift-doctor
tasks: [T12157]
kind: feat
summary: "`cleo doctor acceptance-drift` — assert the two acceptance stores agree, on the rule that is actually in force"
---
**gh#1290.** Acceptance criteria live in `tasks_tasks.acceptance_json` (what
`cleo show` reads) and in `tasks_task_acceptance_criteria` (typed rows), with a
projection mechanism between them and nothing asserting they agree.

**The composition rule was stated backwards, and measuring it changes the
answer.** The believed rule was *"the JSON column holds text criteria; the rows
table holds those plus `child_task` projections"* — i.e. `json == text`. But the
JSON column does carry child projections, serialised as text: `T001`'s only JSON
entry is the string `"Complete child T9092: …"`, and 476 tasks carry at least one
such string. Of 582 tasks with child rows, 446 have `json == text + child`.

The convention **changed during May 2026** and has been uniform since:

| month | children IN json | children NOT in json |
|---|---|---|
| 2026-04 | 14 | 66 |
| 2026-05 | 363 | 38 |
| 2026-06+ | 68 | **0** |

Across all tasks created on or after 2026-06-01: **608 tasks, 1 violation**.
Before it: 4,459 tasks, 163 violations. So the live rule is `json == text +
child`, and the pre-June rows are a legacy convention rather than drift.

That reclassifies the two exemptions the issue applied. The 88 tasks "reconciled
by `json == text`" and the 18 "containers in their designed state" are not two
separate designed behaviours — they are **the same pre-June convention**, and
under the rule in force today both are drift. Which leaves exactly one
current-era defect in the whole store: **`T11889`**, an epic whose JSON carries 8
criteria against 4 text + 5 child rows.

`cleo doctor acceptance-drift` derives all of this from the data on every run and
reports four kinds — `json-never-projected` (24), `rows-unreadable` (20),
`legacy-children-omitted` (88), `count-mismatch` (32) — separating legacy-era
rows from current-era regressions so the check is actionable rather than
permanently red. What fails is **baseline membership, not creation date**. Acceptance rows are
written throughout a task's life — reparenting, child completion, an edited
criterion — so drift is introduced by a WRITE while a birthday is fixed forever.
Keying the gate on creation date would exempt every old task from every future
regression: 223 tasks created before the convention settled have been updated
since, so a date-keyed gate is blind to new drift across 4,459 of 5,068 rows,
88% of the store. The per-install baseline (`.cleo/acceptance-drift-baseline.json`,
written by `--update-baseline`) keeps the 163 historical rows quiet while a
pre-June task that drifts tomorrow is a net-add and fails. Creation date is
retained purely as a reporting attribute. `--all` ignores the baseline entirely.

The baseline is per-install rather than committed to this repo: the entries are
task ids from one project's own store, so a repo-committed baseline would bake
cleocode's ids into a CLI that ships to everyone else.

Scope is **cardinality, not content** — measured, not assumed: comparing the
sorted multiset of JSON strings against the row texts where counts already
agree gives 0 content differences across 601 current-era tasks and 1 across
4,053 legacy ones (`T11011`). Named as out of scope rather than left to be
discovered.

**It deliberately does not read `tasks_acceptance_projection_state`**, which is
the surface built to answer exactly this question and which reports `status =
fresh`, `dirty rows = 0` for a projection that has not run since 2026-05-26 —
while the rows it describes kept being written by a different, inline path. A
freshness marker that is written rather than derived is a claim, not a
measurement (ADR-092).

Read-only: it reports and repairs nothing. Deciding which side wins for the 164
existing rows is a separate question and deliberately left open.

Unit tests pin **both** previously-believed rules as explicit counter-examples,
so a silent reversion to `json == text` fails rather than quietly re-reporting 88
tasks as healthy.
