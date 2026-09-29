---
id: t12692-one-comparator
tasks: [T12692]
kind: fix
summary: "`cleo orchestrate ready`, the focus ready wave, `orchestrate next`, the order within each wave, the bootstrap suggestion, `cleo plan` and the handoff's next tasks now rank through the same tiered comparator as `cleo next` (D11161)"
---

T12661 moved `cleo next`, the briefing and `cleo analyze` onto one comparator.
The other ordering surfaces still sorted on their own:

- `cleo orchestrate ready` sorted a saga's ready set by priority then id, and
  kept a plain epic's ready set in child order. The focus ready wave and the
  task-context ready frontier render that list, so they inherited both.
- `cleo orchestrate next` took the first ready child in child order.
- Members of a wave were sorted by priority, then open-dependency count, then id.
- The bootstrap `nextSuggestion`, the handoff's `nextSuggested`, the
  orchestrator skill's `readyToSpawn` and HITL `remainingTasks` sorted by
  priority only, so an attested severity never counted.
- `cleo plan` kept its own additive score and ignored severity.

All of these now order through `rankTasks`: priority band, then attested
severity (unset is unknown and never outranks an attested P1 of the same
band), then the bounded tiebreak (dependencies, phase, leverage, age), then
`createdAt`, then id. They share one project ranking context
(`loadRankingContext`), so a single fixture ranks the same way in `cleo next`,
`orchestrate ready` and the focus ready wave. Wave numbers are unchanged: they
stay structural dependency depth (T12683). Only the order of tasks within a
wave and the order of ready candidates changed.
