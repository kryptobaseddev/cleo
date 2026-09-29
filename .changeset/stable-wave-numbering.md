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

- **Numbering.** A task's wave is its structural depth in the dependency graph:
  1 plus the deepest of its dependencies, whatever their status and whichever
  epic holds them. `planEpicWaves` loads the whole dependency closure,
  archived and other-epic tasks included.
  - A wave number never changes when work completes, a finished task is
    archived, a prerequisite is re-parented, or an external prerequisite
    finishes. Only an edit to the dependency edges moves a task.
  - Numbers can skip. A task whose external prerequisite sits at depth 3 is
    in wave 4.
  - There is no 50-wave cap. Tasks on a cycle share a final wave.
  - A finished wave is `completed`; a partly finished one is `in_progress`.
- **Readiness is unchanged.** `ready` and `blockedBy` are still reported per
  task. `orchestrate ready`, `orchestrate plan` and `orchestrate parallel start`
  skip finished tasks, so they are never run again.
- **`cleo orchestrate waves --hide-completed`** omits finished waves. The
  remaining waves keep their numbers, and `totalWaves` still counts them all.
- **One plan everywhere.** All of these read the same plan (`planEpicWaves`),
  so one n names one wave: `orchestrate waves`, `orchestrate status` and
  `start`, `orchestrate roll-up --wave n`, worker wave topics
  `epic-<E>.wave-<n>`, and `orchestrate parallel --wave n`. `start`'s
  `firstWave` is the first incomplete wave.
