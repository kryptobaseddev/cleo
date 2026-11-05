---
id: docs-concept-group-modernize
tasks: [T14108]
kind: docs
summary: "docs/concepts, docs/architecture and docs/design folded into docs/concept with slug names; cleo check canon and detect-drift read the moved docs"
---

T14108 group 3: `cleo docs modernize` (run dm-20261105-003225-b590ae) moved
the concepts, architecture and design folders into `docs/concept/` with slug
file names, merged the three pre-cleo.db per-database ERDs into
`database-erds` and the duplicate memory architecture doc into the memory
architecture spec, retired the raw task-system text dump in favour of the
tasks API spec, and re-pointed 10 inbound links, including the root README
and the cleo-os README. `cleo check canon` and `cleo detect-drift` read the
architecture guide and vision doc through constants in
`packages/cleo/src/cli/paths.ts`, and the ADR-044 story exclusions use the new
file names. Comments, the skills-council workflow note and a shared skill
reference cite the new paths; the docs-name baseline drops 19 entries.
