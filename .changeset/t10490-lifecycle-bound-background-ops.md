---
id: t10490-lifecycle-bound-background-ops
tasks: [T10490]
kind: fix
summary: track + flush best-effort background DB ops so detached graph/LOOM writes never survive a test boundary (fixes intermittent pipeline-stage shard race)
---

addTask/completeTask kicked off fire-and-forget graph + LOOM writes as orphaned import().then().catch() promises. Under the vitest forks pool a detached op from one test could still be in flight when the next test reset the shared SQLite singleton, landing on the new fixture's connection and corrupting its reads (e.g. a freshly-written pipeline_stage reading back null, silently flipping the forward-only transition guard — the intermittent 'rejects backward stage transition' shard-1 failure surfaced by the drizzle rc.3 microtask-timing shift). New packages/core/src/store/background-ops.ts registry: trackBackgroundOp registers each op; awaitBackgroundOps drains them; the shared createTestDb harness flushes before resetDbState (both at fixture creation and cleanup). Production behaviour unchanged — ops still run detached. Verified: background-ops regression test proves pendingBackgroundOpCount()===0 after addTask/epic-create + flush; add/complete/pipeline-stage 99/99 green.
