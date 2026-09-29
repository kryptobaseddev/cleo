---
id: slim-show-and-orientation-coverage
tasks: [T12523, T12522]
kind: feat
summary: "cleo show withholds acceptance-row UUIDs by default; briefing and focus emit knowledge coverage once"
---
Token economy (epic T12484) on the two most-called read surfaces.

- **`cleo show` (T12523).** The default (MVI) projection keeps each acceptance
  row's `alias` (AC1..n), `ordinal` and `text`, and withholds its UUID `id`.
  The omission is stated once on the result, as
  `_withheld: {"acRows/*/id": <bytes>}`, rather than as a marker on every row.
  `--full` and `--field /data/acRows/<i>/id` still return the UUIDs. The
  `list/*/field` key is added to the projection-marker rule in
  CLEO-REFERENCE.md and ct-cleo.
- **briefing / focus (T12522).** `knowledgeHealth` no longer repeats the
  coverage object. It carries `coverageRef`, a pointer to the one copy:
  `/knowledgeCoverage` in `cleo briefing`, `/coverage` in `cleo focus`.
  The contract type is `KnowledgeHealthSummary`. `cleo doctor knowledge` still
  returns the full assessment.
