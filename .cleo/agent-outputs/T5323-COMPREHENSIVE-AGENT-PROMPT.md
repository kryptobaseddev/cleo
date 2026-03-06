# COMPREHENSIVE AGENT PROMPT: T5323 CLI Dispatch Migration

**For**: Implementation Agent (New Session, Zero Context)  
**Task**: T5323  
**Objective**: Migrate 28 CLI commands from direct core calls to dispatch compliance  
**Priority**: Critical  
**Token Budget**: 185k hard cap / handoff at 150k  

---

## 🎯 MISSION OVERVIEW

**What You Must Do:**
Take CLI commands that currently call `src/core/` directly and rewrite them to use the dispatch layer (`src/dispatch/`) instead.

**Why:**
- Constitution §9 mandates: "Both interfaces route through the shared dispatch layer"
- Currently 44% of CLI commands bypass dispatch (38 of 86)
- Direct core calls skip validation, error handling, and audit trails

**Success Criteria:**
- All 28 CLI commands use `dispatchFromCli()` or `dispatchRaw()`
- No direct imports from `../../core/` (except `formatError`, `CleoError`)
- Registry.ts has all required operations
- Domain handlers implemented
- Tests pass
- Zero action-marker comments

---

## 📚 ESSENTIAL DOCUMENTS (READ THESE FIRST)

### 1. Master Plan (MUST READ)
**File**: `.cleo/agent-outputs/T5323-master-plan.md`
**Sections to Read:**
- Section 1: Audit of all 39 commands (know which ones need migration)
- Section 2: 7-phase decomposition strategy
- Section 3: Implementation specifications for your assigned phase
- Section 5: Token budget for each phase

### 2. Registry (SSoT)
**File**: `src/dispatch/registry.ts`
**What to Check:**
- Lines 55-2190: All 207 operations defined
- Look for operations matching your commands
- Note the `OperationDef` interface structure

### 3. Compliant Example
**File**: `src/cli/commands/add.ts` or `src/cli/commands/list.ts`
**Pattern to Copy:**
```typescript
import { dispatchFromCli, handleRawError } from '../../dispatch/adapters/cli.js';
const response = await dispatchFromCli('mutate', 'tasks', 'add', params, {command: 'add'});
if (!response.success) handleRawError(response, {command: 'add'});
```

### 4. CLI Adapter
**File**: `src/dispatch/adapters/cli.js`
**Exports:**
- `dispatchFromCli()` - Use this for most commands
- `dispatchRaw()` - Use this for custom output handling
- `handleRawError()` - Standardized error handling

---

## 🔴 SACRED CONSTRAINTS (ZERO TOLERANCE)

### 1. NO ACTION-MARKER COMMENTS
**Rule**: Every task must be 100% complete  
**Enforcement**: If you can't finish something, document it in MANIFEST.jsonl with `needs_followup`, don't leave unfinished action markers in code

### 2. NO CODE GRAVEYARDS
**Rule**: Never comment out code to pass checks  
**Enforcement**: Either use the code (validate it's wired correctly) or delete it

### 3. DRY PRINCIPLE
**Rule**: Logic lives ONLY in src/core/  
**Enforcement**: CLI commands are thin wrappers (10-20 lines max), no business logic

### 4. NO DIRECT CORE IMPORTS
**Rule**: Only import from `../../dispatch/adapters/cli.js`  
**Exceptions**: `formatError`, `CleoError` for error handling only

### 5. TOKEN PROTECTION
**Rule**: Hard cap at 185k tokens  
**Action**: If you hit 150k, handoff immediately:
1. Document state in MANIFEST
2. Note what's complete/incomplete
3. Request next agent to continue

### 6. MANIFEST DISCIPLINE
**Rule**: Append ONE line to `.cleo/agent-outputs/MANIFEST.jsonl`  
**Format**:
```json
{"id":"T5324-wave-1","file":"src/cli/commands/labels.ts","status":"complete","date":"2026-03-04","agent_type":"implementation","topics":["cli-migration"],"key_findings":["Migrated labels.ts to dispatch"],"actionable":true,"linked_tasks":["T5323","T5324"]}
```

---

## 🏗️ ARCHITECTURE PATTERN

### The Flow (What You're Implementing)
```
CLI Command → dispatchFromCli() → Registry → Domain Handler → Engine → Core → Store
```

### Your Job (CLI Side)
1. Parse CLI arguments/options
2. Map to dispatch operation parameters
3. Call `dispatchFromCli()` or `dispatchRaw()`
4. Handle response/errors
5. Output result

### NOT Your Job (Core Side)
- Business logic
- Database queries
- File operations
- Validation logic

---

## 📝 IMPLEMENTATION STEPS

### Step 1: Identify Your Commands
Read `.cleo/agent-outputs/T5323-master-plan.md` Section 1 to find:
- Which commands are assigned to your phase
- What dispatch operations already exist
- What new operations need to be created

### Step 2: Check Registry
Open `src/dispatch/registry.ts` and search for:
- Existing operations matching your commands
- Similar operations to use as templates

### Step 3: Plan Changes
For each command, determine:
1. Does the dispatch operation already exist?
   - YES → Just wire the CLI command (Step 4)
   - NO → Create operation first (Step 5)

### Step 4: Wire Existing Operation

**Example: labels.ts**

**BEFORE** (non-compliant):
```typescript
import { getAccessor } from '../../store/data-accessor.js';
const labels = await getAccessor().query(...);
```

**AFTER** (compliant):
```typescript
import { dispatchRaw, handleRawError } from '../../dispatch/adapters/cli.js';
import { cliOutput } from '../renderers/index.js';

const response = await dispatchRaw('query', 'tasks', 'label.list', {});
if (!response.success) {
  handleRawError(response, { command: 'labels' });
  return;
}
cliOutput(response.data, { command: 'labels' });
```

### Step 5: Create New Operation (If Needed)

If operation doesn't exist in registry:

1. **Add to Registry** (`src/dispatch/registry.ts`):
```typescript
{
  gateway: 'query',           // 'query' for read, 'mutate' for write
  domain: 'tasks',            // One of 10 canonical domains
  operation: 'label.list',    // Dot-notation name
  description: 'List all labels',
  tier: 1,                    // 0=basic, 1=extended, 2=full
  idempotent: true,           // Safe to retry?
  sessionRequired: false,     // Needs active session?
  requiredParams: [],         // Required parameter keys
}
```

2. **Add Domain Handler** (`src/dispatch/domains/{domain}.ts`):
```typescript
case 'label.list': {
  const result = await coreFunctions.listLabels(params);
  return createSuccessResponse(result);
}
```

3. **Wire Core Logic** (may already exist in `src/core/{module}/`)

4. **Wire CLI Command** (Step 4)

### Step 6: Test

**Type Check:**
```bash
npx tsc --noEmit
```

**Run Command:**
```bash
node dist/cli/index.js {command} {args}
```

**Verify:**
- No errors
- Output matches pre-migration
- No direct core imports remain

### Step 7: Update Manifest

Append to `.cleo/agent-outputs/MANIFEST.jsonl`:
```json
{"id":"T5324-{command}-migrated","file":"src/cli/commands/{command}.ts","status":"complete","date":"2026-03-04","agent_type":"implementation","key_findings":["Migrated {command}.ts to dispatch compliance"],"linked_tasks":["T5323","T5324"]}
```

### Step 8: Complete Task

Use CLEO to mark your task complete:
```bash
cleo complete {YOUR_TASK_ID}
```

---

## 🎭 PHASE ASSIGNMENTS

### Phase 1: Quick Wins (T5324)
**Commands**: labels, grade, archive-stats  
**Complexity**: EASY  
**Budget**: 15k  
**Notes**: Most operations already exist in registry

### Phase 2: Existing Ops (T5325)
**Commands**: skills, issue, memory-brain, history, testing  
**Complexity**: MEDIUM  
**Budget**: 35k  
**Notes**: Wire existing operations, no new registry entries needed

### Phase 3: New Operations (T5326)
**Commands**: phase, phases, sync  
**Complexity**: MEDIUM-HARD  
**Budget**: 25k  
**Notes**: Create new dispatch operations

### Phase 4: Protocol Validation (T5327)
**Commands**: consensus, contribution, decomposition, implementation, specification, verify  
**Complexity**: HARD  
**Budget**: 40k  
**Notes**: Needs ADR for architecture decisions

### Phase 5: Data Portability (T5328)
**Commands**: export-tasks, import-tasks, export, import, snapshot  
**Complexity**: HARD  
**Budget**: 45k  
**Notes**: Depends on Phase 7 completion

### Phase 6: Restoration (T5329)
**Commands**: restore  
**Complexity**: HARD  
**Budget**: 20k  
**Notes**: Complex multi-branch logic

### Phase 7: Nexus (T5330) ⚠️ CRITICAL PATH
**Commands**: nexus  
**Complexity**: HARD  
**Budget**: 25k  
**Notes**: Decision needed - new domain or CLI-only? Blocks Phase 5

---

## ✅ VALIDATION CHECKLIST

Per Command:
- [ ] No direct imports from `../../core/` (except formatError, CleoError)
- [ ] Uses `dispatchFromCli()` or `dispatchRaw()`
- [ ] Error handling via `handleRawError()`
- [ ] All imports used (no dead code)
- [ ] No action-marker comments
- [ ] No commented-out code
- [ ] Output format identical to pre-migration
- [ ] TypeScript compiles (`npx tsc --noEmit`)

Per Phase:
- [ ] All commands migrated
- [ ] Registry updated (if new operations)
- [ ] Domain handlers implemented (if new operations)
- [ ] Manifest entry appended
- [ ] Tests pass

---

## 🚨 COMMON MISTAKES TO AVOID

### ❌ WRONG: Direct Core Import
```typescript
import { someCoreFunction } from '../../core/module.js';
const result = await someCoreFunction();
```

### ✅ RIGHT: Dispatch Call
```typescript
import { dispatchRaw } from '../../dispatch/adapters/cli.js';
const response = await dispatchRaw('query', 'domain', 'operation', params);
```

### ❌ WRONG: Business Logic in CLI
```typescript
// Calculating, filtering, transforming data
const processed = data.map(x => x.filter(...)).reduce(...);
```

### ✅ RIGHT: Thin Wrapper Only
```typescript
// Just call dispatch, let core do the work
const response = await dispatchRaw('query', 'domain', 'operation', params);
cliOutput(response.data);
```

### ❌ WRONG: Unfinished Action Marker Comment
```typescript
// Pending implementation note: implement error handling
```

### ✅ RIGHT: Complete Implementation or Document Blocker
```typescript
// Full implementation here
// OR if blocked:
// Document in MANIFEST with needs_followup
```

---

## 📖 REFERENCE MATERIALS

### Files You May Need to Read
- `src/dispatch/registry.ts` - All dispatch operations
- `src/dispatch/domains/*.ts` - Domain handlers
- `src/dispatch/adapters/cli.js` - CLI dispatch utilities
- `src/cli/commands/*.ts` - Commands to migrate
- `.cleo/agent-outputs/T5323-master-plan.md` - Full migration plan

### Constitution Reference
**Section 9**: "Both interfaces route through the shared dispatch layer (`src/dispatch/`) to `src/core/`."

### Helpful Commands
```bash
# Check registry operations
grep "operation:" src/dispatch/registry.ts | head -20

# Find commands bypassing dispatch
grep -r "from '../../core/" src/cli/commands/*.ts

# Type check
npx tsc --noEmit

# Test a command
node dist/cli/index.js {command} --help
```

---

## 🎯 YOUR IMMEDIATE ACTIONS

1. **Read** `.cleo/agent-outputs/T5323-master-plan.md` Section 1
2. **Identify** which commands are assigned to your phase
3. **Check** `src/dispatch/registry.ts` for existing operations
4. **Plan** your approach (wire existing vs create new)
5. **Implement** following the pattern in Step 4/5 above
6. **Test** with `npx tsc --noEmit`
7. **Update** MANIFEST.jsonl
8. **Complete** your task with `cleo complete {TASK_ID}`

---

## 🆘 GETTING HELP

**If you hit token limit (150k):**
1. Document what you've completed
2. Document what's remaining
3. Append MANIFEST entry with status "partial"
4. Request handoff to next agent

**If you encounter blockers:**
1. Document the blocker in MANIFEST
2. Check if ADR is needed (Phases 4, 5, 7)
3. Request clarification, don't fabricate

**If operation doesn't exist:**
1. Check master plan for proposed operation name
2. Add to registry.ts following existing patterns
3. Add domain handler
4. Then wire CLI command

---

## 📊 SUCCESS METRICS

When you finish, these must be true:
- [ ] All commands in your phase use dispatch
- [ ] Zero direct core imports (except allowed exceptions)
- [ ] TypeScript compiles without errors
- [ ] Commands work identically to before
- [ ] MANIFEST.jsonl has your entry
- [ ] No action-marker comments anywhere
- [ ] All imports are used

---

**Remember**: You are implementing architecture compliance, not just moving code. Every dispatch call ensures validation, error handling, and audit trails work correctly.

**Start by reading the Master Plan.**

**End by completing your task.**

**Do not leave work unfinished.**

---

*This prompt is self-contained. You have everything you need to complete T5323.*
