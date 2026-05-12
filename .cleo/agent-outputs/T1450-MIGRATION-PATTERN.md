# T1450 PROOF: Session Domain SSoT Alignment — Final Pattern

**Status:** COMPLETE  
**Commits on task/T1450:** 5 total (4 prior + 1 this session)  
**Scope:** 15/15 session Core ops normalized to ADR-057 D1 uniform signature  

---

## What Was Done

All session Core functions now follow the uniform shape:

```typescript
export async function <opName>(
  projectRoot: string,
  params: <OpParams>,  // from @cleocode/contracts
): Promise<<OpResult>>
```

### Previously refactored (6 in index.ts — prior commits)
- `sessionStatus`, `startSession`, `endSession`, `resumeSession`, `listSessions`, `gcSessions`

### Refactored in this session (9 sibling files)
- `showSession` (`session-show.ts`) — was `(projectRoot, sessionId: string)`
- `findSessions` (`find.ts`) — was `(accessor: DataAccessor, params?)`
- `getDecisionLog` (`decisions.ts`) — was `(projectRoot, params?)`
- `recordDecision` (`decisions.ts`) — already `(projectRoot, params)` but used inline type
- `getContextDrift` (`session-drift.ts`) — was `(projectRoot, params?)`
- `computeBriefing` (`briefing.ts`) — was `(projectRoot, options = {})`
- `recordAssumption` (`assumptions.ts`) — already `(projectRoot, params)` but used inline type
- `suspendSession` (`session-suspend.ts`) — was `(projectRoot, sessionId, reason?)`
- `sessionHandoffShow` (`handoff.ts`) — NEW normalized wrapper over `getLastHandoff`

---

## BEFORE/AFTER: Representative End-to-End Trace

### Core Layer (`session-show.ts`)

**BEFORE:**
```typescript
export async function showSession(projectRoot: string, sessionId: string): Promise<Session>
```

**AFTER:**
```typescript
import { ExitCode, type SessionShowParams } from '@cleocode/contracts';

export async function showSession(
  projectRoot: string,
  params: SessionShowParams,  // { sessionId: string; include?: string }
): Promise<Session>
// Body: sessions.find(s => s.id === params.sessionId)
```

### Engine Layer (`session-engine.ts`)

**BEFORE:**
```typescript
export async function sessionShow(
  projectRoot: string,
  sessionId: string,
): Promise<EngineResult<Session>> {
  const result = await showSession(projectRoot, sessionId);  // ← positional
  ...
}
```

**AFTER:**
```typescript
export async function sessionShow(
  projectRoot: string,
  sessionId: string,
): Promise<EngineResult<Session>> {
  const result = await showSession(projectRoot, { sessionId });  // ← params object
  ...
}
```

Note: Engine outer signature stays positional (still `sessionId: string`) because dispatch
already calls it as `sessionShow(projectRoot, params.sessionId)`. The engine is the
acknowledged intermediate layer per ADR-057 D4 — it translates dispatch's extracted fields
into Core's params objects.

### Dispatch Layer (`domains/session.ts`)

No changes needed — dispatch already extracts typed params via `SessionOps` contract and
passes them to engine wrappers. The handler was already thin.

---

## Gotchas Encountered

### 1. `findSessions` took an `accessor` as first arg, not `projectRoot`
**Old:** `findSessions(accessor: DataAccessor, params?)` — the old test injected a mock directly.  
**Fix:** Changed to `findSessions(projectRoot: string, params?)` — now calls `getAccessor(projectRoot)` internally.  
**Test fix:** Updated `session-find.test.ts` to `vi.mock('../../store/data-accessor.js')` and use `vi.mocked(getAccessor).mockResolvedValue(...)`.

### 2. `sed -i` for bulk rename caused collateral damage
Used `sed -i 's/options\./params./g'` on `briefing.ts` — this also replaced `options.` inside inner
helper functions (`computeNextTasks`, `computeOpenBugs`, etc.) that still had `options` as their
local parameter name.  
**Fix:** Manually restored `options.` references inside inner helper bodies.  
**Lesson:** Never use global `sed` replacement across function boundaries.

### 3. Tests called the old positional API
Four test files used the old `startSession({ ... }, tempDir)` positional API. After Core
normalization, calls must be `startSession(tempDir, { ... })`.  
**Fix:** Updated `sessions.test.ts`, `session-edge-cases.test.ts`, `index.test.ts`, `session-find.test.ts`.

### 4. `endSession` never supported `sessionId` targeting
One test `endSession({ sessionId: s1.id }, tempDir)` assumed the old `endSession` found a session
by ID. The new (and old) Core `endSession` always ends the most-recent active session.  
**Fix:** Updated test to reflect actual behavior — ends the most recent active session.

### 5. `briefing.ts` had inline `BriefingOptions` type
The inner type was compatible with `SessionBriefingShowParams` but was defined inline.  
**Fix:** Made `BriefingOptions = SessionBriefingShowParams` (deprecated alias for backcompat) and
renamed the main function's parameter from `options` to `params`.

### 6. `handoff.show` requires scope-string parsing
`SessionHandoffShowParams.scope` is a string (`'global'` or `'epic:T001'`). The underlying
`getLastHandoff` takes `scope: { type, epicId? }`.  
**Fix:** Added `sessionHandoffShow(projectRoot, params: SessionHandoffShowParams)` as a new
normalized wrapper in `handoff.ts` that does the string-to-object conversion, then delegates
to `getLastHandoff`.

---

## Step-by-Step Recipe for T1451-T1458 Workers

### Before starting
1. `grep -rn "<domain>" packages/core/src/<domain>/ --include="*.ts"` — enumerate all exported fns  
2. For each fn: check if already `(projectRoot, params: <Op>Params)` shape. If yes, skip.  
3. Run `cleo gitnexus impact <fnName>` to verify blast radius is LOW.

### For each Core function
1. Add `import { type <Op>Params } from '@cleocode/contracts'` — use the existing contract type  
2. Change signature: `async function foo(projectRoot: string, params: <Op>Params)`  
3. Update body: replace positional arg refs with `params.fieldName`  
4. If the fn had optional params (`params?`), make it required, pass `{}` at all callsites  
5. Export deprecated aliases for old type names if they were exported publicly  

### For each engine wrapper (if domain has one)
Update the `await coreFn(...)` call to pass `{ fieldName: positionalArg }` params object.
The engine outer signature can stay positional if dispatch already unpacks params to fields.

### For dispatch handler
Usually no changes needed if it already calls engine wrappers. Verify it's a thin layer:
- Gets `projectRoot = getProjectRoot()`  
- Calls engine fn  
- Returns `lafsSuccess(result.data, op)` or `lafsError(...)`

### For Cleo facade (`cleo.ts`)
Update the facade method body to pass `projectRoot` as first arg and wrap params in an object.
Example: `find: (p) => findSessions((await getAccessor(root)), p)` → `find: (p) => findSessions(root, p)`.

### For tests
Tests that mock accessors directly must now mock `getAccessor`:
```typescript
vi.mock('../../store/data-accessor.js', () => ({ getAccessor: vi.fn() }));
import { getAccessor } from '../../store/data-accessor.js';
// In test: vi.mocked(getAccessor).mockResolvedValue(mockAccessor(sessions));
```

Tests that call Core fns with old positional API must update to `(projectRoot, { ...params })`.

### Quality gates
```bash
pnpm biome check --write .
pnpm run build              # must exit 0
pnpm run test               # zero new failures vs main
git diff --stat HEAD
```

---

## Key Files Modified (T1450 Complete)

| File | Change |
|------|--------|
| `packages/core/src/sessions/index.ts` | 6 Core fns + export sessionHandoffShow |
| `packages/core/src/sessions/session-show.ts` | showSession normalized |
| `packages/core/src/sessions/find.ts` | findSessions normalized, drop accessor arg |
| `packages/core/src/sessions/decisions.ts` | recordDecision, getDecisionLog normalized |
| `packages/core/src/sessions/session-drift.ts` | getContextDrift normalized |
| `packages/core/src/sessions/briefing.ts` | computeBriefing normalized |
| `packages/core/src/sessions/assumptions.ts` | recordAssumption normalized |
| `packages/core/src/sessions/session-suspend.ts` | suspendSession normalized |
| `packages/core/src/sessions/handoff.ts` | sessionHandoffShow added |
| `packages/core/src/cleo.ts` | Facade updated for new Core APIs |
| `packages/cleo/src/dispatch/engines/session-engine.ts` | Engine calls updated |
| 4 test files | Updated to new API |

---

## What T1451-T1458 Workers Should Reuse vs Session-Specific

| Pattern | Reusable? | Notes |
|---------|-----------|-------|
| `(projectRoot, params: <Op>Params)` Core signature | YES | Universal |
| Import types from `@cleocode/contracts` | YES | Universal |
| Deprecated alias type exports | YES | For backcompat where old names exported |
| `vi.mock` accessor for unit tests | YES | For test files that mock accessor directly |
| `sessionHandoffShow` wrapper pattern | DOMAIN-SPECIFIC | Needed when wire params need conversion |
| `computeBriefing` inner helper bug | LESSON | Use targeted sed or manual edit, not global |

---

## References

- **Audit**: `.cleo/agent-outputs/T1449-CORE-API-AUDIT.md` (decisions, baseline)
- **Contract SSoT**: `packages/contracts/src/operations/session.ts`
- **ADR-057**: docs/adr/ADR-057-core-api-normalization.md (D1 uniform signature, D4 engine layer)
- **OpsFromCore helper**: `packages/cleo/src/dispatch/adapters/typed.ts`
