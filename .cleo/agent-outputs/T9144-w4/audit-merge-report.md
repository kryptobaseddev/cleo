# T9148 W4 — ct-cleo SKILL.md Audit-Merge Report

**Task**: T9148 (W4: Help renderer + INJECTION canonical + ct-cleo collapse)
**Date**: 2026-05-12
**Worker**: worker-l

## Summary

ct-cleo SKILL.md reduced from 615 lines → 31 lines (thin pointer per T9148).

All canonical protocol content consolidated in `~/.cleo/templates/CLEO-INJECTION.md`
with HTML-comment section anchors.

## Line Disposition (615 lines → 31 lines)

| Content Block | Lines | Disposition | Destination |
|---|---|---|---|
| Frontmatter + title | 6 | kept-as-pointer | ct-cleo SKILL.md |
| Canonical decision tree (session-start entry point) | ~30 | merged-back-to-INJECTION | `session-start` section |
| Phase mapping (RCASD-IVTR+C) | ~12 | merged-back-to-INJECTION | merged into existing section content |
| Goal: Discover Work tree | ~25 | merged-back-to-INJECTION | `task-discovery` section |
| Goal: Memory Operations tree | ~20 | merged-back-to-INJECTION | `memory` + `memory-jit` sections |
| Goal: Track Session Context | ~15 | merged-back-to-INJECTION | `session-commands` + `session-start` sections |
| Goal: Discover Available Skills | ~8 | deleted-as-stale | skill discovery is not in INJECTION (CLI meta) |
| Goal: System Information | ~8 | deleted-as-stale | `cleo dash` / `cleo help` not INJECTION content |
| Pre-Complete Gate Ritual | ~50 | merged-back-to-INJECTION | `pre-complete-gate` section |
| Multi-Agent Coordination | ~30 | merged-back-to-INJECTION | `orchestration` section |
| Greenfield Bootstrap | ~25 | deleted-as-stale | one-time setup; not agent-workflow content |
| Spawn Prompt Contents (tiers) | ~15 | merged-back-to-INJECTION | `spawn-tiers` section |
| Reference (CLI, operation tables) | ~250 | deleted-as-stale | duplication of INJECTION; full tables in INJECTION |
| Session Protocol | ~40 | merged-back-to-INJECTION | `session-commands` + `session-start` sections |
| Error Handling | ~20 | merged-back-to-INJECTION | `error-handling` section |
| RCASD-IVTR+C Lifecycle | ~15 | deleted-as-stale | architectural doc; not per-session content |
| Anti-Pattern Reference | ~25 | deleted-as-stale | integrated into `pre-complete-gate` section |
| Time Estimates Prohibited | ~5 | merged-back-to-INJECTION | `rules` section |
| Further Reading | ~8 | deleted-as-stale | internal doc pointers; not INJECTION content |

## New Deliverables

| Deliverable | File | Status |
|---|---|---|
| ct-cleo SKILL.md thin pointer | `packages/skills/skills/ct-cleo/SKILL.md` | ✅ 31 lines (≤50) |
| CLEO-INJECTION.md anchors + Nexus section | `~/.cleo/templates/CLEO-INJECTION.md` | ✅ HTML anchors on all sections |
| `cleo briefing inject --section` CLI | `packages/cleo/src/cli/commands/briefing.ts` | ✅ inject subcommand |
| Adapter rendering (`--format adapter:*`) | same file | ✅ claude/codex/gemini/compact-json |
| CI gate script | `scripts/check-ct-cleo-thin.mjs` | ✅ |
| `check:ct-cleo-thin` npm script | `package.json` | ✅ |

## Deferred (depends on W3 T9147)

- `cleo graph --help` 2-bucket first-screen renderer (requires W3 CLI split)
- `cleo nexus --help` 2-bucket renderer (requires W3 CLI split)
- Token budget validation (≤720 tokens for full help) — cannot measure until W3 ships

These items will be addressed in a follow-up once T9147 completes.
