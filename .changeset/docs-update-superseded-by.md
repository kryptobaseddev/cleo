---
id: docs-update-superseded-by
tasks: [T14657]
kind: fix
summary: "cleo docs update --status superseded --superseded-by records the successor link the deprecated cleo docs supersede wrote"
---
- `cleo docs update OLD --status superseded --superseded-by NEW` sets OLD
  superseded, OLD's `superseded_by` and NEW's `supersedes` in one transaction,
  the same link `cleo docs supersede OLD NEW` wrote. It is refused with a
  content edit, another status, an unknown successor or the doc itself.
- `cleo docs doctor` names that full command for an ambiguous archive target
  and for a superseded doc with no recorded successor, and `cleo docs update`
  no longer points a superseded doc at the deprecated `cleo docs supersede`.
