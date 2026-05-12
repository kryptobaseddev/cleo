# Objective Metrics — captured by orchestrator (cleo-prime)

Recorded outside any builder's self-report. All times from bench.log (builders' own `date +%s`) and Anthropic API metadata (total_tokens, tool_uses, duration_ms).

## Wall-clock (builder's own bench.log)

| Arm     | Start      | End        | Elapsed  |
|---------|-----------:|-----------:|---------:|
| vanilla | 1776314744 | 1776315119 | **375 s** (6 m 15 s) |
| gsd     | 1776314743 | 1776315261 | **518 s** (8 m 38 s) |
| cleo    | 1776314743 | 1776315196 | **453 s** (7 m 33 s) |

All three well under the 30-minute budget.

## Anthropic API metadata (measured at Agent-tool return)

| Arm     | total_tokens | tool_uses | duration_ms |
|---------|------------:|----------:|------------:|
| vanilla |      89,110 |        26 |     412,909 |
| gsd     |     120,585 |        37 |     560,620 |
| cleo    |     115,918 |        63 |     502,774 |

## Artifact census (objective, hidden & vendored paths excluded)

| Arm     | Source files | Planning artifacts | Source LOC | README lines |
|---------|-------------:|-------------------:|-----------:|-------------:|
| vanilla |           12 |                  0 |       1946 | (in total)   |
| gsd     |           10 |                 10 (.planning/) + STATE.md |       1583 | 96 |
| cleo    |           11 |                  9 tasks in .cleo/tasks.db  |       1659 | 89 |

## Test results (run independently by orchestrator)

| Arm     | Runner                  | Pass/Total | Duration |
|---------|-------------------------|-----------:|---------:|
| vanilla | `npm test` (aliased)    | **26/26**  | 54 ms    |
| gsd     | `node --test tests/*`   | **31/31**  | 41 ms    |
| cleo    | `node --test tests/*`   | **29/29**  | 50 ms    |

Note: gsd has no `package.json` (minor doc gap) but tests run fine via the documented `node --test` command.

## Sub-agent tiering — FAILED for all 3 equally

All 3 builders reported the `Agent` tool was not surfaced in their sub-agent environment (only `TaskCreate`, `TeamCreate`, `SendMessage`, etc. were). So the Opus→Sonnet→Haiku model-tiering protocol collapsed into: all 3 builders executed the entire task on Opus 4.6 directly. This is an equal handicap across arms and the comparison remains valid; it just means the experiment measures **Opus + tool regime** not **orchestrator + tiered workers**.

Prior art implication: the architectural expectation that a sub-agent can spawn further sub-agents (Agent-tool recursion) is blocked by the harness in this run. Future benchmarks needing true model tiering must be orchestrated at the top level, not inside a sub-agent.

## Tool-regime adherence (from self-reports + objective artifacts)

| Arm     | Regime claim | Artifacts evidence |
|---------|--------------|---------------------|
| vanilla | Claims regime honored partially (no sub-agents) | No cleo/gsd files; no `.planning/`; no `.cleo/` except the dir (empty of activity). Clean. |
| gsd     | Claims followed GSD phases new→discuss→plan→execute→verify; delegation blocked | `.planning/PROJECT.md`, `REQUIREMENTS.md`, `ROADMAP.md`, `STATE.md`, `1-CONTEXT.md`, `1-RESEARCH.md`, `1-1-PLAN.md`, `1-VERIFY.md`, `config.json` all present. GSD workflow evidence is strong. |
| cleo    | Claims session/task/verify lifecycle used | `.cleo/tasks.db` contains epic T001 + 8 atomic children T002-T009 all marked done with full 3-gate verification (implemented/testsPassed/qaPassed) and `lastAgent=cleo-prime`. Session ran 04:45:51Z → 04:53:16Z. |

## Known CLEO defect surfaced

- `cleo memory observe` failed with `E_BRAIN_OBSERVE: no such column: provenance` on v2026.4.65 (schema migration missing)
- `cleo session end` also printed a "Failed to write memory bridge" warning from the same column.
- Non-blocking but means BRAIN did not persist architecture observations.
