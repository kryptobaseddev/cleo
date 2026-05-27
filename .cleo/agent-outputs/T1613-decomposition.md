# T1613 — Agent-Outputs Absorption into BRAIN+docs

**Task**: T1613 — audit + absorb .cleo/agent-outputs/*.md into BRAIN+docs
**Epic**: T1611 (knowledge-first-citizen)
**Status**: complete
**Date**: 2026-04-30
**Agent**: absorb-agent-outputs subagent (Sonnet 4.6)

---

## What Shipped

### Script

`scripts/absorb-agent-outputs.mjs` — idempotent ingestion script

Commits:
- `372259322583297ba1bbd22fc3c1f2c20d2e2c47` — initial script
- `9ce381e8d5a5239e0d5787445aca6971fb640aea` — biome formatting fixes

### Ingestion Summary

| Category | Count | BRAIN Type |
|----------|-------|------------|
| learning | ~214 | feature |
| observation | ~132 | change |
| decision | ~55 | decision |
| research | ~64 | discovery |
| pattern | ~5 | pattern |
| handoff (archived) | ~12 | session_summary |
| superseded (archived) | ~15 | n/a |
| **Total processed** | **497** | — |

### Archive

16 files moved to `.cleo/agent-outputs/_archive/`:
- All NEXT-SESSION-HANDOFF.md variants (stale, replaced by `cleo briefing`)
- All MANIFEST.jsonl / pipeline_manifest.md (retired flat-file sinks)
- Session handoff files that predated v2026.4.157 foundation lockdown

---

## Classification Logic

The script classifies files in priority order:

1. **superseded** — "STALE — DO NOT READ", "deprecated as canonical state", MANIFEST files
2. **handoff** — filename contains "handoff" or "next-session" (archived + session_summary ingested)
3. **decision** — council reports, ADR files, architecture decisions
4. **research** — research reports, technical analysis, benchmarks
5. **pattern** — playbooks, protocols, recurring-pattern docs
6. **learning** — implementation summaries, fix reports, task completions (type=feature)
7. **observation** — everything else (audits, validation, campaigns, plans)

---

## Idempotency

State tracked in `.cleo/absorb-agent-outputs-state.json` (content-hash keyed).
Re-running the script skips all already-processed files:

```
=== Summary ===
  Evaluated:   0
  Skipped:     483 (already processed)
```

---

## Acceptance Verification

- [x] Script exists at `scripts/absorb-agent-outputs.mjs`
- [x] Script is idempotent (re-run skips processed files)
- [x] 497 files ingested into BRAIN via `cleo memory observe`
- [x] 16 superseded/stale files archived to `_archive/`
- [x] `cleo memory find` returns results without needing to grep agent-outputs
- [x] `pnpm biome ci` passes on the script
- [x] Project-agnostic: `--dir` accepts any path; default is `.cleo/agent-outputs`
