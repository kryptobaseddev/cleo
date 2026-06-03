---
id: t11655-briefing-embedding-worker-shutdown
tasks: [T11655]
kind: fix
summary: Tear down EmbeddingQueue worker in shutdownCliRuntime + gate opportunistic dream off one-shot CLI — fixes briefing spin/WAL-bloat.
prs: []
---

`cleo briefing` could spin (state Rl) for hours, holding the brain WAL open → 2.1GB bloat (RCA `briefing-hang-wal-bloat-rca-2026-06-02`). #914 (T11568) tore down the brain-writer worker in `shutdownCliRuntime` but NOT the `EmbeddingQueue` worker (`packages/core/src/memory/embedding-queue.ts`, helper `resetEmbeddingQueue()`), and the opportunistic dream in `packages/core/src/sessions/briefing.ts` fires `runConsolidation`, which — in the published bundle where the embedding worker file is unresolvable — runs transformers.js embeddings on the MAIN thread → CPU spin.

**Fix.**
(a) `shutdownCliRuntime()` now also `await safely(() => resetEmbeddingQueue())`, so the embedding worker's `MessagePort` cannot keep a one-shot CLI command alive after its envelope is emitted.
(b) The opportunistic dream is gated OFF for one-shot read commands. It now fires only when the caller opts in (new `allowOpportunisticDream` field on `SessionBriefingShowParams`) or when running inside a long-lived sentient host (`CLEO_SENTIENT_DAEMON` / `CLEO_SENTIENT_SPAWN`). The sentient daemon's tick loop owns consolidation directly via `checkAndDream`, so its path is unaffected.

**Tests.** `shutdown.test.ts` asserts `resetEmbeddingQueue` is part of the teardown contract plus best-effort step isolation; `process-exit-no-hang.test.ts` adds a one-shot `cleo briefing` subprocess case proving it exits on its own (no lingering worker / dream spin); the briefing dream tests are updated for the new opt-in default.
