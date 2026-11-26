---
id: docs-update-supersede-fix-audit
tasks: [T14660]
kind: fix
summary: "cleo docs update --superseded-by refusals carry a structured fix, and a supersession audits its successor"
---
- Every `cleo docs update --superseded-by` refusal (no or another status, a
  content edit, an unknown successor, the doc itself, a superseded doc) returns
  its remedy as the envelope's `error.fix`, not only in the message text.
- A supersession through `cleo docs update` records the successor: the docs
  audit entry reads `Superseded 'OLD' → 'NEW'` as `cleo docs supersede` wrote,
  and the docs-versioning revision carries `supersededBy`.
