---
id: docs-plans-group-modernize
tasks: [T14108]
kind: docs
summary: "docs/plans folded into docs/plan: competing master plans merged into the north star, finished plans and decomposition dumps kept in the store only"
---

T14108 group 2: `cleo docs modernize` (run dm-20261104-235012-59d04d) merged
four competing master plans into the canonical north star and the STDP
feasibility note into the STDP wire-up spec, moved the brain synaptic
visualization research to `docs/research/`, and removed 28 finished plans,
blueprints, decomposition dumps and dated working files whose content stays
in the docs store under its own slug (no supersession). Code comments and
hints that named the old paths now cite `cleo docs fetch <slug>` or the new
path, and the docs-name baseline drops 28 entries.
