---
id: t10197-boundary-registry-data
tasks: [T10197]
kind: feat
summary: "populate BOUNDARY_REGISTRY with all 19 crates + 20 packages (SAGA T10176)"
---

feat(T10197): populate BOUNDARY_REGISTRY with all 19 crates + 20 packages (SAGA T10176)

Translates the verified decision matrices (sg-boundary-{crates,packages}-decision-matrix)
into BoundaryEntry literals per ADR-078. Signaldock crates flagged migration-pending
(pointing to /mnt/projects/signaldock/ per T10180). cleo-llm-native flagged for deletion
via T10205 amendment. Every entry carries a populated rationale citing the consumer-count
and workload reasoning from the decision matrix.
