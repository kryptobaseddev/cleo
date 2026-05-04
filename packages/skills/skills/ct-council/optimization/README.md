# `optimization/` — Council Hardening Campaigns

This directory holds the **systematic hardening machinery** for The Council skill. It separates the durable playbook (committed) from the per-campaign state (gitignored), so you can run multiple multi-session optimization passes without polluting the repo.

## What's here

| Path | Tracked? | Purpose |
|---|---|---|
| `HARDENING-PLAYBOOK.md` | ✅ committed | The master plan — 8 scenarios, exit criteria, between-run rules, cost honesty |
| `scripts/campaign.py` | ✅ committed | Programmatic tracker — `new / next / done / log / status / list / active` |
| `README.md` | ✅ committed | This file |
| `.gitignore` | ✅ committed | Keeps `campaigns/` and `.active-campaign` out of git |
| `campaigns/<name>/` | 🚫 gitignored | Per-campaign state: manifest, plan, findings, run symlinks |
| `.active-campaign` | 🚫 gitignored | Pointer to the currently-active campaign |

## Workflow

```bash
# From the skill root: packages/skills/skills/ct-council/

# 1. Start a new campaign (any time you want a fresh hardening pass)
python3 optimization/scripts/campaign.py new 2026-04-25-portability

# 2. See what to run next (prints scenario briefing)
python3 optimization/scripts/campaign.py next

# 3. Run a shakedown using the existing pipeline
python3 scripts/run_council.py init "<question>" --scenario <id> --subagent-mode
# orchestrator runs Phase 0..3 → assembles output.md
python3 scripts/run_council.py ingest <run-dir>

# 4. Mark the scenario complete (links the run dir into the campaign)
python3 optimization/scripts/campaign.py done <scenario-id> <run-dir-id>

# 5. If a hardening fix landed between runs, log it
python3 optimization/scripts/campaign.py log "Executor mis-cite line range" \
    "Pre-action verification rule in executor.md" "yes"

# 6. After every run, check status (exit-criteria scorecard auto-renders)
python3 optimization/scripts/campaign.py status

# Resume across sessions
python3 optimization/scripts/campaign.py list      # see all campaigns
python3 optimization/scripts/campaign.py active --set <name>  # switch
```

## Why split playbook from state?

- **Playbook is durable.** The 8 scenarios + exit criteria don't change run-to-run; they're the institutional memory of how to harden a multi-frame review skill. Promoting it to a checked-in artifact means future operators can run the same campaign without re-deriving it.
- **State is local.** Run dirs are large (~300-400 line transcripts × N runs), telemetry contains project-specific paths, and findings get *promoted* into the persona files when they prove durable. Keeping campaign state out of git avoids both noise and provenance leakage.

## Promotion path: campaign findings → committed code

When a hardening fix proves durable across ≥2 runs in the same campaign, it should be promoted from the campaign's `findings.md` into committed code:

| Fix shape | Goes into |
|---|---|
| Persona output template change | `references/<advisor>.md` |
| New gate / format rule | `references/peer-review.md` + `scripts/validate.py` |
| Phase 0 / orchestrator discipline | `references/evidence-pack.md` |
| Tooling / pipeline change | `scripts/<file>.py` + tests |
| Output-shape change (verdict / TL;DR) | `scripts/telemetry.py` + tests |

The campaign directory itself is **disposable** once durable findings are promoted. The git diff to the persona files is the canonical commit; the campaign that produced it stays local.

## Cost expectations (re-stated from the playbook)

- Per shakedown: ~600k tokens, ~9 minutes wall-clock, ~$3-5
- Full 8-scenario campaign: ~5M tokens, ~75 minutes, ~$30-40
- Realistic cadence: 1-2 shakedowns per session × multiple sessions

## Historical note

The first campaign (run during the skill's initial creation) shipped 4-5 substantive hardening fixes — structured Phase 2.5 extractor, Executor pre-action verification, gate-line format spec, Phase-0 fact-check rule, three-tier output (verdict.md / tldr.md / output.md). Those are now in the committed code. The campaign directory that produced them is gitignored and may be archived locally.
