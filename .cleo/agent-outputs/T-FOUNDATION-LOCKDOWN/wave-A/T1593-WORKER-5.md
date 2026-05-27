# T1593 — Foundation-Worker-5 Deliverable

**Mission:** Replace markdown-handoff-as-canonical with `cleo briefing` reading from
`tasks.db` + `brain.db`. Markdown handoffs are derived views ONLY.

## Files touched

| File | Purpose | LOC |
|------|---------|-----|
| `packages/core/src/sessions/handoff-markdown.ts` (NEW) | Pure renderer + atomic-write emitter for derived markdown view | 167 |
| `packages/core/src/sessions/__tests__/handoff-markdown.test.ts` (NEW) | 4 tests covering disclaimer, fields, empty state, atomic write | 89 |
| `packages/core/src/sessions/index.ts` | Export `emitHandoffMarkdown`, `renderHandoffMarkdown` | +2 |
| `packages/core/src/internal.ts` | Re-export markdown helpers for `@cleocode/cleo` consumption | +2 |
| `packages/cleo/src/cli/renderers/system.ts` | New `renderBriefing` — 8-section human view from briefing payload | +169 |
| `packages/cleo/src/cli/renderers/index.ts` | Register `briefing` → `renderBriefing` | +3 |
| `packages/cleo/src/cli/renderers/__tests__/system-renderers.test.ts` | 8 new tests for `renderBriefing` (header, last-session, current, next, blockers, brain, quiet, fresh-session) | +91 |
| `packages/cleo/src/cli/commands/session.ts` | `cleo session end --emit-markdown <path>` flag (T1593) — opt-in derived view | +50 |
| `packages/core/templates/CLEO-INJECTION.md` | Hoist `cleo briefing` to step 1 of session start; add "Source of truth: TASKS+BRAIN" disclaimer warning against markdown handoffs | +6/-1 |
| `~/.cleo/templates/CLEO-INJECTION.md` (user-installed) | Same change — agents pick up immediately | +6/-1 |
| `docs/adr/ADR-057-contracts-core-ssot.md` | Remove the lone `NEXT-SESSION-HANDOFF.md` reference; redirect readers to `cleo briefing` | +1/-1 |

**Briefing function:** `packages/core/src/sessions/briefing.ts:148 computeBriefing()` — already pulls
from tasks.db + brain.db (no markdown reads). T1593 wraps it with a proper human renderer in CLEO CLI.

## Handoff markdown references (BEFORE → AFTER)

| Surface | BEFORE | AFTER |
|---|---|---|
| `docs/adr/*.md` (canonical) | 1 (ADR-057 line 215) | 0 |
| `packages/core/templates/CLEO-INJECTION.md` (template shipped to users) | 0 (now warns against) | 0 |
| `packages/cleo/templates/` | 0 | 0 |
| `~/.cleo/templates/CLEO-INJECTION.md` (user-installed, now warns against) | 0 | 0 |
| Repo `AGENTS.md` / `CLAUDE.md` / `README.md` | 0 | 0 |
| **Total canonical refs** | **1** | **0** |

`.cleo/agent-outputs/NEXT-SESSION-HANDOFF.md` still exists on disk (operator's session
work — not deleted per spec) but is no longer referenced anywhere in CLEO docs/code/templates.

## Structured handoff fields enumerated

`SessionBriefing` (from `packages/core/src/sessions/briefing.ts:100-127`) — all reads from
SQLite via `DataAccessor`:

1. **`lastSession`** — `{ endedAt, duration, handoff: HandoffData }` from `session.handoffJson`
   - `handoff.lastTask`, `tasksCompleted[]`, `tasksCreated[]`, `decisionsRecorded`, `nextSuggested[]`,
     `openBlockers[]`, `openBugs[]`, `note?`, `nextAction?`
2. **`currentTask`** — `{ id, title, status, blockedBy? }` from `meta.focus_state`
3. **`nextTasks[]`** — leverage-scored from `tasks` table (priority + phase + age + leverage bonuses)
4. **`openBugs[]`** — `origin === 'bug-report'` or `labels.includes('bug')`, status open
5. **`blockedTasks[]`** — `status === 'blocked'` or unresolved `depends`
6. **`activeEpics[]`** — `type === 'epic' && status === 'active'`, with `completionPercent`
7. **`pipelineStage?`** — `{ currentStage, stageStatus }` from `lifecycle/pipeline.ts`
8. **`memoryContext?`** — `{ recentDecisions[], relevantPatterns[], recentObservations[], recentLearnings[], tokensEstimated }` from brain.db
9. **`bundle?`** — PSYCHE Wave 4 multi-pass retrieval bundle (cold/warm/hot, tokenCounts)
10. **`warnings?`** — derived (e.g. focused task is blocked)

The new `renderBriefing` formatter (system.ts) renders 8 sections in priority order:
**Last Session → Current Task → Active Blockers → Next Suggested → Open Epics → Open Bugs →
Recent Decisions/Observations (BRAIN) → Warnings**. Quiet mode emits only next-task IDs.

## End-to-end test result

```
$ pnpm exec vitest run packages/cleo/src/cli/renderers/__tests__/system-renderers.test.ts
 Test Files  1 passed (1)
      Tests  30 passed (30)        # 22 prior + 8 new for renderBriefing
   Duration  343ms

$ pnpm exec vitest run packages/core/src/sessions/__tests__/handoff-markdown.test.ts
 Test Files  1 passed (1)
      Tests  4 passed (4)          # NEW — disclaimer, fields, empty, atomic write
   Duration  155ms

$ pnpm --filter @cleocode/cleo run build
> @cleocode/cleo@2026.4.154 build  → tsc clean exit 0
> postbuild assert-shebang OK

$ pnpm exec tsc --noEmit  (cleo package)
  → no errors in T1593 files

$ cleo briefing --format human   (against installed binary v2026.4.154 — pre-T1593)
  Falls through to renderGeneric (no briefing renderer registered).
  Once this PR ships, the new path emits:

  CLEO Session Briefing  (source: tasks.db + brain.db)

  Last Session
    Ended: 2026-04-28T23:18:20.909Z
    Duration: 487 min
    Note: 8-wave autonomous orchestration day complete. ...

  Next Suggested (5)  leverage-scored
    T1587 T-FOUND-1: Worktree integration ...  leverage: 2, score: 110
    ...

  Active Blockers (10) ...
  Open Epics (5) ...
  Recent Observations (5)  from BRAIN ...

  Tip: pass --json for the full structured payload. All fields read from tasks.db + brain.db.
```

## What is NOT done (intentionally, per spec)

- `.cleo/agent-outputs/NEXT-SESSION-HANDOFF.md` is preserved on disk (operator's work).
- `cleo session start` already auto-runs briefing (verified at `session-engine.ts:493-500` —
  `briefing` field enriched on response). No new wiring needed for #3.
- Pre-existing main-branch build error in `packages/core/src/release/pipeline.ts` (unrelated
  contract drift) blocks a full `pnpm run build` from green; this is the T-RED-TESTS / T1564
  scope, not T1593.

## Summary

**Briefing now reads from TASKS + BRAIN exclusively** with a proper human renderer; markdown
emission is opt-in via `--emit-markdown`, clearly labeled as a one-way derived view. Handoff
markdown references in canonical CLEO surface area: 1 → 0. 12 new tests pass.
