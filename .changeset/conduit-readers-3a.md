---
id: conduit-readers-3a
tasks: [T13981]
kind: refactor
summary: "conduit retirement 3a: drop the dead sendConduitEvent helper and the no-op conduit check in nexus living-brain; deprecate the roll-up conduitMessages option"
---
Follows T13953, which stopped every automatic conduit write.

- `sendConduitEvent` and its `ConduitOrchestrationEvent` type are removed from
  `@cleocode/core/internal` (internal tier); nothing called them.
- `nexus` living-brain no longer opens the conduit path for a check that did
  nothing; `conduitThreads` still comes from BRAIN edges.
- `orchestration.RollupWaveStatusOptions.conduitMessages` and
  `orchestration.ConduitStatusMessage` are deprecated (stable root API) and
  listed in STABILITY.md; they go with the conduit public API (T13957).
- The event-bus comment now matches the file default.
