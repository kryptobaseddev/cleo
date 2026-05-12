# T1083 — PSYCHE Wave 4: Multi-Pass Context Engine

**Status**: complete
**Commit**: ac6ca97d34b1b2d636065ee2fa1f9a45203d83b2 (worktree task/T1083)
**Session**: ses_20260422131135_5149eb

## Summary

Implemented the PSYCHE Wave 4 multi-pass retrieval engine that stitches Waves 1+2+3
into a single `buildRetrievalBundle` function consumed by `cleo briefing`.

## Deliverables

### T1090 — brain-retrieval.ts: 4 new exported functions

- `fetchIdentity(peerId, nexusDb)` — cold pass: calls `listUserProfile({minConfidence:0.5})` from Wave 1
- `fetchPeerMemory(peerId, brainDb, query?)` — warm pass: peer-scoped learnings/patterns/decisions from Wave 2
- `fetchSessionState(sessionId, projectRoot)` — hot pass: session narrative from Wave 3 + recent observations + active tasks
- `buildRetrievalBundle(req, projectRoot)` — orchestrates all 3 passes in parallel with 20/50/30 token budget split; trims hot observations first when over budget

### T1091 — briefing.ts: bundle field

- Added `bundle?: RetrievalBundle` field to `SessionBriefing` interface
- `computeBriefing` populates it via `buildRetrievalBundle` when active session is resolvable
- Fully backward-compatible — existing `memoryContext` field unchanged

### T1092 — E2E integration test

- File: `packages/core/src/memory/__tests__/psyche-wave4.test.ts`
- 16 tests, all pass
- Scenarios: cold pass global identity, warm pass peer isolation, hot pass session-scoped,
  token budget trimming, passMask cold-only/hot-only, full bundle shape validation,
  briefing.ts bundle field presence

### Contracts

- `packages/contracts/src/operations/memory.ts` — added `PassMask`, `RetrievalRequest`,
  `RetrievalBundle`, `RetrievalActiveTask`, `RetrievalObservation`, `RetrievalLearning`,
  `RetrievalPattern`, `RetrievalDecision`, `RetrievalTokenCounts`
- `packages/contracts/src/index.ts` — re-exported all 9 new types at top level

## Key Decisions

- Session narrative is preserved verbatim (never trimmed); only `recentObservations` and
  `activeTasks` are trimmed when the hot budget is exceeded
- `peerInstructions` returns `"Active peer: <peerId>"` as a placeholder; Wave 8 (T1148)
  will enrich from the `peer_cards` table
- All 3 passes run in parallel via `Promise.all` for minimum latency
- Budget split: cold=20%, warm=50%, hot=30% of total (default 4000 tokens)
- Graceful degradation throughout — each pass catches all errors and returns empty defaults

## Files Changed

- `packages/core/src/memory/brain-retrieval.ts` — +~400 lines for 4 new functions
- `packages/core/src/sessions/briefing.ts` — +30 lines for bundle field
- `packages/core/src/memory/__tests__/psyche-wave4.test.ts` — new (16 tests)
- `packages/contracts/src/operations/memory.ts` — +160 lines for 9 new types
- `packages/contracts/src/index.ts` — +12 lines export block
