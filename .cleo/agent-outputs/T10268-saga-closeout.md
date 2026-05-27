# Saga T10268 SG-IVTR-AUTONOMY — Investigation Closeout

**Status:** Investigation complete. ZERO code edits per goal directive.
**Date:** 2026-05-23

## Deliverables (all 9 ACs met)

| Wave | Epic | Slug | File | Lines |
|------|------|------|------|-------|
| 0 | T10269 | `ivtr-external-systems-steal-table` | `.cleo/agent-outputs/T10269-ivtr-external-systems.md` | 438 |
| 0 | T10270 | `ivtr-current-state-audit` | `.cleo/agent-outputs/T10270/ivtr-audit.md` | 584 |
| 1 | T10271 | `adr-079-ac-stable-ids` | `.cleo/agent-outputs/T10271/adr-ac-stable-ids.md` | 379 |
| 1 | T10271 | `adr-079-independent-validator` | `.cleo/agent-outputs/T10271/adr-independent-validator.md` | 643 |
| 1 | T10271 | `adr-079-docs-as-active-validator` | `.cleo/agent-outputs/T10271/adr-079-docs-as-active-validator.md` | 643 |
| 1 | T10271 | `adr-079-core-tools-first-class` | `.cleo/agent-outputs/adr-core-tools-first-class.md` | 302 |
| 2 | T10272 | `ivtr-council-verdict` | `.cleo/agent-outputs/T10272/ivtr-council-verdict.md` | 138 |
| 3 | T10273 | `ivtr-decomposition-plan` | `.cleo/agent-outputs/T10273/ivtr-decomposition-plan.md` | 401 |

## Council outcome (T10272)

| ADR | Verdict |
|-----|---------|
| AC stable IDs | NEEDS-REWORK (dual-ID over-engineered) |
| Independent Validator | NEEDS-REWORK (skill body missing, cost ROI unmeasured) |
| docs-as-active-validator | NEEDS-REWORK (spec-only scope too narrow, classifier untested) |
| CORE tools first-class | REJECTED-from-saga (out-of-scope; belongs to T9831 follow-on) |

18 action items captured in council verdict.

## Routing (T10273)

| ADR | Destination | Effort |
|-----|-------------|--------|
| AC stable IDs (r1) + Independent Validator (r1) | NEW Saga `SG-IVTR-AC-BINDING` (~7 Epics, 25-30 leaf tasks, 4 waves) | L-XL |
| docs-as-active-validator (r1) | NEW Epic `E-DOCS-VALIDATOR` inside existing T9625 SG-CLEO-DOCS-CANON | M |
| CORE tools first-class (IVTR-feeding subset of 4 tools) | Rides along inside SG-IVTR-AC-BINDING Wave 2 | S |
| CORE tools first-class (full registry refactor) | Re-filed under T9831 follow-on (XL, future) | XL |

## Pre-flight before Wave 2 of SG-IVTR-AC-BINDING

- Close T10156 (5 missing lint scripts in T9837 — trivial: scripts exist on disk, DB-stale only)
- Reconcile ADR-079 number collision → 079, 080, 081, 082 in dependency order

## Recommended next-session kick-off

Start NEW Saga `SG-IVTR-AC-BINDING` Wave 0 with: ADR-079-r1 (rewrite per council findings), Validator SKILL draft (the skill body the council noted was missing), and the cost-ROI measurement spike.

## Known issues / blockers found during this saga

- BRAIN DB schema malformed (`epic:T1075`) — blocks `cleo memory observe`/`decision-store`. Workaround for this saga: skip BRAIN, document everything via `cleo docs add`. File separately as bug.
- ADR-079 number collision — 4 parallel agents picked same next-free ADR number. Process fix: a serial number-allocator before spawn, or accept the slug-suffix as canonical and treat the ADR-number as cosmetic.

## Memory pointer

See `~/.claude/projects/-mnt-projects-cleocode/memory/` MEMORY.md for the SG-IVTR-AUTONOMY entry that will be added in a follow-up commit.
