---
id: t14455-orca-worker-routing
tasks: [T14455]
kind: feat
summary: Route CLEO workers through verified Orca execution with durable harness rotation
---

Spawn-execute, fanout and lead-dispatched workers attach the canonical CLEO worktree inside a verified local Orca context. Harness rotation uses configured agents and active account availability, persists the last selection and confirmed disabled routes, and retains unknown outcomes without native fallback or filesystem disposal. Exact per-account placement refuses; the restricted lead launch remains native.
