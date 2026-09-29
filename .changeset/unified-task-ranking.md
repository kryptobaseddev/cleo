---
id: unified-task-ranking
tasks: [T12661, T12691]
kind: fix
summary: "`cleo next`, the briefing's nextTasks and both `cleo analyze` paths rank through one tiered comparator: priority band, then attested severity, then a bounded tiebreak. `--explain` shows each tier"
---

Field report (axiom-analytics). T741, a fresh high-priority `kind=bug` with no
severity, ranked 136th of 385 in `cleo next`, while the briefing listed T016,
a 93-day-old medium feature that unblocks 8 tasks. `cleo next`, the briefing
and `cleo analyze` each kept their own weights. On top of that, the additive
score let computed bonuses cross owner priority bands: a low-priority P0 bug
with every bonus scored 115 and beat a plain critical task at 110.

The ranking follows the council verdict the owner adopted (D11161):

- **One comparator.** `scoreTask`/`rankTasks` (task-tools) order tasks
  lexicographically:
  1. priority band (critical > high > medium > low);
  2. attested severity (P0 > P1 > P2 > P3 > unknown). An unset severity is
     unknown; a bug no longer gets an imputed P2;
  3. a bounded tiebreak: dependencies ready +10, phase alignment +20,
     leverage +5 per open dependent capped at +20, anti-starvation age +1 per
     week capped at +10;
  4. creation time, oldest first, parsed and normalised to UTC;
  5. id.
- **Brain patterns** leave the order and appear in `--explain` only as
  informational lines.
- **Same inputs everywhere.** `cleo next`, the briefing and both analyze
  paths (`cleo analyze` via `coreTaskAnalyze`, and the SDK
  `analyzeTaskPriority`) rank through `rankReadyTasks`. They share the
  candidate set, the current phase (`resolveRankingPhase`), one `nowMs` per
  ranking, and open-dependent leverage.
- **`--explain`** lists the tier keys (`tier 1 band`, `tier 2 severity`,
  `tier 3 …`). `score` folds the key into one number that sorts the same way
  (band × 10000 + severity × 1000 + tiebreak), and `ScoreTaskResult.key`
  carries the key itself.
- **Remaining orderings.** About ten others still use their own priority
  weights, for example orchestrate ready/next, handoff nextSuggested, inject
  and plan. Routing them through this comparator is tracked in T12690.
