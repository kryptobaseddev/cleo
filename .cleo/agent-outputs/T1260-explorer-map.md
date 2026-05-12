# T1260 Explorer Map — PSYCHE E3 Memory-Substrate → Spawn Wiring
Generated: 2026-04-24 (read-only deep-mapping pass)

## 1. Symbol Resolution (Council-mandated grep results)

### composeSpawnPayload
- **File:line**: `packages/core/src/orchestration/spawn.ts:360`
- **Signature**: `async function composeSpawnPayload(db: DatabaseSync, task: Task, options: ComposeSpawnPayloadOptions = {}): Promise<SpawnPayload>`
- **Status**: EXISTS. Does NOT call `buildRetrievalBundle`. No memory context in the current payload.

### buildRetrievalBundle
- **File:line**: `packages/core/src/memory/brain-retrieval.ts:1918`
- **Signature**: `async function buildRetrievalBundle(req: RetrievalRequest, projectRoot: string): Promise<RetrievalBundle>`
- **Status**: EXISTS. Fully implemented. Only one call site: `briefing.ts:215-235`.

### grep summary (Council's first concrete action)
- `packages/core/src/sessions/briefing.ts`: `buildRetrievalBundle` imported at line 215 (dynamic `await import()`), called at line 227.
- `packages/core/src/orchestration/spawn.ts`: Neither `buildRetrievalBundle` nor a self-reference to `composeSpawnPayload` exists at import level. `composeSpawnPayload` is defined starting line 360.
- `packages/core/src/orchestration/__tests__/`: `spawn-retrieval-parity.test.ts` does NOT exist. `spawn.test.ts` exists. `spawn-prompt.test.ts` exists.

## 2. buildRetrievalBundle Surface

### Full path
`/mnt/projects/cleocode/packages/core/src/memory/brain-retrieval.ts`

### Exported signature
```ts
export async function buildRetrievalBundle(
  req: import('@cleocode/contracts').RetrievalRequest,
  projectRoot: string,
): Promise<import('@cleocode/contracts').RetrievalBundle>
```

### RetrievalRequest (contracts)
`packages/contracts/src/operations/memory.ts:1066`:
```ts
interface RetrievalRequest {
  peerId: string;
  sessionId: string;
  query?: string;
  passMask?: PassMask;  // { cold, warm, hot: boolean }
  tokenBudget?: number; // default 4000
}
```

### RetrievalBundle (contracts)
`packages/contracts/src/operations/memory.ts:1178`:
```ts
interface RetrievalBundle {
  cold: { userProfile: UserProfileTrait[]; peerInstructions: string; };
  warm: { peerLearnings: RetrievalLearning[]; peerPatterns: RetrievalPattern[]; decisions: RetrievalDecision[]; };
  hot: { sessionNarrative: string; recentObservations: RetrievalObservation[]; activeTasks: RetrievalActiveTask[]; };
  tokenCounts: RetrievalTokenCounts; // { cold, warm, hot, total }
}
```

### Current call site
Only one: `packages/core/src/sessions/briefing.ts:215-235`
```ts
const { buildRetrievalBundle } = await import('../memory/brain-retrieval.js');
bundle = await buildRetrievalBundle(
  { peerId: activePeerId, sessionId: activeSessionId, passMask: { cold: true, warm: true, hot: true } },
  projectRoot,
);
```

### Token budget
Default 4000 tokens; split 20% cold / 50% warm / 30% hot. `tokenCounts` field carries per-pass and total accounting. Budget enforcement trims hot first (observations, then tasks), then cold.

## 3. briefing.ts Retrieval Path — Structural Equivalence Benchmark

`computeBriefing` at `packages/core/src/sessions/briefing.ts:151`:
1. Resolves `activeSessionObj` via `accessor.getActiveSession()` (line 219).
2. Extracts `activeSessionId = activeSessionObj?.id ?? ''` and `activePeerId = (... activePeerId as string) ?? 'global'` (lines 222-225).
3. Guards on `if (activeSessionId)` before calling (line 226).
4. Calls `buildRetrievalBundle({ peerId: activePeerId, sessionId: activeSessionId, passMask: { cold: true, warm: true, hot: true } }, projectRoot)`.
5. Catches all errors silently — bundle is `undefined` when any error occurs.
6. Returns the bundle as `SessionBriefing.bundle?: RetrievalBundle`.

**For M1 parity test**: E3 must supply same three IDs (sessionId, peerId, personaId). PersonaId not currently threaded — T1260 decides whether to add as `query` parameter or extend `RetrievalRequest`.

**Shape for structural assertion**: a valid bundle has `cold.userProfile` (array), `cold.peerInstructions` (string), `warm.peerLearnings` (array), `warm.peerPatterns` (array), `warm.decisions` (array), `hot.sessionNarrative` (string), `hot.recentObservations` (array), `hot.activeTasks` (array), `tokenCounts.total` (number > 0 when any data retrieved).

## 4. spawn.ts Payload Assembly — Injection Point for PSYCHE-MEMORY

### Current section order in buildSpawnPrompt (spawn-prompt.ts:1106-1138)
1. buildHeader()
2. buildTaskIdentity()
3. buildReturnFormatBlock()
4. buildManifestProtocolBlock()
5. buildSessionBlock()
6. [conditional] buildWorktreeSetupBlock() ← worktreePath guard
7. [conditional] buildConduitSubscriptionBlock() ← tier >= 1 + conduitSubscription guard
8. buildFilePathsBlock()
9. buildStageGuidance()
10. buildEvidenceGateBlock()
11. buildQualityGateBlock()
12. [tier-specific] protocol pointer / CLEO-INJECTION embed / skill excerpts

### Natural injection point
Between position 7 (CONDUIT) and position 8 (File Paths), at `spawn-prompt.ts:1135`:
```ts
if (tier >= 1 && input.retrievalBundle) {
  authoredSections.push(buildPsycheMemoryBlock(input.retrievalBundle));
}
authoredSections.push(buildFilePathsBlock(...));
```

Mirrors the CONDUIT pattern exactly. `BuildSpawnPromptInput` interface needs new optional field `retrievalBundle?: RetrievalBundle`.

### composeSpawnPayload wiring location (spawn.ts)
Between step 6b (thin-agent enforcement, line 467) and step 7 (buildSpawnPrompt call, line 474). New step 6c:
```ts
let retrievalBundle: RetrievalBundle | undefined;
if (options.sessionId && options.projectRoot) {
  try {
    const { buildRetrievalBundle } = await import('../memory/brain-retrieval.js');
    retrievalBundle = await buildRetrievalBundle(
      { peerId: options.peerId ?? 'global', sessionId: options.sessionId, passMask: { cold: true, warm: true, hot: true } },
      projectRoot,
    );
  } catch { /* best-effort */ }
}
```

### ComposeSpawnPayloadOptions additions needed
- `sessionId?: string | null` — already exists (line 117)
- `peerId?: string` — does NOT exist yet
- `personaId?: string` — may be needed for M6 provenanceClass filtering

## 5. provenanceClass Field Analysis

### Current state
- `packages/core/src/store/memory-schema.ts` — NO `provenanceClass` column in `brainDecisions`, `brainPatterns`, `brainLearnings`, `brainObservations`.
- `packages/contracts/src/operations/memory.ts` — NO `provenanceClass` field on any Retrieval* type.

### Package-boundary placement (per AGENTS.md)
- **Type definition**: `packages/contracts/src/operations/memory.ts` — add `provenanceClass?: string` to all four Retrieval* item types; define literal `'unswept-pre-T1151' | 'swept' | 'owner-verified'`.
- **Column**: `packages/core/src/store/memory-schema.ts` — add `provenanceClass` text column to all four brain tables, default `'unswept-pre-T1151'`.
- **Drizzle migration**: `pnpm --filter @cleocode/core run db:generate` produces a new migration. Keep timestamp; do not delete-regenerate (Lesson 3).
- **buildRetrievalBundle**: `fetchPeerMemory` and `fetchSessionState` raw SQL must `SELECT provenance_class AS provenanceClass`.
- **Refusal logic**: filter entries where `provenanceClass === 'unswept-pre-T1151'`. Return refused count in `meta.refusedCount` or log.

## 6. M1 Test Scaffold — spawn-retrieval-parity.test.ts

### Directory
`packages/core/src/orchestration/__tests__/` — EXISTS. Contains `spawn.test.ts` (composeSpawnPayload), `spawn-prompt.test.ts` (buildSpawnPrompt).

### New file path
`packages/core/src/orchestration/__tests__/spawn-retrieval-parity.test.ts`

### Test conventions (from adjacent files)
```ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
// describe('...') → beforeEach(async () => { vi.resetModules(); env = await makeTmpEnv(...); })
// → afterEach(() => { env.cleanup(); vi.restoreAllMocks(); })
```

### Red test shape (Council M1 mandate — do NOT modify spawn.ts yet for the RED stage)
```ts
import { composeSpawnPayload } from '../spawn.js';

it('composeSpawnPayload tier-1 prompt contains PSYCHE-MEMORY section', async () => {
  const payload = await composeSpawnPayload(db, task, { tier: 1, sessionId: 'ses_test', ... });
  expect(payload.prompt).toContain('## PSYCHE-MEMORY');  // RED until E3 wires
});

it('composeSpawnPayload retrievalBundle structurally matches briefing-path bundle', async () => {
  const briefingBundle = await buildRetrievalBundle({ peerId: 'global', sessionId: 'ses_test', passMask: { cold: true, warm: true, hot: true } }, projectRoot);
  const payload = await composeSpawnPayload(db, task, { tier: 1, sessionId: 'ses_test', ... });
  expect(payload.retrievalBundle).toBeDefined();
  expect(Object.keys(payload.retrievalBundle.cold)).toEqual(Object.keys(briefingBundle.cold));
  expect(Object.keys(payload.retrievalBundle.warm)).toEqual(Object.keys(briefingBundle.warm));
  expect(Object.keys(payload.retrievalBundle.hot)).toEqual(Object.keys(briefingBundle.hot));
});
```

## 7. Atomic Decomposition Proposal (5 workers under T1260)

| # | Title | Size | File paths | Acceptance |
|---|-------|------|-----------|------------|
| T1260-W1 | provenanceClass schema + contract | small | `packages/contracts/src/operations/memory.ts`, `packages/core/src/store/memory-schema.ts`, Drizzle migration | Column exists in all 4 brain tables; contract type exported; `pnpm run db:check` green |
| T1260-W2 | fetchPeerMemory + fetchSessionState emit provenanceClass | small | `packages/core/src/memory/brain-retrieval.ts:1663-1799,1813-1885` | SQL queries SELECT provenance_class; types carry provenanceClass field |
| T1260-W3 | buildRetrievalBundle M6 refusal gate | small | `packages/core/src/memory/brain-retrieval.ts:1918-2060` | Entries with provenanceClass='unswept-pre-T1151' filtered before return; refusedCount tracked |
| T1260-W4 | composeSpawnPayload + buildSpawnPrompt PSYCHE-MEMORY wiring | medium | `packages/core/src/orchestration/spawn.ts:360-524`, `packages/core/src/orchestration/spawn-prompt.ts:1103-1183` | composeSpawnPayload calls buildRetrievalBundle; tier-1 prompt contains `## PSYCHE-MEMORY` section; SpawnPayload carries retrievalBundle field |
| T1260-W5 | spawn-retrieval-parity.test.ts green + M4 primitive registration | small | `packages/core/src/orchestration/__tests__/spawn-retrieval-parity.test.ts` (new), `packages/core/src/memory/brain-retrieval.ts` (re-export) | Test green; buildRetrievalBundle re-exported from canonical injection-primitives index; `pnpm run test` zero new failures |

Ordering: W1 → W2 → W3 (all in brain-retrieval.ts + schema, can be one worker). W4 depends on W1 for types. W5 depends on W4.

## 8. Risk Callouts

### Risk 1: Token budget at assembly — no per-entry token counts
RetrievalLearning/Pattern/Decision contracts carry only `id`, content, timestamp. No `tokensEstimated`. Bundle's `tokenCounts` is total/per-pass, not per-entry. If E3 serializes individual entries to `## PSYCHE-MEMORY` markdown, must re-estimate inline (`Math.ceil(text.length / 4)`). The bundle is already trimmed, so prompt builder must NOT expand. Mitigation: include `tokenCounts.total` in metadata line.

### Risk 2: provenanceClass requires Drizzle migration — preserve timestamp
Per Lesson 3: deleting and regenerating produces a new timestamp; existing journal rejects the new folder. T1260-W1 must keep timestamp from initial `db:generate`. Replace contents only if necessary; do NOT delete folder.

### Risk 3: peerId not in ComposeSpawnPayloadOptions
Currently no `peerId` parameter. CONDUIT (T1253) passed via `conduitSubscription.peerId`. For E3, add `peerId?: string` to ComposeSpawnPayloadOptions or derive from `options.agentId` via registry. Default `'global'` with override.

### Risk 4: skills[] AC not yet addressed
T1260 AC#3 says "skills[] resolves to skill excerpts embedded in spawn prompt." Current `buildSpawnPrompt` loads skills via hardcoded `loadSkillExcerpt('ct-cleo', ...)` calls. AC implies dynamic resolution from agent's CANT `skills[]` array. Requires passing `resolvedAgent.skills` into `buildSpawnPrompt` and dynamic loading. Non-trivial scope addition to W4.

### Risk 5: M6 provenanceClass refusal is a soft gate until W7 sweep
With default `'unswept-pre-T1151'` on all rows, M6 refusal will refuse ALL warm/hot entries until W7 (.132) runs the 2440-entry sweep. Correct behavior per Council (prevents Sentient v1 reading unswept) but `## PSYCHE-MEMORY` will be EMPTY for every existing BRAIN entry until .132 ships. Refusal logic should LOG refusedCount so caller emits warning, not silent empty bundle.

## 9. File Reference Index

| File | Role |
|------|------|
| `packages/core/src/orchestration/spawn.ts` | composeSpawnPayload — entry point for E3 wiring |
| `packages/core/src/orchestration/spawn-prompt.ts` | buildSpawnPrompt — injection point at line 1132 |
| `packages/core/src/memory/brain-retrieval.ts` | buildRetrievalBundle (1918), fetchIdentity (1628), fetchPeerMemory (1663), fetchSessionState (1813) |
| `packages/core/src/sessions/briefing.ts` | Structural benchmark for M1 parity — lines 212-238 |
| `packages/contracts/src/operations/memory.ts` | RetrievalBundle (1178), RetrievalRequest (1066), all Retrieval* types |
| `packages/core/src/store/memory-schema.ts` | Drizzle schema — no provenanceClass yet |
| `packages/core/src/orchestration/__tests__/spawn.test.ts` | Test conventions benchmark |
| `packages/core/src/orchestration/__tests__/spawn-retrieval-parity.test.ts` | TO BE CREATED (M1 gate) |
| `packages/contracts/src/index.ts` | RetrievalBundle re-exported at line 450-460 |
