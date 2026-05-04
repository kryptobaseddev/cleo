# Council Hardening Playbook

The blueprint for systematically hardening the Council across question shapes via a structured shakedown campaign. This file is the **template**; per-campaign instances live under `optimization/campaigns/<name>/` and are gitignored.

A campaign is a sequence of shakedowns (1-N) where each shakedown:
1. Runs the full Council pipeline (Phase 0 → 5 advisors → 5 peer reviews → Phase 2.5 → Chairman)
2. Surfaces ≥0 failure modes (gate fails, validator catches, persona drift, fabricated framing)
3. Triggers ≤1 hardening fix shipped to `references/*.md` or `scripts/`
4. Adds a regression test (when applicable) so the fix is measurable in future runs

Telemetry persists to `.cleo/council-runs.jsonl` (skill-root) and is read by `scripts/analyze_runs.py`. The campaign manager (`optimization/scripts/campaign.py`) tracks which scenarios are done, which fixes shipped, and what to run next.

## Campaign workflow

```bash
# Start a new campaign from this playbook
python3 optimization/scripts/campaign.py new <campaign-name>

# Show status (which scenarios done, hotspots, fixes shipped)
python3 optimization/scripts/campaign.py status [--name <campaign>]

# Get the next scenario to run (with full briefing)
python3 optimization/scripts/campaign.py next [--name <campaign>]

# Mark a scenario complete after ingest
python3 optimization/scripts/campaign.py done <scenario-id> <run-dir-id> [--name <campaign>]

# Log a hardening fix that shipped between runs
python3 optimization/scripts/campaign.py log "<failure>" "<fix>" "<regression-test>"
```

## The eight scenarios

Each scenario tests ≥1 dimension uncovered by prior runs. Run in order; each subsequent scenario builds on the prior's hardening.

**Scenarios are loaded from `optimization/scenarios.yaml`** (or `scenarios.json` as a fallback). To add or modify a scenario, edit the YAML — no code changes required. The schema requires `id`, `number`, `title`, `dimension`, `shape`, `learn`, and `briefing` per entry. `campaign.py` picks up changes on the next invocation.

| # | Scenario | Dimension stressed | Question shape | What we learn |
|---|---|---|---|---|
| 1 | **baseline** | Control run | Narrow binary, dense evidence (5-7 path:line citations, no `llmtxt:`) | Baseline cost / wall-clock / gate-pass distribution all subsequent runs compare against |
| 2 | **external-doc-heavy** | Live `llmtxt:` integration | Binary, ≥3 of 7 evidence items as `llmtxt:<slug>` | Does the wrapper survive real subagent distribution under auth/rate-limit conditions? |
| 3 | **three-way** | Chairman ranking, not binary approve | "Which of A / B / C should we pick?" | Does the verdict template hold for N-way? Is `### Recommendation` flexible enough? |
| 4 | **sparse-ops** | Advisors with no code to grep | Configs + external docs only; no executable-code citations | Do advisors honestly say "insufficient" or hallucinate to fill gaps? |
| 5 | **contradictory** | Contradiction handling | Pack contains 2 items that disagree on purpose | Does Outsider catch it? Does FP re-derive cleanly under conflicting overlay? |
| 6 | **non-cleo** | Portability beyond cleocode conventions | Clone a small external repo + bug report; run council against it | Does the skill work on any project, or has it accumulated cleocode-isms? |
| 7 | **mini** | Overhead-vs-signal ratio | 3 evidence items only (the validator floor) | Is a "mini-council" variant worth shipping? Can the gates fire on thin packs? |
| 8 | **contention** | Chairman reconciliation under genuine disagreement | Designed to provoke a 3-vs-2 advisor split | Does the Chairman template handle real contention rather than directional convergence? |

## Between-run rules

- **After every run**, run `python3 scripts/analyze_runs.py --log .cleo/council-runs.jsonl` and check:
  - Gate failure appearing in ≥2 runs = **systemic**; harden the persona/validator that produced it.
  - Recurring "What I would add" cross-frame additions in peer reviews = **candidate for a new structural slot** in the persona output template.
  - Chairman confidence < `medium` on ≥2 runs with similar question shape = **the skill handles that shape poorly**; document as "not a good council fit" in `SKILL.md` or `references/evidence-pack.md`.
  - All-PASS gate verdicts across many runs = **suspicious leniency**; design the next shakedown to deliberately violate one frame's lane.

- **Between-run hardening fixes** must be logged via `campaign.py log` so the cumulative findings.md captures the compounding pattern.

## Exit criteria (campaign success)

The campaign succeeds when ALL of these hold across the runs:

- [ ] All 8 scenarios validate structurally (`scripts/validate.py` exit 0).
- [ ] Every advisor achieves **≥3.0 average gate-pass** across the 8 runs.
- [ ] **Convergence flag fires at most once** across the 8 runs (it should be rare; firing more = persona files have a contamination problem).
- [ ] Chairman confidence is `high` or `medium-high` on **≥6 of 8** runs.
- [ ] Token cost stable **within 20%** per scope tier (mean ± 20%).
- [ ] At least one substantive Outsider catch per 4 runs (cold-read producing artifact-internal-contradiction or premise-falsification finding that no other lane could produce).

`campaign.py status` prints the scorecard automatically.

## Cost honestly

Per shakedown:
- ~600k tokens (5 advisors × ~55k + 5 peer reviews × ~57k + Phase 2.5 + Chairman)
- ~8-10 minutes wall-clock
- ~$3-5 in API costs at current Sonnet/Opus rates

Full 8-scenario campaign: ~5M tokens, ~75 minutes wall-clock, ~$30-40. **Realistic cadence: 1-2 shakedowns per session, analyze, iterate. Full plan = weeks of evenings, not one marathon.**

## What falls out when done

- **Portable** — the skill works on any project, not just cleocode (validated by S6 non-cleo run)
- **Calibrated across scales** — mini-council (3 items) and full-council (5-7 items) both validated
- **Telemetry history** — future hardening is evidence-based via `.cleo/council-runs.jsonl`, not vibes-based

## Tradeoff

This playbook optimizes the skill for **quality across question shapes**, not for faster/cheaper runs. If the goal is **adoption** (make it lighter so it gets used more often), the scenario list should be reordered to lead with #7 (mini) and cut the structural stress tests (#5, #8).

## Failure-mode diff template

Each scenario's findings get appended to `optimization/campaigns/<name>/findings.md` in this format:

```
| Run | Scenario | Failure surfaced | Fix shipped | Regression test |
|---|---|---|---|---|
| 1 | baseline | <one-line failure> | <one-line fix> | yes/no/n-a |
```

The compounding pattern: a fix shipped after run N should be measurably validated by run N+1 or later. The `Regression test` column tracks whether that validation has been observed.

## Campaign archive (this skill's history)

The campaign directories are intentionally gitignored, so historical campaigns don't pollute the repo. The **distilled findings** that survived multiple campaigns SHOULD eventually be promoted into the persona files / SKILL.md as canonical hardening — at which point the campaign that produced them can be archived locally or deleted.

If a campaign produced a fix worth committing, the diff to `references/*.md` or `scripts/*.py` is the canonical commit; the campaign dir itself stays local.
