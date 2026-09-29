---
id: t12495-system-one-bench
tasks: [T12495]
kind: feat
summary: cleo decide bench — System One accuracy benchmark on CLEO's own history, with owner spot-check and a hard spend cap
---

`cleo decide bench` compares System One providers (for example layahost and a
Jev-compatible host) against each decision site's heuristic, using this
project's own records as the control group:

- **duplicateDetection**: task pairs labelled duplicate from `duplicates`
  relations, tasks cancelled as a duplicate of a named task, and duplicate
  notes; distinct pairs are same-parent tasks with no relation.
- **observationType**: observations whose stored type differs from both
  keyword defaults, so a caller must have set it.
- **decisionContradiction**: supersedes edges as conflicts, random unlinked
  pairs as compatible.

The dataset is read through the task and brain accessors, redacted with the
System One redaction, and written as JSONL with per-row provenance.
`--sample-only` builds it and a stratified ~30-item spot-check file without
contacting any provider; `--corrections <file>` applies the owner's answers
and marks those rows owner-verified.

A run sends every row to every profile with the provider cache off and a
deadline of at least 30 s, and reports n, accuracy, precision, recall, F1,
false-positive rate, p50/p95 latency, cost and fallbacks per provider and
site, as mean and spread over `--runs`. `--max-usd` (default 5) is a hard
total cap checked before every batch; the run stops cleanly at it, and the
spend is also recorded in the monthly ledger. Output: `results.json` and a
Markdown `report.md` fragment.

Profiles resolve from `CLEO_DECIDE_PROFILE_<NAME>_KEY` (plus `_URL`, `_MODEL`,
`_PROVIDER`) or the stored provider kind until named profiles (T12733) land.
