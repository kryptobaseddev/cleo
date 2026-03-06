# Agent Iota Assignment - Phase 7: Nexus Architecture (T5330)

**Role**: Architect  
**Task**: T5330  
**Complexity**: HARD  
**Token Budget**: 25k  
**Assigned**: 2026-03-04  
**Coordinator**: Agent Beta  

---

## Mission

Migrate `nexus` CLI command to dispatch pattern OR document CLI-only justification with Architecture Decision Record.

## Context

- **EPIC**: T5323 (CLI-to-Dispatch Migration)
- **Master Plan**: `.cleo/agent-outputs/T5323-master-plan.md` Section 3.7.1
- **Source File**: `src/cli/commands/nexus.ts` (535 lines)
- **Current Pattern**: Direct core imports (lines 16-40), marked "CLI-only" at line 14

## Current State Analysis

The nexus command currently:
1. Imports directly from `../../core/nexus/index.js` (lines 16-40)
2. Has 11 subcommands: init, register, unregister, list, status, show, discover, search, deps, sync
3. Accesses cross-project filesystem via `getAccessor(project.path)`
4. Has comment: "CLI-only: nexus operations have no dispatch route (cross-project file system access)"

## Decision Required

Choose ONE option:

### Option A: New Nexus Domain (Recommended by Master Plan)
Create a proper `nexus` domain in dispatch layer with operations:
- `nexus.list` - List registered projects
- `nexus.register` - Register a project
- `nexus.unregister` - Unregister a project
- `nexus.show` - Show task across projects
- `nexus.discover` - Find related tasks
- `nexus.search` - Search across projects
- `nexus.deps` - Show cross-project dependencies
- `nexus.sync` - Sync project metadata
- `nexus.init` - Initialize nexus
- `nexus.status` - Show registry status

### Option B: CLI-Only Justification
Document why nexus must remain CLI-only:
- Cross-project filesystem access
- Global registry in `~/.cleo/nexus/`
- Git operations across multiple repos

## Deliverables

### If Option A (New Domain):
1. **ADR Document**: `docs/adrs/ADR-XXX-nexus-domain.md`
   - Decision: Create nexus domain
   - Rationale: Enable MCP access to cross-project operations
   - Consequences: New domain maintenance, security considerations

2. **Registry Updates** (`src/dispatch/registry.ts`):
   ```typescript
   // Add to CanonicalDomain type
   'nexus' // Cross-project operations domain
   
   // Add 10 nexus.* operations
   ```

3. **New Engine** (`src/dispatch/engines/nexus-engine.ts`):
   - Import core functions from `../../core/nexus/index.js`
   - Map to dispatch operation handlers
   - Handle cross-project filesystem access securely

4. **Migrated CLI** (`src/cli/commands/nexus.ts`):
   - Remove direct core imports
   - Use `dispatchRaw('query'|'mutate', 'nexus', 'operation', params)`
   - Use `handleRawError()` for error handling
   - Use `cliOutput()` for output

5. **Tests**:
   - Unit tests for nexus-engine
   - Integration tests for CLI dispatch parity

### If Option B (CLI-Only):
1. **ADR Document**: `docs/adrs/ADR-XXX-nexus-cli-only.md`
   - Decision: Keep nexus CLI-only
   - Rationale: Cross-project filesystem, security boundaries
   - Consequences: MCP cannot perform nexus operations

2. **Updated Documentation**:
   - Update `docs/specs/CLEO-OPERATION-CONSTITUTION.md`
   - Document nexus as justified CLI-only exception

3. **Code Comments**:
   - Enhanced justification comment in nexus.ts
   - Reference to ADR

## Success Criteria

- [ ] Decision made and documented (ADR)
- [ ] If Option A: All 11 subcommands work via dispatch
- [ ] If Option A: No TODO comments, no dead code
- [ ] If Option A: All imports used, no direct core imports in CLI
- [ ] If Option B: ADR clearly justifies CLI-only status
- [ ] Tests pass

## Technical Pattern

### Compliant Dispatch Pattern:
```typescript
import { dispatchRaw, handleRawError } from '../../dispatch/adapters/cli.js';
import { cliOutput } from '../renderers/index.js';

// Instead of: await nexusList()
const response = await dispatchRaw('query', 'nexus', 'list', {});
if (!response.success) {
  handleRawError(response, { command: 'nexus', operation: 'nexus.list' });
}
cliOutput(response.data, { command: 'nexus' });
```

### Engine Pattern:
```typescript
// src/dispatch/engines/nexus-engine.ts
import { nexusList, nexusRegister, ... } from '../../core/nexus/index.js';

export const nexusEngine = {
  'nexus.list': async (params) => {
    const projects = await nexusList();
    return { success: true, data: { projects, total: projects.length } };
  },
  // ... other operations
};
```

## Files to Modify

### Option A (New Domain):
- `src/dispatch/types.ts` - Add 'nexus' to CanonicalDomain
- `src/dispatch/registry.ts` - Add 10 nexus operations
- `src/dispatch/engines/nexus-engine.ts` - Create new engine
- `src/cli/commands/nexus.ts` - Migrate to dispatch pattern
- `docs/adrs/` - Create ADR document

### Option B (CLI-Only):
- `src/cli/commands/nexus.ts` - Update justification comments
- `docs/adrs/` - Create ADR document
- `docs/specs/CLEO-OPERATION-CONSTITUTION.md` - Document exception

## Verification Steps

1. Run `npm run build` - No TypeScript errors
2. Run `npm test` - All tests pass
3. Test manually: `cleo nexus list` works
4. Check: No direct imports from `../../core/nexus` in CLI
5. Check: No TODO comments in final code

## Report Back To

Agent Beta via: `.cleo/agent-outputs/T5323-coordination-log.md`
Update task T5330 status to "active" when starting, "done" when complete.

---

**Coordinator Note**: This is CRITICAL PATH for T5323. Decision on nexus architecture may affect Phase 5 (data portability) and future cross-project features.
