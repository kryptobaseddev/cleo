# OVERNIGHT AUTONOMOUS CAMPAIGN — 2026-04-24

**Owner directive (2026-04-24 ~05:55 UTC)**: full unattended execution. Ship every release slot v2026.4.126 → v2026.4.133. April terminus. No HITL approvals. Council usable for chairman tie-breaks. Use cleo-sandbox for E2E dogfood.

## Spine (locked, council-ratified, do not re-decide)

| Slot | Epic | Absorbed items | Depends | Size |
|------|------|----------------|---------|------|
| .126 | **T1258 E1** canonical naming | T1107 14 verbs · T1262 detector parallel | — | medium |
| .127 | **T1259 E2** seed-install meta-agent | F1 mint CLI + F2 starter pkg | E1 | medium-large |
| .128 | **T1260 E3** spawn wiring | M4 injection primitive · M6 provenanceClass | E1 | medium |
| .129 | **T1261 E4** governed pipelines | T1250 surface compression · M5 hot-path · STRICT cutover | E2 | medium-large |
| .130 | **T1263 E6** session-journal | T1262 CLI + session-end hook | E2 | large |
| .131 | **T1145 W5 + T1146 W6** deriver + dreamer | combined slot | E3 | large |
| .132 | **T1147 W7** reconciler | 2440-entry BRAIN sweep (shadow-write envelope) · T1139 supersession | W6 | large |
| .133 | **T1148 W8** sigil + Sentient v1 | T1151 self-healing · M7 assert-clean entry gate | W7, E4, E3 | large-meta |

## Execution rules (orchestrator)

1. **One orchestrator-sub-agent per slot.** It owns RCASD decomp + IVTR workers + validation + ship.
2. **Workers run in worktrees** under `~/.local/share/cleo/worktrees/<projectHash>/<taskId>/`.
3. **Evidence required at every gate** (ADR-051): `commit:` + `files:` for implemented; `tool:pnpm-test` for testsPassed; `tool:biome;tool:tsc` for qaPassed.
4. **Validators are independent** — no rubber-stamp. Spot-check 3 file:line citations per worker manifest.
5. **Council convened only on deadlock** — Chairman verdict overrides.
6. **Pre-tag verification mandatory** (Lesson 1): `pnpm biome ci .` repo-wide + `pnpm run build` root + `pnpm run test` zero-failures. THEN `gh run list` after push must show CI green AND Release green AND `npm view @cleocode/cleo version` returns the new tag.
7. **Cherry-pick discipline**: orchestrator (or its delegated cherry-picker) brings worker commits back to main. Workers NEVER merge.
8. **Memory observe per ship**: `cleo memory observe "..." --title "v2026.4.<n> shipped"`.
9. **Sandbox dogfood**: between slots, run `dev/sandbox/adapter-test-runner.sh` to catch regressions early.

## Successor protocol (if I run out of context)

If you are reading this as a successor session:

1. `cleo session status` — find the active orchestrator session
2. `git log --oneline origin/main -10` — verify last shipped tag
3. `cleo show T1258 T1259 T1260 T1261 T1263 T1145 T1146 T1147 T1148 2>&1 | jq '.data.task | {id, status, pipelineStage, parentId}'` — find current slot
4. Identify the FIRST `pending`/`active`/`blocked` epic in spine order — that's your slot
5. Spawn orchestrator-sub-agent for that slot with this campaign plan as context
6. Continue the spine; do not skip slots; do not re-decide architecture

## Stop condition

- v2026.4.133 tag pushed
- gh CI workflow green on .133 commit
- gh Release workflow green on v2026.4.133
- `npm view @cleocode/cleo version` returns 2026.4.133
- All 16 `@cleocode/*` packages at 2026.4.133 (or documented exception)
- `cleo show T1148 T1075` returns done/closed
- cleo memory observe entry titled "v2026.4.133 shipped — April terminus reached"

## Anti-patterns (instant fail)

- ❌ Orchestrator writes code or edits source files directly
- ❌ Skipping `cleo verify --evidence` (ADR-051 rejects)
- ❌ Claiming shipped without `gh run list` confirmation
- ❌ Re-litigating ratified council modifications M1-M7
- ❌ Touching `.cleo/tasks.db` or `.cleo/brain.db` outside CLI
- ❌ Worker writing outside its worktree (git shim blocks; orchestrator audits)
- ❌ Adding parallel BRAIN-integrity workstream — 4 items absorbed into spine

## State at launch

- Branch: main, commit `1c6a87ca5`, v2026.4.125 shipped, 16/16 packages on npm
- Active session: `ses_20260424055456_ede571` (v2026.4.126-T1258-psyche-e1-canonical-naming)
- T1258 pipeline initialized at `pipelineStage:research`, 1 child (T1107 blocked)
- T1107 parented to T1258 ✅, T1262 status=pending parent=null (parallel)
- Council reconciliation memory entry: `O-mochj9hp-0`
