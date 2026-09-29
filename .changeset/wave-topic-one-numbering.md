---
id: wave-topic-one-numbering
tasks: [T12682]
kind: fix
summary: "spawned workers publish on the wave topic their Lead listens on (epic-<id>.wave-<n>, n from orchestrate waves); roll-up --wave uses the same 1-based numbers"
---
A Lead listens on `epic-<epicId>.wave-<n>`, with `n` the wave number that
`cleo orchestrate waves` prints. Spawned workers were told a different topic:
`epic-<epicId>.wave-<last 4 digits of their task id>`. A Lead therefore never
heard its workers and waited out its budget.

- **One plan, one topic.** `planEpicWaves` is now the single wave plan. The
  waves listing, roll-up and the spawn prompt all read it, with the same
  dependency lookup and the same numbers. `orchestration/wave-topic.ts` holds
  the rule: `waveTopic`, `coordinationTopic`, `waveNumberOfTask` and
  `deriveConduitSubscription`. A spawned worker's CONDUIT section names
  `epic-<epicId>.wave-<n>`, with n its wave in that plan. A task the plan does
  not schedule gets no CONDUIT section, rather than a topic nobody listens on.
- **Same numbering for roll-up.** `cleo orchestrate roll-up <epic> --wave <n>`
  and `rollupWaveStatus(epicId, n)` count from 1, as `orchestrate waves` does.
  They used to count from 0. `--wave 0` is now refused with a pointer to
  `orchestrate waves`, instead of silently meaning the first wave.
  `rollupEpicStatus` rolls up each planned wave by its number.
- The `cleo conduit publish/listen` help examples now show `epic-T1149.wave-2`
  instead of a task-id topic.
- ct-lead's wording for this contract (`--wave "${WAVE}"`, no 0-index note)
  lands with #1654.
