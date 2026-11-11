---
id: orca-pending-dispatch-recovery
tasks: [T14496]
kind: fix
summary: "Orca replay: adopt the accepted successor from a pending refusal"
---

Recover the exact successor Dispatch from Orca's pending worker-start refusal after a restart between acceptance and receipt. Match both request IDs to the saved replay key and retain runtime, predecessor and existing Dispatch fencing.

Keep launch and resource status uncertain until exact observation or guarded stop proves their state, preserving claims and dirty worktrees.
