---
id: t13270-mark-identity-shared-open
tasks: [T13270, T13249]
kind: fix
summary: a snapshot export or import that carries uids always records the shared marker, opening the store when no handle is bound
---

T13249 marked the store's identity as shared (`row_identity_synced`) whenever a snapshot export
or import carried uids. When no project handle was bound, it skipped the marker silently, so a
later refill could re-derive uids that a committed snapshot names. It now opens the store through
the chokepoint when it has to. A failure to open throws instead of passing silently.
