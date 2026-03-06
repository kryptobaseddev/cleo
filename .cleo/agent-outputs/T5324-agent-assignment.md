# Agent Gamma Assignment - Phase 1: Quick Wins (T5324)

**Role**: Junior Implementer  
**Task**: T5324  
**Complexity**: EASY  
**Token Budget**: 15k  
**Assigned**: 2026-03-04  
**Coordinator**: Agent Beta  

---

## Mission

Migrate 3 EASY CLI commands to dispatch wrappers. These are quick wins that establish the migration pattern for subsequent phases.

## Commands to Migrate

1. **labels.ts** → Wire to existing `tasks.label.*` operations
2. **grade.ts** → Add `session.grade` operation OR document CLI-only
3. **archive-stats.ts** → Add `admin.archive.stats` operation

## Context

- **EPIC**: T5323 (CLI-to-Dispatch Migration)
- **Master Plan**: `.cleo/agent-outputs/T5323-master-plan.md` Section 3.1
- **Pattern Guide**: `docs/specs/VERB-STANDARDS.md`

---

## Command 1: labels.ts Migration

### Current State
- File: `src/cli/commands/labels.ts`
- Imports: `getAccessor` from `../../store/data-accessor.js`
- Current: Direct calls to data accessor for label queries

### Target State
**Dispatch Operations Already Exist** (in registry.ts lines 186-200):
- `tasks.label.list` - List all labels
- `tasks.label.show` - Show label details

### Implementation Steps
1. Import dispatch utilities:
   ```typescript
   import { dispatchRaw, handleRawError } from '../../dispatch/adapters/cli.js';
   ```

2. Replace direct data access with dispatch calls:
   ```typescript
   // OLD:
   const accessor = await getAccessor();
   const tasks = await accessor.loadTaskFile();
   // ... filter for labels
   
   // NEW:
   const response = await dispatchRaw('query', 'tasks', 'label.list', {});
   if (!response.success) {
     handleRawError(response, { command: 'labels' });
   }
   ```

3. Update output to use `cliOutput()` renderer

### Files to Modify
- `src/cli/commands/labels.ts` - Full migration

---

## Command 2: grade.ts Migration

### Current State
- File: `src/cli/commands/grade.ts`
- Imports: Direct core functions for session grading
- Complexity: Session grading may be local-only heuristic

### Decision Required
**Option A**: Add `session.grade` operation to registry (if grading is meaningful operation)
**Option B**: Document as CLI-only (if grading is purely local heuristic)

### Option A Implementation
1. Add to `src/dispatch/registry.ts`:
   ```typescript
   {
     gateway: 'query',
     domain: 'session',
     operation: 'grade',
     description: 'Get session grading information',
     tier: 1,
     idempotent: true,
     sessionRequired: true,
     requiredParams: [],
   }
   ```

2. Add handler to `src/dispatch/engines/session-engine.ts`

3. Migrate CLI to use dispatch

### Option B Implementation
1. Add justification comment to grade.ts
2. Document in `.cleo/agent-outputs/T5324-quick-wins.md`

---

## Command 3: archive-stats.ts Migration

### Current State
- File: `src/cli/commands/archive-stats.ts`
- Imports: 
  - `getAccessor` from `../../store/data-accessor.js`
  - `summaryReport, cycleTimesReport` from `../../core/analytics.js`
- Current: Direct core calls for analytics

### Target State
**New Operation Needed**: `admin.archive.stats`

### Implementation Steps
1. **Add Operation to Registry** (`src/dispatch/registry.ts`):
   ```typescript
   {
     gateway: 'query',
     domain: 'admin',
     operation: 'archive.stats',
     description: 'Get analytics on archived tasks',
     tier: 1,
     idempotent: true,
     sessionRequired: false,
     requiredParams: [],
   }
   ```

2. **Add Handler** (`src/dispatch/engines/admin-engine.ts`):
   ```typescript
   'admin.archive.stats': async (params) => {
     const accessor = await getAccessor();
     const archiveData = await accessor.loadArchiveFile();
     const summary = await summaryReport(archiveData);
     const cycleTimes = await cycleTimesReport(archiveData);
     return { 
       success: true, 
       data: { summary, cycleTimes } 
     };
   }
   ```

3. **Migrate CLI** (`src/cli/commands/archive-stats.ts`):
   - Remove direct imports from `../../core/analytics.js`
   - Use `dispatchRaw('query', 'admin', 'archive.stats', {})`
   - Use `cliOutput()` for formatted output

---

## Standard Pattern Reference

### Compliant Pattern:
```typescript
import { Command } from 'commander';
import { dispatchRaw, handleRawError } from '../../dispatch/adapters/cli.js';
import { cliOutput } from '../renderers/index.js';

export function registerExampleCommand(program: Command): void {
  program
    .command('example')
    .action(async () => {
      const response = await dispatchRaw('query', 'domain', 'operation', {});
      
      if (!response.success) {
        handleRawError(response, { command: 'example', operation: 'domain.operation' });
      }
      
      cliOutput(response.data, { command: 'example' });
    });
}
```

### Non-Compliant Pattern (What to Remove):
```typescript
// DON'T DO THIS:
import { someCoreFunction } from '../../core/some-module.js';
import { formatError } from '../../core/output.js';
import { CleoError } from '../../core/errors.js';

const result = await someCoreFunction();  // Direct core call
console.log(result);  // Manual output
```

---

## Success Criteria

For each of the 3 commands:
- [ ] No direct core imports (only dispatch adapters)
- [ ] Uses `dispatchRaw()` for all data operations
- [ ] Uses `handleRawError()` for error handling
- [ ] Uses `cliOutput()` for output formatting
- [ ] No TODO comments in final code
- [ ] All imports are used (no dead code)
- [ ] Command output format identical to pre-migration
- [ ] Unit tests pass

---

## Verification Steps

1. **Build Check**:
   ```bash
   npm run build
   ```
   Should produce no TypeScript errors.

2. **Import Check**:
   ```bash
   grep -n "from '../../core/" src/cli/commands/labels.ts
   grep -n "from '../../core/" src/cli/commands/grade.ts
   grep -n "from '../../core/" src/cli/commands/archive-stats.ts
   ```
   Should return nothing (or only from `../renderers/`).

3. **TODO Check**:
   ```bash
   grep -n "TODO" src/cli/commands/labels.ts
   grep -n "TODO" src/cli/commands/grade.ts
   grep -n "TODO" src/cli/commands/archive-stats.ts
   ```
   Should return nothing.

4. **Test Check**:
   ```bash
   npm test -- src/cli/commands/__tests__/labels.test.ts
   npm test -- src/cli/commands/__tests__/grade.test.ts
   npm test -- src/cli/commands/__tests__/archive-stats.test.ts
   ```
   All tests should pass.

5. **Manual Check**:
   ```bash
   cleo labels
   cleo grade
   cleo archive-stats
   ```
   Commands should work as before.

---

## Deliverables

1. **Migrated Files**:
   - `src/cli/commands/labels.ts`
   - `src/cli/commands/grade.ts`
   - `src/cli/commands/archive-stats.ts`

2. **Registry Updates** (if needed):
   - `src/dispatch/registry.ts` - Add `admin.archive.stats`
   - `src/dispatch/engines/admin-engine.ts` - Add archive stats handler
   - `src/dispatch/engines/session-engine.ts` - Add grade handler (if Option A)

3. **Report Document**: `.cleo/agent-outputs/T5324-quick-wins.md`
   - Summary of changes
   - Pattern established
   - Any issues encountered

---

## Timeline

- **labels.ts**: ~3k tokens
- **grade.ts**: ~2k tokens (plus decision time)
- **archive-stats.ts**: ~5k tokens (includes new operation)
- **Documentation**: ~3k tokens
- **Buffer**: ~2k tokens

Total: ~15k tokens

---

## Dependencies

**None** - Phase 1 can start immediately and run in parallel with Phase 2.

When complete, notify Agent Beta to update coordination log and trigger Phase 3 preparation.

---

## Questions?

If blocked or unsure:
1. Check the master plan: `.cleo/agent-outputs/T5323-master-plan.md`
2. Look at existing compliant commands in `src/cli/commands/`
3. Consult Agent Beta via coordination log
