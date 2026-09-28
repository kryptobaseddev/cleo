---
id: agents-md-gate-table-trim
tasks: [T12579]
kind: docs
summary: "AGENTS.md gate table cut to one-line rules; per-gate rationale moved to the `arch-gates-rationale` spec"
---
AGENTS.md is loaded into every agent session in this repo. The architectural
gate table carried multi-paragraph incident rationale per row. Each row now
holds one line of rule, and the full original text lives in the canonical spec
`arch-gates-rationale` (`cleo docs fetch arch-gates-rationale`, git mirror
`docs/spec/arch-gates-rationale.md`), keyed by gate number and script path.
Surrounding prose that repeated CLEO-INJECTION.md or recorded incident history
was condensed; its verbatim original is in the spec's appendix.

AGENTS.md drops from 10,076 to 6,275 cl100k tokens. `lint-arch-gate-parity`
still joins on script path and reports 27 == 27.
