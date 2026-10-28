---
id: docs-sop-canon-consistency
tasks: [T14108]
kind: docs
summary: "the docs SOP, AGENTS.md routing prose and the legacy-import guide now agree with canon.yml and the T14107 naming rule; the false docs/adr/ARCHIVED.md is removed"
---

The written docs rules contradicted `.cleo/canon.yml`, as problem 1 of the
docs census (`cleo docs fetch docs-census`) found:

- `docs/CLEO-DOCUMENTATION-SOP.md` told agents to use plural folders
  (`docs/specs/`, `docs/plans/`) and to keep ADRs in `.cleo/adrs/`.
- `docs/adr/ARCHIVED.md` claimed `docs/adr/` was archived, when it is the ADR
  publish mirror.

What changes:

- The SOP is rewritten in the store (slug `cleo-documentation-sop`) and
  republished as `docs/guide/cleo-documentation-sop.md`. It now covers finding
  the existing doc before writing a new one, the T14107 kinds and folders, the
  naming rule and the shrink-only baseline.
- `ARCHIVED.md` is deleted.
- Both files leave `scripts/.docs-name-baseline.json`.
- AGENTS.md "Canonical Docs Routing" now lists the T14107 kinds and the naming
  rule.
- `docs/migration/legacy-to-docs.md` now says to retire legacy files once
  their bytes are proven in the store, instead of keeping them in place.
