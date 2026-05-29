---
id: t10490-context-staleness-clock-boundary
tasks: [T10490]
kind: test
summary: freeze the clock in the context-staleness boundary test so age==threshold is deterministic (was an intermittent ubuntu-shard-1 flake)
---

context-staleness.test.ts 'returns null exactly at the staleness boundary' set detectedAt = Date.now() - CONTEXT_STALENESS_MS, then the detector re-read Date.now() (later) so ageMs = threshold + elapsed; under CI load even 1ms of elapsed wall-time tipped ageMs past the threshold, returning a proposal instead of null. The detector's <= threshold logic is correct; the test assumed zero elapsed time. Fix: vi.useFakeTimers + setSystemTime so both reads share one clock. Same intermittent-timing-flake class as the pipeline-stage race (T10490); surfaced on PR #812 by the drizzle rc.3 timing shift after the pipeline-stage fix removed the first flake.
