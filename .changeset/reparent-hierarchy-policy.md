---
id: reparent-hierarchy-policy
tasks: [T14550, T14551]
kind: fix
summary: "Reparent: enforce resolved hierarchy profiles and active sibling limits"
---

Task reparenting now uses the same hierarchy policy as task creation, honoring profile presets, explicit caps including zero, and completed-child counting. Decomposition protocol guidance and its CANT twin now describe the effective profile defaults.
