# CLEO Data Safety Architecture

**Version**: 2026.2.19  
**Status**: IMPLEMENTED  
**Location**: Centralized at DataAccessor Factory  

---

## Overview

CLEO now has **mandatory, centralized data safety** that cannot be bypassed. All data operations automatically include:

- ✅ **Sequence Validation** - Auto-repair if counter behind database
- ✅ **Write Verification** - Read back and validate after every write
- ✅ **Auto-Checkpoint** - Git commit after successful operations
- ✅ **Collision Detection** - Prevent duplicate task IDs

**Zero configuration required. Works automatically for all code.**

---

## Architecture

```
┌─────────────────┐     ┌──────────────────────┐     ┌─────────────┐
│   Your Code     │────▶│  createDataAccessor() │────▶│   Safety    │
│  (MCP/CLI/Core) │     │     (Factory)         │     │   Wrapper   │
└─────────────────┘     └──────────────────────┘     └──────┬──────┘
                                                            │
                                                            ▼
┌─────────────────────────────────────────────────────────────────┐
│                     SafetyDataAccessor                          │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐  ┌────────┐ │
│  │   Sequence  │─▶│    Write    │─▶│   Verify    │─▶│Checkpoint│ │
│  │   Validate  │  │  Operation  │  │   Read-Back │  │   Git    │ │
│  └─────────────┘  └─────────────┘  └─────────────┘  └────────┘ │
└─────────────────────────────────────────────────────────────────┘
                            │
                            ▼
                    ┌───────────────┐
                    │   Database    │
                    │  (SQLite/JSON)│
                    └───────────────┘
```

**Key Point**: The factory **always** returns a SafetyDataAccessor. No code path can bypass safety.

---

## How It Works

### 1. Sequence Validation (Before Write)

```typescript
// Before any write, ensure sequence counter >= max task ID
const check = await checkSequence(cwd);
if (!check.valid) {
  console.warn(`Sequence behind: ${check.counter} < T${check.maxIdInData}. Repairing...`);
  await repairSequence(cwd);  // Auto-repair
}
```

**Protects Against**: Duplicate IDs from stale sequence counters

### 2. Write Operation

```typescript
// Perform the actual write
await innerAccessor.saveTaskFile(data);
```

### 3. Write Verification (After Write)

```typescript
// Read back and validate
const readBack = await accessor.loadTaskFile();
if (readBack.tasks.length !== data.tasks.length) {
  throw new DataSafetyError('Task count mismatch after write');
}
```

**Protects Against**: Ghost entries, failed writes, partial writes

### 4. Auto-Checkpoint

```typescript
// Git commit after successful write
await gitCheckpoint('auto', `saved TaskFile (${taskCount} tasks)`);
```

**Protects Against**: Data loss between operations

---

## Usage

### For Developers

**No changes needed.** The factory automatically wraps all accessors:

```typescript
// Old code (now automatically safe)
const accessor = await createDataAccessor('sqlite');
await accessor.saveTaskFile(data);  // Has full safety automatically!

// No need to call safeSaveTaskFile() - safety is automatic
```

### For Operations

**Check safety status:**
```bash
cleo sequence check           # Verify sequence integrity
cleo sequence show            # Show current sequence state
cleo checkpoint --status      # Show last checkpoint time
```

**Force checkpoint before dangerous operations:**
```bash
cleo checkpoint --manual "pre-migration"
```

**Emergency disable (DANGEROUS):**
```bash
CLEO_DISABLE_SAFETY=true cleo <command>
```

---

## Configuration

Safety is **always on by default**. Configuration options in `.cleo/config.json`:

```json
{
  "gitCheckpoint": {
    "enabled": true,        // Master switch (default: true)
    "debounceMinutes": 5,   // Min time between checkpoints
    "messagePrefix": "chore(cleo):"
  }
}
```

**Per-operation override** (emergency use only):
```typescript
// Skip checkpoint for this operation
await accessor.saveTaskFile(data, { checkpoint: false });
```

---

## Error Handling

All safety violations throw `DataSafetyError`:

```typescript
try {
  await accessor.saveTaskFile(data);
} catch (err) {
  if (err instanceof DataSafetyError) {
    console.error(`Safety violation: ${err.code}`);
    // 'COLLISION' | 'WRITE_FAILED' | 'VERIFICATION_FAILED' | 'SEQUENCE_INVALID'
  }
}
```

### Error Codes

| Code | Meaning | Action |
|------|---------|--------|
| `COLLISION` | Task ID already exists | Use different ID |
| `WRITE_FAILED` | Write did not persist | Retry or check disk |
| `VERIFICATION_FAILED` | Read-back didn't match | Check for corruption |
| `SEQUENCE_INVALID` | Sequence repair failed | Manual repair needed |

---

## Key Files

| File | Purpose |
|------|---------|
| `src/store/safety-data-accessor.ts` | Safety wrapper implementation |
| `src/store/data-accessor.ts` | Factory that returns safe accessors |
| `src/store/data-safety-central.ts` | Centralized safety functions |
| `src/store/git-checkpoint.ts` | Checkpoint implementation |
| `src/core/sequence/index.ts` | Sequence validation |

---

## Testing

**Test documentation**: `docs/testing/SAFETY-TEST-STRATEGY.md`

**Run safety tests:**
```bash
npm test -- --testPathPattern="safety"
```

**Quick integrity check:**
```bash
cleo doctor --full
```

---

## Statistics

Track safety metrics:

```typescript
import { getSafetyStats } from './store/data-safety-central.js';

const stats = getSafetyStats();
console.log(`Writes: ${stats.writes}`);
console.log(`Verifications: ${stats.verifications}`);
console.log(`Checkpoints: ${stats.checkpoints}`);
console.log(`Errors: ${stats.errors}`);
console.log(`Last checkpoint: ${stats.lastCheckpoint}`);
```

---

## Emergency Procedures

### Data Loss Detected

1. **Stop operations:**
   ```bash
   export GIT_CHECKPOINT_SUPPRESS=true
   ```

2. **Restore from checkpoint:**
   ```bash
   git log --oneline -10  # Find last good commit
   git checkout <commit> -- .cleo/
   ```

3. **Repair sequence:**
   ```bash
   cleo sequence repair
   ```

4. **Verify integrity:**
   ```bash
   cleo doctor --full
   ```

---

## What Changed

### Before (Broken)
- ❌ Auto-checkpoint never called
- ❌ No write verification
- ❌ No collision detection
- ❌ Sequence out of sync
- ❌ Manual safety wrappers needed

### After (Fixed)
- ✅ Centralized at factory level
- ✅ Cannot be bypassed
- ✅ Zero configuration
- ✅ Works automatically
- ✅ All code paths protected

---

## Troubleshooting

### "No checkpoint in X minutes"
**Cause**: Checkpoint frequency < configured debounce
**Fix**: Check `cleo checkpoint --status`, verify no errors

### "Sequence behind: counter=X, maxId=T"
**Cause**: Sequence file out of sync
**Fix**: Run `cleo sequence repair` (auto-repair also works)

### "Write verification failed"
**Cause**: Write succeeded but read-back failed
**Fix**: Check disk space, file permissions, database corruption

### "COLLISION detected"
**Cause**: Attempted to create task with existing ID
**Fix**: Use next available ID from sequence

---

## References

- **Testing**: `docs/testing/SAFETY-TEST-STRATEGY.md`
- **Incident**: `.cleo/INCIDENT-2026-02-19-database-corruption.md`
- **Implementation**: `src/store/safety-data-accessor.ts`

---

**Last Updated**: 2026-02-19  
**Related Tasks**: T4739, T4740, T4742, T4744, T4745
