# Data Accessor Safety Architecture

## Overview

All DataAccessor instances returned by `createDataAccessor()` are automatically wrapped with `SafetyDataAccessor`, ensuring data integrity and safety checks cannot be bypassed at the factory level.

## Factory Pattern

```typescript
// Before (UNSAFE)
const accessor = await createDataAccessor('json');
// Returns raw JsonDataAccessor - no safety!

// After (SAFE by default)
const accessor = await createDataAccessor('json');
// Returns SafetyDataAccessor wrapping JsonDataAccessor
```

## Safety Wrapper

The `SafetyDataAccessor` class implements the `DataAccessor` interface and:

1. **Validates sequence** before writes (ensures sequence counter matches database)
2. **Verifies writes** by reading back data after save
3. **Creates git checkpoints** after successful writes
4. **Cannot be bypassed** at the factory level

## Write Operations (with Safety)

All write operations automatically apply safety checks:

- `saveTaskFile()` → sequence validation → write → verification → checkpoint
- `saveSessions()` → write → verification → checkpoint
- `saveArchive()` → write → verification → checkpoint
- `appendLog()` → write → checkpoint (no verification for logs)

## Read Operations (Pass-through)

Read operations pass directly to the underlying accessor:

- `loadTaskFile()` → direct pass-through
- `loadSessions()` → direct pass-through
- `loadArchive()` → direct pass-through

## Emergency Disable

In emergency situations, safety can be disabled via environment variable:

```bash
CLEO_DISABLE_SAFETY=true cleo command
```

**Warning:** This bypasses ALL safety checks. Use only for recovery operations.

## Implementation Details

### Files Created/Modified

1. **Created:** `src/store/safety-data-accessor.ts`
   - `SafetyDataAccessor` class - wraps any DataAccessor
   - `wrapWithSafety()` function - factory helper
   - `isSafetyEnabled()` / `getSafetyStatus()` - status checking

2. **Modified:** `src/store/data-accessor.ts`
   - `createDataAccessor()` now wraps all accessors with safety

3. **Modified:** `src/store/index.ts`
   - Exports SafetyDataAccessor and related utilities

### Safety Flow

```
┌─────────────────────────────────────────────────────────────┐
│                    createDataAccessor()                     │
└──────────────────────┬──────────────────────────────────────┘
                       │
                       ▼
            ┌──────────────────────┐
            │  Check CLEO_DISABLE  │
            │    _SAFETY env var   │
            └──────────┬───────────┘
                       │
           ┌───────────┴───────────┐
           │                       │
           ▼                       ▼
    ┌──────────────┐      ┌────────────────┐
    │  DISABLED    │      │    ENABLED     │
    │ Return inner │      │ Wrap with      │
    │ accessor     │      │ SafetyDataAccessor│
    └──────────────┘      └────────────────┘
                                   │
                                   ▼
                    ┌──────────────────────────────┐
                    │    SafetyDataAccessor        │
                    │  ┌────────────────────────┐  │
                    │  │ 1. Sequence validation │  │
                    │  │ 2. Inner.saveXxx()     │  │
                    │  │ 3. Verify write        │  │
                    │  │ 4. Git checkpoint      │  │
                    │  └────────────────────────┘  │
                    └──────────────────────────────┘
```

## Task Reference

- **Task:** T4745
- **Epic:** T4732 (Data Safety)
- **Related:** T4739 (Centralized Safety Manager)

## Testing

Run the full test suite:
```bash
npm test
```

Verify safety is active:
```typescript
import { createDataAccessor, isSafetyEnabled } from '@cleocode/cleo/store';

const accessor = await createDataAccessor();
console.log(isSafetyEnabled()); // true
console.log(accessor instanceof SafetyDataAccessor); // true
```
