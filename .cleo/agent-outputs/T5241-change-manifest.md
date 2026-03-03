# T5241 Change Manifest — Old Operation Name References

**Generated**: 2026-03-03
**Status**: COMPLETE (research only, no code changes)
**Scope**: All files in `src/`, `tests/`, `docs/` containing old operation names to be renamed

---

## Summary of Changes Required

The refactoring has 4 types of changes:
1. **Operation string renames** — `brain.search` → `find`, `pattern.search` → `pattern.find`, etc.
2. **Function renames** — `memoryBrainSearch` → `memoryFind`, etc.
3. **Domain migrations** — `manifest.*` from memory → pipeline, `inject` from memory → session
4. **Documentation updates** — specs, guides, INJECTION.md, VERB-STANDARDS, vision.md

---

## Layer 1: Operation Strings — Registry (`src/dispatch/registry.ts`)

### Lines with old operation names:

| Line | Current `operation` value | New `operation` value | Notes |
|------|--------------------------|----------------------|-------|
| 470 | `manifest.read` | `manifest.show` (or stays in pipeline domain) | domain change: memory → pipeline |
| 471 | description: `memory.manifest.read (query)` | update description | |
| 501 | `pattern.search` | `pattern.find` | verb rename |
| 502 | description: `memory.pattern.search ...` | update description | |
| 521 | `learning.search` | `learning.find` | verb rename |
| 522 | description: `memory.learning.search ...` | update description | |
| 542 | `brain.search` | `find` | flatten brain. prefix |
| 543 | description: `memory.brain.search ...` | update description | |
| 552 | `brain.timeline` | `timeline` | flatten brain. prefix |
| 553 | description: `memory.brain.timeline ...` | update description | |
| 562 | `brain.fetch` | `fetch` | flatten brain. prefix |
| 563 | description: `memory.brain.fetch ...` | update description | |
| 1271 | `inject` (domain: memory) | remove from memory; add to session as `context.inject` | domain migration |
| 1272 | description: `memory.inject (mutate)` | new entry in session domain | |
| 1291 | `manifest.append` (domain: memory) | remove; add to pipeline domain | domain migration |
| 1292 | description: `memory.manifest.append (mutate)` | new entry in pipeline domain | |
| 1301 | `manifest.archive` (domain: memory) | remove; add to pipeline domain | domain migration |
| 1302 | description: `memory.manifest.archive (mutate)` | new entry in pipeline domain | |
| 1332 | `brain.observe` (domain: memory) | `observe` | flatten brain. prefix |
| 1333 | description: `memory.brain.observe (mutate)...` | update description | |

---

## Layer 2: Memory Domain Handler (`src/dispatch/domains/memory.ts`)

### Import removals/renames (lines 19-43):

| Line | Current Import | New Import | Action |
|------|---------------|-----------|--------|
| 19 | `memoryShow` | unchanged | stays |
| 20 | `memoryList` | unchanged | stays |
| 21 | `memoryQuery` | unchanged | stays |
| 22 | `memoryPending` | unchanged | stays |
| 23 | `memoryStats` | unchanged | stays (but switches to brain.db backing) |
| 24 | `memoryManifestRead` | remove | moves to pipeline domain |
| 27 | `memoryInject` | remove | moves to session domain |
| 29 | `memoryManifestAppend` | remove | moves to pipeline domain |
| 30 | `memoryManifestArchive` | remove | moves to pipeline domain |
| 33 | `memoryPatternSearch` | `memoryPatternFind` (rename) | verb rename |
| 36 | `memoryLearningSearch` | `memoryLearningFind` (rename) | verb rename |
| 39 | `memoryBrainSearch` | `memoryFind` (rename) | flatten + rename |
| 40 | `memoryBrainTimeline` | `memoryTimeline` (rename) | flatten + rename |
| 41 | `memoryBrainFetch` | `memoryFetch` (rename) | flatten + rename |
| 42 | `memoryBrainObserve` | `memoryObserve` (rename) | flatten + rename |

### Case handler renames/removals (in `query()` method):

| Current case | Action | New case |
|-------------|--------|---------|
| `case 'manifest.read':` (line 108) | REMOVE → move to pipeline | — |
| `case 'pattern.search':` (line 127) | RENAME | `case 'pattern.find':` |
| `case 'learning.search':` (line 146) | RENAME | `case 'learning.find':` |
| `case 'brain.search':` (line 166) | RENAME | `case 'find':` |
| `case 'brain.timeline':` (line 184) | RENAME | `case 'timeline':` |
| `case 'brain.fetch':` (line 200) | RENAME | `case 'fetch':` |

### Case handler renames/removals (in `mutate()` method):

| Current case | Action | New case |
|-------------|--------|---------|
| `case 'inject':` (line 229) | REMOVE → move to session | — |
| `case 'manifest.append':` (line 252) | REMOVE → move to pipeline | — |
| `case 'manifest.archive':` (line 261) | REMOVE → move to pipeline | — |
| `case 'brain.observe':` (line 314) | RENAME | `case 'observe':` |

### Valid operation arrays (lines 347-348):

```
line 347: query: ['show', 'list', 'find', 'pending', 'stats', 'manifest.read', 'contradictions', 'superseded', 'pattern.search', 'pattern.stats', 'learning.search', 'learning.stats', 'brain.search', 'brain.timeline', 'brain.fetch'],
```
→ Replace with:
```
query: ['show', 'list', 'find', 'pending', 'stats', 'contradictions', 'superseded', 'pattern.find', 'pattern.stats', 'learning.find', 'learning.stats', 'find', 'timeline', 'fetch'],
```
Note: dedupe required — `find` appears twice. Confirm canonical list.

```
line 348: mutate: ['inject', 'link', 'manifest.append', 'manifest.archive', 'pattern.store', 'learning.store', 'brain.observe'],
```
→ Replace with:
```
mutate: ['link', 'pattern.store', 'learning.store', 'observe'],
```

---

## Layer 3: Engine Compat (`src/core/memory/engine-compat.ts`)

### Function export renames:

| Line | Current name | New name | Notes |
|------|-------------|---------|-------|
| 618 | `memoryPatternSearch(` | `memoryPatternFind(` | verb rename |
| 659 | `memoryLearningSearch(` | `memoryLearningFind(` | verb rename |
| 750 | `memoryBrainSearch(` | `memoryFind(` | flatten + rename |
| 770 | `memoryBrainTimeline(` | `memoryTimeline(` | flatten + rename |
| 788 | `memoryBrainFetch(` | `memoryFetch(` | flatten + rename |
| 802 | `memoryBrainObserve(` | `memoryObserve(` | flatten + rename |

### JSDoc comment updates:

| Line | Current comment | New comment |
|------|----------------|------------|
| 496 | `/** memory.inject - Read protocol injection content */` | `/** session.context.inject — Read protocol injection content */` |
| 617 | `/** memory.pattern.search - Search patterns in BRAIN memory */` | `/** memory.pattern.find - Search patterns in BRAIN memory */` |
| 658 | `/** memory.learning.search - Search learnings in BRAIN memory */` | `/** memory.learning.find - Search learnings in BRAIN memory */` |
| 749 | `/** memory.brain.search - Token-efficient brain search */` | `/** memory.find - Token-efficient brain search */` |
| 769 | `/** memory.brain.timeline - Chronological context around anchor */` | `/** memory.timeline - Chronological context around anchor */` |
| 787 | `/** memory.brain.fetch - Batch fetch brain entries by IDs */` | `/** memory.fetch - Batch fetch brain entries by IDs */` |
| 801 | `/** memory.brain.observe - Save observation to brain */` | `/** memory.observe - Save observation to brain */` |

### Functions to MOVE out (inject → session, manifest.* → pipeline):

- Line 274: `memoryManifestRead` → caller in `src/dispatch/domains/pipeline.ts` (or new pipeline-manifest-engine.ts)
- Line 325: `memoryManifestAppend` → same
- Line 361: `memoryManifestArchive` → same
- Line 496: `memoryInject` → caller in `src/dispatch/domains/session.ts`

These functions may stay in engine-compat.ts but will be re-exported from their new domain handlers, OR moved to new engine files. The function body logic doesn't change, just where they're called from.

---

## Layer 4: Engine Barrel (`src/dispatch/lib/engine.ts`)

### Lines with old aliases (lines 204-223):

```typescript
// Memory engine (formerly research-engine)
export {
  memoryShow as researchShow,           // line 206 — alias "researchShow" must change to "memoryShow" or remove alias
  memoryList as researchList,           // line 207
  memoryQuery as researchQuery,         // line 208
  memoryPending as researchPending,     // line 209
  memoryStats as researchStats,         // line 210
  memoryManifestRead as researchManifestRead,   // line 211 — REMOVE (moves to pipeline)
  memoryLink as researchLink,           // line 212
  memoryManifestAppend as researchManifestAppend,  // line 213 — REMOVE (moves to pipeline)
  memoryManifestArchive as researchManifestArchive, // line 214 — REMOVE (moves to pipeline)
  memoryContradictions as researchContradictions,  // line 215
  memorySuperseded as researchSuperseded,  // line 216
  memoryInject as researchInject,       // line 217 — REMOVE (moves to session)
  memoryCompact as researchCompact,     // line 218
  memoryValidate as researchValidateOp, // line 219
  readManifestEntries,                  // line 220
  filterEntries as filterManifestEntries, // line 221
  type ManifestEntry as ResearchManifestEntry, // line 222
} from '../../core/memory/engine-compat.js';
```

**Required renames**: `memoryPatternSearch` → `memoryPatternFind`, `memoryBrainSearch` → `memoryFind`, `memoryBrainTimeline` → `memoryTimeline`, `memoryBrainFetch` → `memoryFetch`, `memoryBrainObserve` → `memoryObserve`

**Remove exports**: `researchManifestRead`, `researchManifestAppend`, `researchManifestArchive`, `researchInject`

---

## Layer 5: MCP Gateways (`src/mcp/gateways/`)

### `mutate.ts`:

| Line | Current content | Change |
|------|----------------|--------|
| 572 | `case 'inject':` (in `validateResearchParams`) | rename to `case 'context.inject':` or remove from memory domain validator |
| 579 | `domain: 'research'` | update to `domain: 'session'` for inject |
| 622 | `case 'manifest.append':` | remove from memory/research; add to pipeline domain |

### `__tests__/mutate.test.ts`:

| Line | Current content | Change |
|------|----------------|--------|
| 318 | `operation: 'inject'` | → `operation: 'context.inject'` (in session domain) |
| 339 | `it('should reject manifest.append without entry'...` | update test description |
| 342 | `operation: 'manifest.append'` | → test in pipeline domain |

### `__tests__/query.test.ts`:

| Line | Current content | Change |
|------|----------------|--------|
| 326 | `it('should support manifest.read operation'...)` | update for pipeline domain |
| 327 | `expect(researchOps).toContain('manifest.read')` | → `expect(pipelineOps).toContain('manifest.show')` |

---

## Layer 6: Protocol Enforcement (`src/mcp/lib/`)

### `protocol-enforcement.ts`:

| Line | Current content | Change |
|------|----------------|--------|
| 324 | `'research.manifest.append'` | → `'pipeline.manifest.append'` |

### `PROTOCOL-ENFORCEMENT.md`:

| Line | Current content | Change |
|------|----------------|--------|
| 177 | `research.manifest.append` | → `pipeline.manifest.append` |

---

## Layer 7: Capability Matrix (`src/dispatch/lib/capability-matrix.ts`)

| Line | Current entry | Change |
|------|--------------|--------|
| 194 | `{ domain: 'research', operation: 'manifest.read', ...}` | → `{ domain: 'pipeline', operation: 'manifest.show', ...}` |
| 197 | `{ domain: 'research', operation: 'inject', ...}` | → `{ domain: 'session', operation: 'context.inject', ...}` |
| 199 | `{ domain: 'research', operation: 'manifest.append', ...}` | → `{ domain: 'pipeline', operation: 'manifest.append', ...}` |
| 200 | `{ domain: 'research', operation: 'manifest.archive', ...}` | → `{ domain: 'pipeline', operation: 'manifest.archive', ...}` |

---

## Layer 8: CLI Commands (`src/cli/commands/`)

### `research.ts`:

| Line | Current content | Change |
|------|----------------|--------|
| 23 | `dispatchFromCli('mutate', 'memory', 'inject', ...)` | → `dispatchFromCli('mutate', 'session', 'context.inject', ...)` |
| 73 | `dispatchFromCli('mutate', 'memory', 'inject', ...)` | → `dispatchFromCli('mutate', 'session', 'context.inject', ...)` |
| 100 | `dispatchFromCli('mutate', 'memory', 'manifest.archive', ...)` | → `dispatchFromCli('mutate', 'pipeline', 'manifest.archive', ...)` |
| 112 | `dispatchFromCli('query', 'memory', 'manifest.read', ...)` | → `dispatchFromCli('query', 'pipeline', 'manifest.show', ...)` |

### `inject.ts`:

| Line | Current content | Change |
|------|----------------|--------|
| 12 | `.command('inject')` | Evaluate: keep CLI command name `inject` but route to `session context.inject` |
| 28 | `dispatchFromCli(... 'inject' ...)` | update dispatch call |

---

## Layer 9: Types (`src/types/operations/research.ts`)

| Line | Current comment | Change |
|------|----------------|--------|
| 89 | `// research.manifest.read` | → `// pipeline.manifest.show` |
| 125 | `// research.manifest.append` | → `// pipeline.manifest.append` |
| 136 | `// research.manifest.archive` | → `// pipeline.manifest.archive` |

---

## Layer 10: MCP Integration Setup (`src/mcp/__tests__/integration-setup.ts`)

| Line | Current content | Change |
|------|----------------|--------|
| 179 | `'manifest.append': 'research add'` | → `'manifest.append': 'research add'` (check if pipeline still maps to same CLI) |
| 180 | `'manifest.read': 'research list'` | → update domain reference |
| 181 | `'manifest.archive': 'research archive'` | → update domain reference |

---

## Layer 11: MCP E2E Tests (`src/mcp/__tests__/e2e/research-workflow.test.ts`)

| Line | Current content | Change |
|------|----------------|--------|
| 135 | `// The CLI archive command maps to manifest.archive...` | Update comment to reflect pipeline domain |

---

## Layer 12: Engine-Compat Tests (`src/core/memory/__tests__/engine-compat.test.ts`)

| Lines | Current content | Change |
|-------|----------------|--------|
| 14-22 | imports: `memoryShow`, `memoryList`, `memoryQuery`, `memoryPending`, `memoryStats`, `memoryManifestRead`, `memoryManifestAppend`, `memoryManifestArchive`, `memoryInject` | After rename: `memoryManifestRead`→`pipelineManifestShow`, `memoryManifestAppend`→`pipelineManifestAppend`, etc. OR leave as internal functions |
| 57-161 | all `describe`/test bodies using old function names | update to call new function names |
| 188 | `describe('memoryManifestAppend', ...)` | → `describe('pipelineManifestAppend', ...)` or equivalent |
| 212 | `describe('memoryManifestArchive', ...)` | → update |
| 281 | `describe('memoryManifestRead', ...)` | → update |

---

## Layer 13: CLI-MCP Parity Integration Test (`src/core/__tests__/cli-mcp-parity.integration.test.ts`)

| Lines | Current content | Change |
|-------|----------------|--------|
| 174-185 | mock: `memoryShow`, `memoryList`, `memoryQuery`, `memoryPending`, `memoryStats`, `memoryManifestRead`, `memoryManifestAppend`, `memoryManifestArchive`, `memoryInject` | Update mock names to match renamed exports |

---

## Layer 14: Dispatch Adapters Tests (`src/dispatch/adapters/__tests__/cli.test.ts`)

| Lines | Current content | Change |
|-------|----------------|--------|
| 69-80 | mocks: `researchShow`, `researchList`, `researchQuery`, `researchPending`, `researchStats`, `researchManifestRead`, `researchManifestAppend`, `researchManifestArchive`, `researchInject` | Update to new export names |

---

## Layer 15: Documentation Files

### `docs/specs/CLEO-OPERATIONS-REFERENCE.md`

| Lines | Current content | Change |
|-------|----------------|--------|
| 175 | `manifest.read` in memory table | Move to pipeline table |
| 178 | `pattern.search` | → `pattern.find` |
| 180 | `learning.search` | → `learning.find` |
| 182 | `brain.search` | → `find` |
| 183 | `brain.timeline` | → `timeline` |
| 184 | `brain.fetch` | → `fetch` |
| 192 | `manifest.append` in memory table | Move to pipeline table |
| 193 | `manifest.archive` in memory table | Move to pipeline table |
| 196 | `brain.observe` | → `observe` |
| 199-202 | token cost comments for `brain.*` ops | update op names |

### `docs/specs/CLEO-BRAIN-SPECIFICATION.md`

| Lines | Current content | Change |
|-------|----------------|--------|
| 96 | `memory brain.search`, `memory brain.timeline`, `memory brain.fetch` | → `memory find`, `memory timeline`, `memory fetch` |
| 97 | `memory brain.observe` | → `memory observe` |

### `docs/concepts/vision.md`

| Lines | Current content | Change |
|-------|----------------|--------|
| 190 | `memory brain.search` | → `memory find` |
| 191 | `memory brain.timeline` | → `memory timeline` |
| 192 | `memory brain.fetch` | → `memory fetch` |
| 194 | `memory brain.observe` | → `memory observe` |
| 220 | `brain.db ... memory.brain.search / timeline / fetch ... memory.brain.observe` | update references |

### `docs/specs/MCP-SERVER-SPECIFICATION.md`

| Lines | Current content | Change |
|-------|----------------|--------|
| 184 | `manifest.read` in memory table | Move to pipeline table |
| 359 | `manifest.append` | Move to pipeline table |
| 360 | `manifest.archive` | Move to pipeline table |
| 1240 | `manifest.read` in memory domain ops list | → pipeline domain |
| 1255 | `inject, link, manifest.append, manifest.archive` in memory domain | remove manifest.*/inject from memory |

### `docs/specs/CLEO-WEB-API-SPEC.md`

| Lines | Current content | Change |
|-------|----------------|--------|
| 741 | `manifest.read`, `pattern.search`, `learning.search` in memory | update |
| 743 | `inject`, `manifest.append`, `manifest.archive` in memory | move to pipeline/session |

### `docs/specs/VERB-STANDARDS.md`

| Line | Current content | Change |
|------|----------------|--------|
| 810 | `memory.pattern.search`, `memory.learning.search` | → `memory.pattern.find`, `memory.learning.find` |

### `docs/specs/MCP-AGENT-INTERACTION-SPEC.md`

| Line | Current content | Change |
|------|----------------|--------|
| 127 | Research ops include `manifest.read`, `inject`, `manifest.append`, `manifest.archive` | update to new domains |

### `docs/FEATURES.json` and `docs/FEATURES.md`

| Location | Current content | Change |
|----------|----------------|--------|
| FEATURES.json line 50 | `memory brain.search, memory brain.timeline, memory brain.fetch, plus brain.observe` | → `memory find, memory timeline, memory fetch, plus memory observe` |
| FEATURES.md line 37 | same | same |

### `docs/ROADMAP.md`

| Line | Current content | Change |
|------|----------------|--------|
| 9 | `memory brain.search`, `memory brain.timeline`, `memory brain.fetch`, `memory brain.observe` | → update |

### `docs/mintlify/api/command-reference.md`

| Lines | Current content | Change |
|-------|----------------|--------|
| 1111 | `operation=manifest.read` in research domain | → pipeline domain |
| 1121 | `operation=manifest.archive` in research domain | → pipeline domain |
| 1705 | `research manifest \| query \| manifest.read` | → pipeline domain |

### `docs/mintlify/llms.txt`

| Lines | Current content | Change |
|-------|----------------|--------|
| 199 | `manifest.read` in research | → pipeline |
| 212 | `inject, link, manifest.append, manifest.archive` in research | → split: inject→session, manifest.* → pipeline |

### `docs/mintlify/specs/CLEO-MIGRATION-DOCTRINE.md`

| Line | Current content | Change |
|------|----------------|--------|
| 99 | Research ops include all manifest.* and inject | → update |

---

## Layer 16: CLEO Templates / CLEO-INJECTION.md

The CLEO-INJECTION.md at `~/.cleo/templates/CLEO-INJECTION.md` references:
- `memory brain.search` → `memory find`
- `memory brain.timeline` → `memory timeline`
- `memory brain.fetch` → `memory fetch`
- `memory brain.observe` → `memory observe`

---

## Files NOT Requiring Changes

- `src/core/memory/brain-retrieval.ts` — Internal functions (`searchBrainCompact`, `timelineBrain`, `fetchBrainEntries`, `observeBrain`) stay as-is; only the engine-compat wrapper functions are renamed
- `src/core/memory/brain-search.ts` — Internal implementation, no public API change
- `src/core/memory/brain-schema.ts` — Schema, no operation names
- `.cleo/.backups/` — Historical, no changes needed
- `.cleo/research-outputs/BRAIN-MEMORY-IMPLEMENTATION-AUDIT.md` — Historical audit doc

---

## New Files/Handlers Required

1. **`src/dispatch/domains/pipeline.ts`** — ADD cases for `manifest.show`, `manifest.append`, `manifest.archive`
2. **`src/dispatch/domains/session.ts`** — ADD case for `context.inject`
3. **`src/dispatch/registry.ts`** — ADD new entries for `pipeline.manifest.show`, `pipeline.manifest.append`, `pipeline.manifest.archive`, `session.context.inject`

---

## Quick-grep Verification Commands (for Phase 5)

After refactoring, run these to confirm zero legacy references:

```bash
# Should return 0 results:
grep -rn "brain\.search\|brain\.timeline\|brain\.fetch\|brain\.observe" src/
grep -rn "pattern\.search\|learning\.search" src/
grep -rn "manifest\.read" src/dispatch/ src/mcp/ src/cli/
grep -rn "memoryBrainSearch\|memoryBrainTimeline\|memoryBrainFetch\|memoryBrainObserve" src/
grep -rn "memoryPatternSearch\|memoryLearningSearch" src/
grep -rn "memoryInject\b" src/
grep -rn "memoryManifestRead\|memoryManifestAppend\|memoryManifestArchive" src/
grep -rn "'inject'" src/dispatch/domains/memory.ts
grep -rn "researchManifestRead\|researchManifestAppend\|researchManifestArchive\|researchInject" src/
```
