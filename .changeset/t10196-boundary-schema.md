---
"@cleocode/contracts": minor
---

feat(T10196): boundary registry schema + types in @cleocode/contracts (SAGA T10176 · ADR-078)

Introduces WorkloadIntent, PerfBudget, SafetyBudget, BoundaryEntry, and an empty BOUNDARY_REGISTRY const skeleton. T10197 will populate the registry entries; T10198/T10199 will ship CI gates over this data.
