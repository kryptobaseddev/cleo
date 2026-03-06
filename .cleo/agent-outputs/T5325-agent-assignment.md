# Agent Delta Assignment - Phase 2: Existing Operations (T5325)

**Role**: Mid-level Implementer  
**Task**: T5325  
**Complexity**: MEDIUM  
**Token Budget**: 35k  
**Assigned**: 2026-03-04  
**Coordinator**: Agent Beta  

---

## Mission

Wire 5 CLI commands to EXISTING dispatch operations. These operations already exist in the registry - you just need to connect the CLI to use them.

## Commands to Migrate

1. **skills.ts** → Wire to `tools.skill.*` (6 query + 6 mutate operations)
2. **issue.ts** → Wire to `tools.issue.*` (4 operations)
3. **memory-brain.ts** → Wire to `memory.brain.*` (operations exist)
4. **history.ts** → Verify/fix `session.history` wiring
5. **testing.ts** → Wire to `check.manifest` or `check.test.*`

## Context

- **EPIC**: T5323 (CLI-to-Dispatch Migration)
- **Master Plan**: `.cleo/agent-outputs/T5323-master-plan.md` Section 3.2
- **Dispatch Registry**: `src/dispatch/registry.ts`
- **Existing Engines**: `src/dispatch/engines/`

---

## Command 1: skills.ts Migration

### Current State
- File: `src/cli/commands/skills.ts`
- Direct core imports: `discoverAllSkills`, `findSkill`, `validateSkill`, `installSkill`, `mpSearchSkills`
- Subcommands: `list`, `search`, `info`, `validate`, `install`, `uninstall`, `enable`, `disable`, `configure`, `refresh`

### Existing Dispatch Operations
**Query Operations**:
- `tools.skill.list`
- `tools.skill.show`
- `tools.skill.find`
- `tools.skill.dispatch`
- `tools.skill.verify`
- `tools.skill.dependencies`

**Mutate Operations**:
- `tools.skill.install`
- `tools.skill.uninstall`
- `tools.skill.enable`
- `tools.skill.disable`
- `tools.skill.configure`
- `tools.skill.refresh`

### Mapping (CLI → Dispatch)
| CLI Subcommand | Dispatch Operation | Gateway |
|----------------|-------------------|---------|
| `skills list` | `tools.skill.list` | query |
| `skills search <query>` | `tools.skill.find` | query |
| `skills info <skill>` | `tools.skill.show` | query |
| `skills validate <skill>` | `tools.skill.verify` | query |
| `skills install <skill>` | `tools.skill.install` | mutate |
| `skills uninstall <skill>` | `tools.skill.uninstall` | mutate |
| `skills enable <skill>` | `tools.skill.enable` | mutate |
| `skills disable <skill>` | `tools.skill.disable` | mutate |
| `skills configure <skill>` | `tools.skill.configure` | mutate |
| `skills refresh` | `tools.skill.refresh` | mutate |

### Implementation Steps
1. Replace all direct core imports with dispatch adapter imports
2. Map each subcommand's `.action()` handler to dispatch call
3. Transform CLI arguments to operation params
4. Use `cliOutput()` for all output

---

## Command 2: issue.ts Migration

### Current State
- File: `src/cli/commands/issue.ts`
- Direct core imports for issue CRUD
- Subcommands: `bug`, `feature`, `help`, `diagnostics`

### Existing Dispatch Operations
- `tools.issue.add.bug` (mutate)
- `tools.issue.add.feature` (mutate)
- `tools.issue.add.help` (mutate)
- `tools.issue.diagnostics` (query)

### Mapping (CLI → Dispatch)
| CLI Subcommand | Dispatch Operation | Gateway |
|----------------|-------------------|---------|
| `issue bug` | `tools.issue.add.bug` | mutate |
| `issue feature` | `tools.issue.add.feature` | mutate |
| `issue help` | `tools.issue.add.help` | mutate |
| `issue diagnostics` | `tools.issue.diagnostics` | query |

### Implementation Steps
1. Remove direct issue CRUD imports
2. Map subcommands to operations
3. Pass CLI options as operation params

---

## Command 3: memory-brain.ts Migration

### Current State
- File: `src/cli/commands/memory-brain.ts`
- Direct imports from brain.db operations
- Manages cognitive memory, patterns, learnings

### Existing Dispatch Operations
Memory domain has brain suboperations. Check `src/dispatch/registry.ts` for exact operations:
- Likely: `memory.brain.list`, `memory.brain.show`, `memory.brain.search`
- Likely: `memory.brain.add`, `memory.brain.update`, `memory.brain.delete`

### Implementation
1. Research exact operations in registry.ts
2. Map brain subcommands to operations
3. Migrate to dispatch pattern

---

## Command 4: history.ts Migration

### Current State
- File: `src/cli/commands/history.ts`
- Direct core imports for session history
- May already have some dispatch wiring

### Existing Dispatch Operation
- `session.history` - ALREADY EXISTS in registry

### Task
**Verify** existing wiring is correct. If broken:
1. Check current implementation
2. Fix if using direct core calls
3. Ensure proper `dispatchRaw('query', 'session', 'history', params)` usage

### Common Issues to Fix
- Direct calls to history core functions
- Manual error handling instead of `handleRawError()`
- Manual output instead of `cliOutput()`

---

## Command 5: testing.ts Migration

### Current State
- File: `src/cli/commands/testing.ts`
- Validates test manifests
- May be related to manifest validation

### Existing Dispatch Operations
Check registry for:
- `check.manifest` - Manifest validation
- `check.test.*` - Test operations if they exist

### Implementation
1. Research which operation handles manifest validation
2. Map `testing` subcommands to appropriate operations
3. Wire CLI to dispatch

---

## Standard Migration Pattern

### Before (Non-Compliant):
```typescript
import { Command } from 'commander';
import { discoverAllSkills } from '../../core/skills/discovery.js';
import { installSkill } from '../../core/skills/install.js';
import { formatError } from '../../core/output.js';
import { CleoError } from '../../core/errors.js';

program
  .command('list')
  .action(async () => {
    try {
      const skills = await discoverAllSkills();  // DIRECT CORE CALL
      console.log(skills);  // MANUAL OUTPUT
    } catch (err) {
      if (err instanceof CleoError) {
        console.error(formatError(err));
        process.exit(err.code);
      }
      throw err;
    }
  });
```

### After (Compliant):
```typescript
import { Command } from 'commander';
import { dispatchRaw, handleRawError } from '../../dispatch/adapters/cli.js';
import { cliOutput } from '../renderers/index.js';

program
  .command('list')
  .action(async () => {
    const response = await dispatchRaw('query', 'tools', 'skill.list', {});
    
    if (!response.success) {
      handleRawError(response, { command: 'skills', operation: 'tools.skill.list' });
    }
    
    cliOutput(response.data, { command: 'skills' });
  });
```

---

## Subcommand-to-Operation Mapping Template

For each command, document the mapping:

```typescript
// skills.ts mapping
const skillOperationMap = {
  'list': { op: 'tools.skill.list', gateway: 'query', params: {} },
  'search': { op: 'tools.skill.find', gateway: 'query', params: ['query'] },
  'info': { op: 'tools.skill.show', gateway: 'query', params: ['skillId'] },
  'validate': { op: 'tools.skill.verify', gateway: 'query', params: ['skillId'] },
  'install': { op: 'tools.skill.install', gateway: 'mutate', params: ['skillId'] },
  'uninstall': { op: 'tools.skill.uninstall', gateway: 'mutate', params: ['skillId'] },
  'enable': { op: 'tools.skill.enable', gateway: 'mutate', params: ['skillId'] },
  'disable': { op: 'tools.skill.disable', gateway: 'mutate', params: ['skillId'] },
  'configure': { op: 'tools.skill.configure', gateway: 'mutate', params: ['skillId', 'config'] },
  'refresh': { op: 'tools.skill.refresh', gateway: 'mutate', params: {} },
};
```

---

## Token Budget Breakdown

| Command | Complexity | Est. Tokens |
|---------|-----------|-------------|
| skills.ts | 10 subcommands | 12k |
| issue.ts | 4 subcommands | 5k |
| memory-brain.ts | Research + migrate | 8k |
| history.ts | Verify/fix | 3k |
| testing.ts | Research + migrate | 4k |
| Documentation | Report | 3k |
| **Total** | | **35k** |

---

## Success Criteria

For each of the 5 commands:
- [ ] All subcommands mapped to dispatch operations
- [ ] No direct core imports (only dispatch adapters)
- [ ] Uses `dispatchRaw()` for all operations
- [ ] Uses `handleRawError()` for error handling
- [ ] Uses `cliOutput()` for output
- [ ] No TODO comments
- [ ] All imports used (no dead code)
- [ ] Output format matches pre-migration
- [ ] Subcommand help text preserved

---

## Verification Steps

1. **Registry Verification**:
   ```bash
   grep -n "tools.skill" src/dispatch/registry.ts
   grep -n "tools.issue" src/dispatch/registry.ts
   grep -n "memory.brain" src/dispatch/registry.ts
   grep -n "session.history" src/dispatch/registry.ts
   ```

2. **Import Verification** (should show NO results):
   ```bash
   for cmd in skills issue memory-brain history testing; do
     echo "=== $cmd ==="
     grep -n "from '../../core/" src/cli/commands/$cmd.ts
   done
   ```

3. **TODO Check** (should show NO results):
   ```bash
   for cmd in skills issue memory-brain history testing; do
     grep -n "TODO\|FIXME\|XXX" src/cli/commands/$cmd.ts
   done
   ```

4. **Test Execution**:
   ```bash
   npm test -- src/cli/commands/__tests__/
   ```

5. **Manual Verification**:
   ```bash
   # Test each command
   cleo skills list
   cleo issue diagnostics
   cleo history
   cleo testing --help
   ```

---

## Deliverables

1. **Migrated Files**:
   - `src/cli/commands/skills.ts`
   - `src/cli/commands/issue.ts`
   - `src/cli/commands/memory-brain.ts`
   - `src/cli/commands/history.ts` (if fixes needed)
   - `src/cli/commands/testing.ts`

2. **Mapping Documentation** (in report):
   - Subcommand-to-operation mapping for all 5 commands
   - Any operations that were missing or had issues

3. **Report**: `.cleo/agent-outputs/T5325-existing-ops.md`
   - Summary of all changes
   - Operation mapping tables
   - Issues encountered and resolutions

---

## Dependencies

- **Phase 1 (T5324)**: Can run in PARALLEL - no dependencies
- **Phase 3 (T5326)**: Depends on patterns established in Phase 1-2

When complete, notify Agent Beta to:
1. Update coordination log
2. Check if Phase 1 is also complete
3. Spawn Phase 3 agent if both Phase 1-2 are done

---

## Tips for Success

1. **Start with skills.ts** - It has the most subcommands but clear mappings
2. **Use grep to find operations**:
   ```bash
   grep -n "skill" src/dispatch/registry.ts
   grep -n "issue" src/dispatch/registry.ts
   ```
3. **Look at existing compliant commands** for patterns:
   ```bash
   ls src/cli/commands/ | head -10
   ```
4. **Keep mappings simple** - Transform CLI args to operation params directly
5. **Test incrementally** - Verify each subcommand as you go

---

## Questions?

If you find operations that don't exist in the registry:
1. Document in your report
2. Consult with Agent Beta
3. May need to add new operations (coordinate with Phase 3)

If operation signatures don't match CLI needs:
1. Check if CLI is using wrong params
2. Document the mismatch
3. May need param transformation layer
