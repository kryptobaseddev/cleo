---
id: docs-guide-reference-group-modernize
tasks: [T14108]
kind: docs
summary: "guides, examples, owner-ci, api, cli-reference, registry, skills and release how-tos folded into docs/guide, docs/reference and docs/spec"
---

T14108 group 4: `cleo docs modernize` (run dm-20261105-010011-5f5548) moved
the loose how-to, reference and contract folders into `docs/guide/`,
`docs/reference/` and `docs/spec/` with slug names, merged the
branch-protection evidence and verification notes into the setup guide, the
workflow inventory into the job inventory and the task-system hardening notes
into the tasks API spec, and dropped the hand-written `cli-reference/deps.md`
(`cleo deps --help` is the SSoT). The invariants page renderer and its CI
check now use `docs/reference/invariants.md`. `docs/skills/` stays the
owner-CI output folder for grade and council reports and the telemetry
aggregate. Ten skills, AGENTS.md, workflow comments and code comments cite the
new paths; the docs-name baseline drops 8 entries.
