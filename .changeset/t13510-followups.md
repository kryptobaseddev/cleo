---
id: t13510-followups
tasks: [T13510, T13493]
kind: chore
summary: "Spawn's atomicity pre-check records no duplicate dispatch trace; the preflight install documents why its stdio stays piped"
---
- **No duplicate dispatch trace.** The T13510 pre-check compose resolved the agent a second time, so every allowed spawn recorded two dispatch traces. `resolveAgent`, `composeSpawnPayload` and `composeSpawnForTask` now accept `skipDispatchTrace`, and the pre-check passes it. The real compose still records the one trace.
- **Preflight stdio comment.** The worktree preflight's `pnpm install` keeps `stdio: 'pipe'`, and a comment now says why. An inherited stdout would put pnpm's output ahead of the spawn's LAFS envelope (ADR-086), and it would slip past the stdout guard test from T13493.
