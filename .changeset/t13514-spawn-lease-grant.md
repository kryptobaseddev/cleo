---
id: t13514-spawn-lease-grant
tasks: [T13514]
kind: fix
summary: "Spawn records the lease it granted, so changing CLEO_CLAIM_LEASE_MINUTES cannot make a live worker's session look unused"
---
The re-spawn live-worker check (T13491) compared a reused session's lease against `claimedAt` plus the lease length configured at re-spawn time. If the lease length was raised between the spawn and the re-spawn, a worker-renewed lease read as untouched, and the re-spawn handed the child the live worker's session.

Each fresh spawn grant is now recorded as a `spawn_claim_grant` audit row holding its `claimedAt` and `leaseExpiresAt`. The re-spawn check compares against that grant. A lease granted before grants were recorded falls back to the configured length. This needs no schema change: the grant lives in the existing task audit log.
