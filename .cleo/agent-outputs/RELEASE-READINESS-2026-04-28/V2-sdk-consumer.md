# V2 Validation Report — SDK Consumer Test

**Validator**: T1558
**Date**: 2026-04-28
**HEAD commit at validation start**: e4f9b4d3cc0e234dd5f1d0d8af6c7e05de725025
**Baseline reference**: v2026.4.153 (commit fd0b20b76)

## Verdict

**HOLD**

The core SDK surface is functional — all four requested namespaces (tasks, memory, conduit, sentient) import and execute correctly. However two P1 findings must be resolved before shipping: the README documents an invalid session scope format (`feature/auth`) that throws at runtime, and the `@cleocode/core/internal` path is accessible to external consumers despite STABILITY.md explicitly labeling it "MUST NOT" for third parties. These are documentation and API hygiene issues, not runtime blockers.

## Evidence

| Check | Result | Output snippet |
|-------|--------|----------------|
| Consumer project init (pnpm add tarball) | PASS | `@cleocode/core 2026.4.153` installed via tarball, `@cleocode/contracts` co-installed |
| A1: `@cleocode/core/sdk` import | PASS | `Cleo.init=function` |
| A2: `@cleocode/core/tasks` import | PASS | `addTask=function, findTasks=function` |
| A3: `@cleocode/core/sessions` import | PASS | `startSession=function, endSession=function` |
| A4: `@cleocode/core/memory` import | PASS | `observeBrain=function` (present in barrel) |
| A5: `@cleocode/core/conduit` import | PASS | `createConduit, LocalTransport, ConduitClient` all present |
| A6: `@cleocode/core/sentient` import | PASS | `getSentientDaemonStatus + sentientProposeList` present |
| A7: `@cleocode/contracts` import | PASS | 90 exports loaded |
| A8: `@cleocode/core` root barrel (BUG-2 regression check) | PASS | 329 exports — Dynamic require guard present but benign, ESM import succeeds |
| A9: `@cleocode/core/internal` exposure | PARTIAL | 1126 exports accessible. STABILITY.md says "MUST NOT" but no runtime enforcement gate |
| A10: `@cleocode/core/src/*` blocked | PASS | Correctly inaccessible from tarball |
| B1: `Cleo.init()` | PASS | Instance created |
| B2: `cleo.sessions.start({ scope: "global" })` | PASS | `session id=session-1777404525380-2b0b0d` |
| B3a: `cleo.tasks.add({ type: "epic" })` | PASS | `epic id=T001` |
| B3b: `cleo.tasks.add()` child with acceptance | PASS | `task id=T002` |
| B4: `cleo.tasks.find()` | PASS | `found 2 task(s)` |
| B5: `cleo.memory.observe()` via facade | PASS | `id=O-moj0rh7z-0, type=discovery` |
| B6: `observeBrain()` via direct subpath | PASS | `id=O-moj0rh8h-0` |
| B7: `LocalTransport` instantiation + methods | PASS | `connect/push/poll/disconnect` all present |
| B7b: `ConduitClient` prototype methods | PASS | `connect/disconnect` on prototype |
| B8: `getSentientDaemonStatus()` | PASS | `running=false, killSwitch=false, stuckCount=0, stats.{tasksPicked,tasksCompleted,...}` |
| B9: `sentientProposeList()` | PASS | returns `[]` (empty on fresh project) |
| B10: `cleo.sessions.end()` | PASS | session ended cleanly |
| C1: .d.ts present for all major subpaths | PASS | sdk→cleo.d.ts, tasks, sessions, memory, conduit, sentient, lifecycle all have index.d.ts |
| C2: TSDoc + @example in cleo.d.ts | PASS | `@example` present; types sourced from `@cleocode/contracts` |
| C3: `addTask` in tasks/index.d.ts | PASS | Present via barrel re-export `export { ..., addTask, ... } from './add.js'` |
| C4: No src/ path leaks in .d.ts | PASS | cleo.d.ts has no src/ imports |
| D1: `SessionStartParams.scope` is `string` | PASS | Confirmed in contracts source |
| D2: Session scope format docs | PARTIAL | `scope: 'task'` and `scope: 'feature/auth'` both rejected; README.md line 187 uses `scope: 'feature/auth'` which is invalid |
| E1: BUG-1 FIXED (acceptance in TasksAPI.add) | PASS | `acceptance` field present in `facade.d.ts` |
| E2: BUG-2 FIXED (root barrel ESM compat) | PASS | A8 confirmed 329 exports load without error |
| E3: BUG-3 FIXED (conduitCoreOps runtime) | PASS | `conduit/ops.js` has no runtime export of `conduitCoreOps` (type-only) |
| E4: Brain ALTER TABLE WARNs on fresh DB | PARTIAL | 9 WARNs emitted to stderr on init — self-healing, non-blocking |

**Test counts**: 28 PASS / 0 hard FAIL / 3 PARTIAL across 31 total checks

## Findings

### P0 (blocker)
_None._

### P1 (concerning)

- `/mnt/projects/cleocode/packages/core/README.md:187` — `cleo.sessions.start({ scope: 'feature/auth', name: 'auth-sprint' })` — Invalid scope format. `parseScope()` only accepts `'global'` or `'epic:T###'`. This README example will throw `CleoError: Invalid scope format: feature/auth` for any SDK consumer who copies it. Should be `'global'` or a valid epic scope.

- `/mnt/projects/cleocode/packages/core/package.json` (exports `"./internal"`) — `@cleocode/core/internal` is accessible to any npm consumer despite STABILITY.md (`STABILITY.md:46`) explicitly stating "Third-party code **MUST NOT** import from these subpaths." The path is in `exports` with no access guard. 1126 symbols are exposed. Consider moving to a `#internal` condition map (Node.js `imports` field for package-private paths) or removing from `exports` map.

### P2 (note)

- `packages/core/src/store/migration-manager.ts:762` — Fresh brain.db init emits 9 `WARN`-level structured JSON lines to stderr for `ALTER TABLE` column additions (`retrieval_order`, `delta_ms`, `stability_score`, `provenance_class` × 3, `times_derived`, `level`, `tree_id`). This is self-healing schema drift recovery, not an error, but it is noisy for SDK consumers. The DDL for these columns should be in the baseline migration rather than patched at runtime.

- `packages/core/src/sessions/index.ts:66-78` — `parseScope()` has no `'task'` or free-text scope support. This is correct behavior, but the error message (`Use 'epic:T###' or 'global'`) should be surfaced in the Cleo facade's `sessions.start()` docs/TSDoc so consumers don't have to discover it at runtime.

- `packages/core/dist/index.js` — The `Dynamic require` guard is present in the bundled root barrel but is benign — BUG-2 from the prior report (2026-04-26) is now fixed. The guard string is an artifact of the bundler but doesn't fire at runtime.

## Bug Regression Status vs. Prior Report (2026-04-26)

| Prior Bug | Status | Notes |
|-----------|--------|-------|
| BUG-1: `acceptance` missing from `TasksAPI.add` | ✅ FIXED | `acceptance?: string[]` present in `facade.d.ts` |
| BUG-2: root barrel ESM `Dynamic require` | ✅ FIXED | Root barrel imports 329 exports cleanly |
| BUG-3: `conduitCoreOps` empty runtime value | ✅ FIXED | Now type-only export, no runtime value |
| NOTE-1: `sleep-consolidation SQL error` | ✅ NOT REPRODUCED | Superseded by ALTER TABLE WARNs (P2) |
| NOTE-2: Brain ALTER TABLE WARNs | ⚠️ STILL PRESENT | 9 WARNs on stderr; non-blocking, P2 |
| NOTE-3: README `tasksAddOp` from `/tasks` | N/A | Not relevant to current test scope |
| NOTE-4: `tasks.add` requires active session | ✅ CONFIRMED EXPECTED | `sessions.start()` first, then works |

## Recommendations

- **Should v2026.4.154 ship?** HOLD — fix P1 findings first (< 30 min effort combined).

- **Pre-release fixes required (P1)**:
  1. Fix README.md line 187: change `scope: 'feature/auth'` → `scope: 'global'` (or remove the example session.start call if it's intended for a different API path).
  2. Either remove `"./internal"` from `package.json` exports map or add a runtime guard (console.warn + throw in non-internal environments). The STABILITY.md contract is not enforced today.

- **Post-release follow-up tasks**:
  - Move the 9 self-healing `ALTER TABLE` column additions into baseline migration DDL to eliminate stderr noise on fresh install (P2 quality-of-life).
  - Document the valid scope formats (`'global'`, `'epic:T###'`) in TSDoc on `sessions.start()` facade method.
  - Consider a snapshot test for the `@cleocode/core/internal` exports count so that new symbols added don't silently expand the surface.

## Test Artifacts

- Consumer directory: `/tmp/v2-sdk-consumer/` (temporary, cleaned up after test)
- Tarballs used: `/mnt/projects/cleocode/cleocode-core-2026.4.153.tgz`, `/mnt/projects/cleocode/cleocode-contracts-2026.4.153.tgz`
- Test scripts: `/tmp/v2-sdk-consumer/test.ts`, `test2.ts`, `test3.ts` (three rounds)
- Node version: v24+ (required), pnpm v10.30.0
- Consumer project: fresh `"type": "module"` package with no CLEO-adjacent dependencies
