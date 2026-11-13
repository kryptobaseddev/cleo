---
id: t14533-lead-finding-parent-scope
tasks: [T14533]
kind: fix
summary: "Lead findings must be filed under the lead's own epic subtree, and orchestrate status refuses conflicting epic ids"
---

The lead runner refuses `cleo add --parent none` and any parent outside the lead's epic subtree, resolved against the task store. `cleo orchestrate status T1 --epic T2` now fails with E_INVALID_INPUT instead of silently using the positional.
