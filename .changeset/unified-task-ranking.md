---
id: unified-task-ranking
tasks: [T12661]
kind: fix
summary: "`cleo next`, the briefing's nextTasks and both `cleo analyze` paths rank through one scorer that weighs severity and bugs, with bounded leverage and age bonuses and every factor in `--explain`"
---

Field report (axiom-analytics). T741, a fresh high-priority `kind=bug` with no
severity, ranked 136th of 385 in `cleo next`, while the briefing listed T016,
a 93-day-old medium feature that unblocks 8 tasks. There were four rankers
with four sets of weights:

- `cleo next` had severity but no bug weight.
- The briefing had no severity, an unbounded leverage bonus, and a deps bonus
  only for tasks that had dependencies.
- `cleo analyze` used priority weights 100/50/20/5 plus leverage.
- The shared `scoreTask` tool was called by nothing.

What changed:
- `scoreTask` (task-tools) is the scorer for these rankers, and `rankTasks`
  gives it a deterministic tie-break: older creation instant, parsed and
  normalised to UTC, then id. `cleo next`, the briefing and both analyze paths
  (`cleo analyze` via `coreTaskAnalyze`, and the SDK `analyzeTaskPriority`)
  rank through `rankReadyTasks`. They share the candidates, the current phase
  (`resolveRankingPhase`) and the brain patterns. Analyze reports
  open-dependent leverage.
- About ten other orderings still use their own priority weights, for
  example orchestrate ready/next, handoff nextSuggested and inject. Routing
  them through the shared scorer is tracked in T12690.
- Zone-less `YYYY-MM-DD HH:MM:SS` timestamps are read as UTC for both the age
  factor and the tie-break.
- Weights: priority 100/75/50/25. Severity P0 +30, P1 +15, P2 +10, P3 +5; a
  `kind=bug` with no severity is scored as P2. Phase +20, deps ready +10.
  Leverage is +5 per open dependent, capped at +20. The anti-starvation age
  bonus is +1 per week, capped at +10 (was +15).
- `cleo next --explain` names every factor, including the bug default and the
  anti-starvation cap.
