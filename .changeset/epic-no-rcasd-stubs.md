---
id: epic-no-rcasd-stubs
tasks: [T13944]
kind: fix
summary: "cleo add --type epic no longer writes lifecycle rows or a .cleo/rcasd stub; orchestrate start records the research row without a stub file"
---
Every `cleo add --type epic` fired a background LOOM init that wrote five
lifecycle rows and a `.cleo/rcasd/<epic>/research/<epic>-research.md` stub,
and `cleo orchestrate start` did the same. Over a thousand of those stubs had
piled up, and nothing reads them: completion gates read the epic's
`pipeline_stage`, and `cleo verify --explain` reads verification records.

- Epic creation no longer initializes the lifecycle pipeline.
- `initLoomForEpic` (used by `cleo orchestrate start` and the backfill)
  records the `research` row only; `recordStageProgress` takes
  `{ writeArtifact: false }` for that. Explicit `cleo lifecycle` verbs still
  write their stage files.
