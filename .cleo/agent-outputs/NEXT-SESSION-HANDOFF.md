# MASTER Session Handoff — 2026-04-20

**Session ended**: ses_20260420023541_d7ed28 (resume of ses_20260419003330_22e46b)
**Baseline**: v2026.4.100 live on npm (core + cleo)
**Owner**: kryptobaseddev

---

## What shipped this session (v2026.4.98 → v2026.4.99 → v2026.4.100)

**17 CLEO tasks closed across 3 releases:**

### v2026.4.98 — T991 BRAIN Integrity + T1000 BRAIN Advanced + T1007 Tier 2 + T1013 Hygiene
- T991 (auto-done, 8/8 children): T992 verifyAndStore routing, T993 Check A0 title-prefix blocklist, T994 correlateOutcomes Step 9a.5 + trackMemoryUsage, T995 Step 9f hard-sweeper DELETE, T996 dream cycle → tick, T997 promote-explain CLI, T998 nexus plasticity, T999 bridge mode flag (cli default)
- T1000 (auto-done, 6/6 children): T1001 typed promotion, T1002 transcript ingestion, T1003 staged backfill, T1004 precompact flush, T1005 'diary' type, T1006 6 missing CLIs
- T1008 Sentient Tier 2 (propose + 3 ingesters + transactional rate limiter)
- T1014 CLI bug fix (cleo update --files + epic role auto-promote)

### v2026.4.99 — T1015 Architecture cleanup
- Relocated `packages/cleo/src/{sentient,gc}/` → `packages/core/src/{sentient,gc}/`. Restored canonical SDK/CLI boundary.

### v2026.4.100 — Build hotfix
- Added 12 missing esbuild entry points in `build.mjs`. v2026.4.99 had shipped `.d.ts` only (no `.js`) for brain-backfill / precompact-flush / sentient/* / gc/* / system/platform-paths — `ERR_MODULE_NOT_FOUND` at runtime.

---

## Outstanding for next session

### 1. Codify package-boundary rule in project AGENTS.md — **UNRESOLVED**
- Lesson from T1015: Workers default to existing (wrong) file placement. `packages/cleo/src/sentient/` got more files added by T1008 Worker because sentient/ was already there.
- **Action**: add a "Package-Boundary Check" subsection to `/mnt/projects/cleocode/AGENTS.md` "CLEO Agent Code Quality Rules (MANDATORY)" stating: `packages/cleo/` = CLI only · `packages/core/` = SDK · `packages/contracts/` = types · `packages/cleo-os/` = harness. Spawn prompts MUST include explicit package-boundary check as acceptance criterion when adding new modules.
- NOT CLEO-INJECTION.md (that's project-agnostic basic usage only).

### 2. T988 Dispatch typed-narrowing (Wave D) — **DEFERRED, READY**
- Epic T988 with 9 children T975-T983 (all pending, research stage). 579 `as any`/cast eliminations across 9 dispatch domains.
- Operator deferred intentionally to v2026.4.98; still open. Low-risk cleanup.

### 3. T1007 Sentient Tier 3 (T1009-T1012) — **NOW UNBLOCKED**
- Previously blocked on Epic A P0s (T992+T993+T995). **Those are DONE** — T1009-T1012 can start.
- T1009 agent-in-container sandbox + `--network=none`
- T1010 externally-anchored baseline + signed llmtxt/events audit (ADR-054 draft at `.cleo/agent-outputs/T947-llmtxt-v2026.4.9/ADR-054-DRAFT-signed-audit.md`)
- T1011 FF-only merge + per-step kill-switch re-check
- T1012 `cleo revert --from <receiptId>` + audit chain walker
- Maps to the OpenProse governed-execution-pipeline pattern (owner's architectural framing): thin-agent sandbox + resume tokens + signed audit + deterministic FF merge.

### 4. T990 Studio design epic — **DECOMPOSITION PENDING**
- Epic exists. 0 children. 8 research audits on disk at `.cleo/agent-outputs/T990-design-research/`:
  - brain-page-audit, code-page-audit, tasks-page-audit, memory-page-audit, dashboard-admin-audit, graph-engine-recommendation, design-system-audit, api-wiring-audit
- RCASD Decomposition Lead needs to produce wave plan. Awaiting owner approval on scope.

### 5. Known CI failure — Svelte 5 runes in vitest — **NEW TASK NEEDED**
- `packages/studio/src/lib/stores/task-filters.svelte.ts:351` — `$state is not defined`.
- CI has been red on this pre-existing issue (not a regression from this session).
- Fix: configure vitest vite.config with svelte plugin for `.svelte.ts` glob OR migrate stores to plain functions without runes.
- Memory observation `O-mo6bm8if-0` exists; **create `T-STUDIO-VITEST-FIX`** as standalone task.

### 6. Build.mjs entry-point auto-sync — **NEW TASK NEEDED**
- Proposal: auto-generate `coreBuildOptions.entryPoints` from `packages/core/package.json` subpath exports map so v2026.4.99-style broken-tarball bug can't recur.
- Memory observed with full root-cause analysis this session; no CLEO task yet.

### 7. T1013 meta-epic close-out — **HOUSEKEEPING**
- Children T1014, T1015 both `done`. Meta-epic still `pending`. Lifecycle gate may need advancement + `cleo complete T1013` with evidence.

### 8. Unpushed + uncommitted state — **CLEAN**
- `git status` should show only untracked agent-outputs/ + rcasd/ directories (local research artifacts — never committed).
- origin/main is current with all 25+ session commits.

---

## Session startup for next time

```bash
cleo session start --scope global --name "<MASTER-or-focus-name>"
cleo dash
cat .cleo/agent-outputs/NEXT-SESSION-HANDOFF.md    # this file
cleo memory find "MASTER-sentient-v2" --type observation
```

Recommended kickoff (in priority order):

1. **Apply the AGENTS.md package-boundary rule** (5 min edit) — unblocks safer spawning for everything downstream.
2. **Create T-STUDIO-VITEST-FIX** + spawn haiku Worker — unblocks green CI baseline.
3. **Close T1013 meta-epic** — housekeeping, fast.
4. **Owner decision** on next big epic:
   - T988 Wave D typed-narrowing (low-risk, cleanup, 9 children ready)
   - T1007 Tier 3 sentient sandbox/kill-switch (high-value governed-pipeline pattern, now unblocked)
   - T990 Studio redesign decomposition (8 audits ready, needs RCASD Lead)

---

## Key lessons recorded in BRAIN this session

Search with `cleo memory find "<keyword>"`:

- **Worker crash recovery**: "incorporate-prior-partial" pattern — re-dispatch with explicit "prior Worker's uncommitted work is on disk, incorporate not revert" resume prompt. Tested on T992, T1004, T1008.
- **Package boundaries**: cleo=CLI, core=SDK, contracts=types, cleo-os=harness. Workers default to existing placement even when wrong.
- **ADR-051 override patterns**: docs-only, release-formality, parallel-work-drift — legitimate emergency bypass paths.
- **Lifecycle gate ordering**: children can't complete until parent epic past decomposition. `cleo lifecycle start <epic> implementation` OR `cleo lifecycle skip <epic> <stage> --reason "<text>"`.
- **Release-task dep pruning**: prune deferred-work deps before completing release tasks (`cleo update T### --remove-depends`).
- **build.mjs ↔ package.json exports**: every subpath export in `packages/core/package.json` MUST have a matching entry in `build.mjs` `coreBuildOptions.entryPoints`. tsc emits everything; esbuild only emits registered entries. v2026.4.99 shipped broken tarball because of this gap.

---

## Architectural framing (owner's vision — keep aligned)

- **CLEO = provider-agnostic & harness-agnostic BRAIN** (SQLite + WAL, structured state backend)
- **Layering (onion)**: LLM (ephemeral) → Harness (claude-code/openhands/etc) → CLEO (persistent) → Reality (files)
- **DSL direction**: `.cantbook` playbooks = governed execution pipelines (OpenProse-style). `requires:`/`ensures:` contracts; thin agents; resume tokens; FF-only merge; kill-switch revert — T1007 Tier 3 ships the final pieces.
- **Skills vs Playbooks**: Skills = packaged know-how (progressive disclosure via ct-cleo, ct-orchestrator). Playbooks = deterministic state machines that orchestrate Skills + deterministic nodes.
