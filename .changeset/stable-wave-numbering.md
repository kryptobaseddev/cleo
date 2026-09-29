---
id: stable-wave-numbering
tasks: [T12683]
kind: fix
summary: "wave numbers are stable: finished waves keep their number and are listed as completed, so orchestrate waves, worker topics and roll-up never renumber; --hide-completed omits finished waves"
---
`computeWaves` used to drop done, cancelled and archived tasks and number the
remaining waves from 1. As waves completed, every later wave shifted down. A
Lead that subscribed ahead to `epic-<E>.wave-2`, or reused a topic, then
listened on the wrong wave. Owner decision (option A, 2026-09-29): wave numbers
are stable.

- **Numbering.** Every child keeps the wave its dependency depth gives it,
  whatever its status.
  - A dependency inside the epic orders the plan, whatever its status.
  - A dependency outside the epic must be done or archived. An unfinished one
    holds the task in the final pending wave, and only that task moves when the
    dependency finishes.
  - A finished wave is listed with status `completed`; a partly finished one
    is `in_progress`.
- **Readiness is unchanged.** `ready` and `blockedBy` are still reported per
  task. `orchestrate ready`, `orchestrate plan` and `orchestrate parallel start`
  skip finished tasks, so they are never run again.
- **`cleo orchestrate waves --hide-completed`** omits finished waves. The
  remaining waves keep their numbers, and `totalWaves` still counts them all.
- **One plan everywhere.** `orchestrate waves`, `orchestrate roll-up --wave n`,
  worker wave topics `epic-<E>.wave-<n>` and `orchestrate parallel --wave n`
  all read the same plan (`planEpicWaves`), so one n names one wave.
