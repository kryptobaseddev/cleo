# CLEO Data Safety Testing Strategy

**Version**: 2026.2.19  
**Status**: Active  
**Task**: T4746  
**Epic**: Data Safety Validation

---

## Executive Summary

This document defines the comprehensive testing strategy for validating CLEO's data safety mechanisms. Following the February 19, 2026 database corruption incident (46 tasks lost, sequence corruption, ghost entries), rigorous testing of safety mechanisms is critical.

**Scope**: End-to-end validation of all data safety layers including collision detection, write verification, sequence validation, checkpointing, and recovery procedures.

---

## 1. Unit Test Strategy

### 1.1 Collision Detection Tests

#### Test: Collision Detection - Duplicate Task ID
- **Purpose**: Verify duplicate task IDs are rejected before database write
- **Input**: Attempt to create task with existing ID 'T9999'
- **Expected**: `DataSafetyError` with code `'COLLISION'`
- **Location**: `src/store/__tests__/data-safety-central.test.ts`
- **Test Data**: Pre-existing task T9999, attempt to create second task with same ID
- **Verification Points**:
  - Error is thrown before database insert
  - Original task remains unchanged
  - Sequence counter not incremented
  - No checkpoint created for failed operation

#### Test: Collision Detection - Race Condition Simulation
- **Purpose**: Verify collision detection handles rapid successive writes
- **Input**: Two concurrent attempts to create task with same ID
- **Expected**: First succeeds, second throws `DataSafetyError`
- **Location**: `src/store/__tests__/data-safety-central.test.ts`
- **Test Data**: Simulated race condition with Promise.all
- **Verification Points**:
  - Exactly one task created
  - No duplicate entries in database
  - Appropriate error for second attempt

#### Test: Collision Detection - Session ID Collision
- **Purpose**: Verify session ID collisions are detected
- **Input**: Create session with ID matching existing session
- **Expected**: `DataSafetyError` with context showing conflicting ID
- **Location**: `src/store/__tests__/session-store.test.ts`
- **Verification Points**:
  - Session collision detected during validation phase
  - Error includes both session IDs

### 1.2 Write Verification Tests

#### Test: Write Verification - Successful Write
- **Purpose**: Verify data is read back and validated after write
- **Input**: Create task with all fields populated
- **Expected**: Task retrievable with identical field values
- **Location**: `src/store/__tests__/data-safety-central.test.ts`
- **Verification Points**:
  - Task count matches expected
  - Last written task found in read-back data
  - All fields match (title, description, status, priority, etc.)
  - `stats.verifications` incremented

#### Test: Write Verification - Failed Write Detection
- **Purpose**: Detect when write operation silently fails
- **Input**: Mock filesystem to reject writes, attempt task creation
- **Expected**: `DataSafetyError` with code `'WRITE_FAILED'`
- **Location**: `src/store/__tests__/data-safety-central.test.ts`
- **Verification Points**:
  - Error thrown immediately on write failure
  - No partial data left in database
  - Error context includes operation details

#### Test: Write Verification - Partial Write Detection
- **Purpose**: Detect incomplete writes (e.g., power loss mid-write)
- **Input**: Simulate partial file write (truncated JSON)
- **Expected**: Verification fails with structural error
- **Location**: `src/store/__tests__/data-safety-central.test.ts`
- **Verification Points**:
  - Malformed JSON detected during verification
  - Tasks array missing or incomplete
  - Error indicates data corruption

#### Test: Write Verification - Task Count Mismatch
- **Purpose**: Verify expected task count matches actual count
- **Input**: Write 5 tasks, verify expects 5
- **Expected**: Success if counts match, error if mismatch
- **Location**: `src/store/__tests__/data-safety-central.test.ts`
- **Verification Points**:
  - Expected vs actual count in error message
  - Mismatch triggers `VERIFICATION_FAILED`

### 1.3 Sequence Validation Tests

#### Test: Sequence Validation - Valid Sequence
- **Purpose**: Verify sequence passes validation when counter >= max ID
- **Input**: Sequence counter = 100, max task ID = T95
- **Expected**: Validation passes, no repair needed
- **Location**: `src/store/__tests__/data-safety-central.test.ts`
- **Verification Points**:
  - `checkSequence()` returns `{ valid: true }`
  - No auto-repair triggered
  - Operation proceeds normally

#### Test: Sequence Validation - Stale Sequence Detection
- **Purpose**: Detect when sequence counter is behind database
- **Input**: Sequence counter = 50, database contains T75
- **Expected**: Warning logged, auto-repair triggered
- **Location**: `src/store/__tests__/data-safety-central.test.ts`
- **Verification Points**:
  - Warning message: "Sequence behind: counter=50, maxId=T75"
  - Auto-repair adjusts counter to 76
  - Operation succeeds after repair

#### Test: Sequence Validation - Repair Failure
- **Purpose**: Handle case where sequence repair fails
- **Input**: Corrupted sequence file, strict mode enabled
- **Expected**: `DataSafetyError` with code `'SEQUENCE_INVALID'`
- **Location**: `src/store/__tests__/data-safety-central.test.ts`
- **Verification Points**:
  - Repair attempt logged
  - Error includes both check and repair results
  - Operation blocked until manual fix

#### Test: Sequence Validation - Non-Strict Mode
- **Purpose**: Verify non-strict mode allows operation despite sequence issues
- **Input**: Invalid sequence with `strict: false`
- **Expected**: Warning logged, operation proceeds
- **Location**: `src/store/__tests__/data-safety-central.test.ts`
- **Verification Points**:
  - No error thrown
  - Warning indicates sequence issue
  - Operation completes successfully

### 1.4 Checkpoint Trigger Tests

#### Test: Checkpoint Trigger - Auto After Write
- **Purpose**: Verify checkpoint created after successful write
- **Input**: Create task with default safety options
- **Expected**: `gitCheckpoint()` called with operation context
- **Location**: `src/store/__tests__/data-safety-central.test.ts`
- **Verification Points**:
  - Checkpoint function invoked
  - Context includes task count
  - `stats.checkpoints` incremented
  - `stats.lastCheckpoint` updated

#### Test: Checkpoint Trigger - Disabled
- **Purpose**: Verify checkpoint can be disabled per-operation
- **Input**: Create task with `checkpoint: false`
- **Expected**: No checkpoint created
- **Location**: `src/store/__tests__/data-safety-central.test.ts`
- **Verification Points**:
  - Checkpoint function not called
  - Operation succeeds without checkpoint

#### Test: Checkpoint Trigger - Failure Non-Fatal
- **Purpose**: Verify checkpoint failure doesn't fail the operation
- **Input**: Mock gitCheckpoint to throw, attempt write
- **Expected**: Warning logged, operation succeeds
- **Location**: `src/store/__tests__/data-safety-central.test.ts`
- **Verification Points**:
  - Warning message: "Checkpoint failed (non-fatal)"
  - Data written successfully
  - Error captured in stats

---

## 2. Integration Test Scenarios

### 2.1 Task Lifecycle Integration

#### Test: Complete Task Lifecycle
- **Purpose**: Validate safety across full task lifecycle
- **Workflow**:
  1. Create task T1000 (verify write, checkpoint)
  2. Update task status to 'active' (verify write, checkpoint)
  3. Add dependency T999 (verify consistency)
  4. Complete task (verify write, checkpoint)
  5. Archive task (verify write, checkpoint)
- **Expected**: Each operation verified, checkpoint after each, no data loss
- **Location**: `src/store/__tests__/task-lifecycle.test.ts`
- **Verification Points**:
  - Task exists with correct fields at each stage
  - Sequence counter incremented correctly
  - 4 checkpoints created
  - Archive contains task after final step

#### Test: Bulk Task Operations
- **Purpose**: Validate safety during bulk inserts/updates
- **Input**: Create 50 tasks in batch
- **Expected**: All tasks verified, single checkpoint after batch
- **Location**: `src/store/__tests__/bulk-operations.test.ts`
- **Verification Points**:
  - Task count = 50 after operation
  - Each task individually verifiable
  - No duplicate IDs in batch
  - Checkpoint includes batch context

### 2.2 Session Lifecycle Integration

#### Test: Session Lifecycle with Safety
- **Purpose**: Validate session operations with full safety
- **Workflow**:
  1. Start session (checkpoint)
  2. Set focus task (verify)
  3. Create task during session (verify, checkpoint)
  4. End session (verify, checkpoint)
- **Expected**: Session data consistent, all operations verified
- **Location**: `src/store/__tests__/session-lifecycle.test.ts`
- **Verification Points**:
  - Session file created with correct data
  - Tasks created associated with session
  - Session duration calculated correctly
  - All checkpoints include session context

### 2.3 Concurrent Modification Handling

#### Test: Concurrent Task Updates
- **Purpose**: Validate safety with concurrent modifications
- **Input**: Two processes attempt to update same task simultaneously
- **Expected**: First succeeds, second detected and handled appropriately
- **Location**: `src/store/__tests__/concurrency.test.ts`
- **Verification Points**:
  - Lock mechanism prevents simultaneous writes
  - Last-write-wins or conflict error
  - No data corruption
  - Sequence remains valid

#### Test: Concurrent Session and Task Operations
- **Purpose**: Validate safety when session and task operations overlap
- **Input**: Session creation during bulk task import
- **Expected**: Both operations complete safely
- **Location**: `src/store/__tests__/concurrency.test.ts`
- **Verification Points**:
  - No race conditions
  - Session and tasks both persisted
  - Referential integrity maintained

### 2.4 Error Recovery Scenarios

#### Test: Recovery from Partial Write Failure
- **Purpose**: Validate system recovers from interrupted write
- **Input**: Simulate crash during task creation (after insert, before verification)
- **Expected**: Data integrity check detects issue, offers repair
- **Location**: `src/store/__tests__/recovery.test.ts`
- **Verification Points**:
  - `runDataIntegrityCheck()` detects orphaned task
  - Repair procedure removes incomplete data
  - Sequence reset if needed

#### Test: Recovery from Corrupted Data File
- **Purpose**: Validate handling of corrupted JSON files
- **Input**: Corrupt todo.json with malformed JSON
- **Expected**: Error on load, recovery from backup
- **Location**: `src/store/__tests__/recovery.test.ts`
- **Verification Points**:
  - Parse error detected
  - Backup restoration offered
  - Data loss minimized

---

## 3. Migration Safety Tests

### 3.1 Pre-Migration Safety

#### Test: Pre-Migration Checkpoint Created
- **Purpose**: Verify automatic checkpoint before migration
- **Input**: Run migration with existing data
- **Expected**: Git checkpoint created with 'pre-migration' context
- **Location**: `src/store/__tests__/migration-safety.test.ts`
- **Verification Points**:
  - Checkpoint created before any data modification
  - Commit message includes 'pre-migration'
  - Backup of database created
  - Checksums computed for verification

#### Test: Migration State File Creation
- **Purpose**: Verify migration state tracking
- **Input**: Initiate migration
- **Expected**: `.cleo/migration-state.json` created with phase info
- **Location**: `src/store/__tests__/migration-safety.test.ts`
- **Verification Points**:
  - State file exists with 'init' phase
  - Source file checksums recorded
  - Timestamp and version fields present

### 3.2 Migration Interruption Recovery

#### Test: Migration Interruption at Import Phase
- **Purpose**: Verify recovery from mid-migration crash
- **Input**: Simulate crash during 'import' phase
- **Expected**: Migration resumable from checkpoint
- **Location**: `src/store/__tests__/migration-safety.test.ts`
- **Verification Points**:
  - `canResumeMigration()` returns true
  - Phase correctly identified as 'import'
  - Resumed migration completes successfully
  - No duplicate data

#### Test: Migration Interruption at Backup Phase
- **Purpose**: Verify recovery from early migration crash
- **Input**: Simulate crash during 'backup' phase
- **Expected**: Clean restart or resume possible
- **Location**: `src/store/__tests__/migration-safety.test.ts`
- **Verification Points**:
  - No partial database created
  - Original JSON files intact
  - Can restart migration safely

### 3.3 Migration Failure Handling

#### Test: Rollback on Migration Failure
- **Purpose**: Verify automatic rollback on failure
- **Input**: Corrupt JSON that causes parse error during migration
- **Expected**: Database restored from pre-migration backup
- **Location**: `src/store/__tests__/migration-safety.test.ts`
- **Verification Points**:
  - Error detected before destructive changes
  - Backup restored if changes made
  - Original JSON files unchanged
  - Migration state marked as 'failed'

#### Test: Migration Dry-Run Mode
- **Purpose**: Validate migration without making changes
- **Input**: Run migration with `dryRun: true`
- **Expected**: Preview only, no database modifications
- **Location**: `src/store/__tests__/migration-safety.test.ts`
- **Verification Points**:
  - No tasks.db created/modified
  - Report shows expected import counts
  - JSON files unchanged

### 3.4 Post-Migration Validation

#### Test: Data Verification After Migration
- **Purpose**: Verify all data migrated correctly
- **Input**: Run migration with full dataset
- **Expected**: All tasks, sessions, archived tasks present
- **Location**: `src/store/__tests__/migration-safety.test.ts`
- **Verification Points**:
  - Task count matches source JSON
  - All task fields preserved
  - Dependencies maintained
  - Sessions migrated correctly

#### Test: Zero Data Loss Validation
- **Purpose**: Guarantee no data lost during migration
- **Input**: Complex dataset with all edge cases
- **Expected**: 100% data preservation
- **Location**: `src/store/__tests__/migration-safety.test.ts`
- **Verification Points**:
  - Source and destination checksums compared
  - Every task field verified
  - No orphaned records
  - Archive data preserved

---

## 4. Collision Detection Tests

### 4.1 ID Collision Scenarios

#### Test: Same ID in Quick Succession
- **Purpose**: Detect collisions from rapid operations
- **Input**: Two `createTaskSafe()` calls with same ID within 10ms
- **Expected**: First succeeds, second throws collision error
- **Location**: `src/store/__tests__/collision-detection.test.ts`
- **Verification Points**:
  - Both operations use same sequence counter
  - Collision detected before second write
  - Sequence not double-incremented

#### Test: ID Collision Across Different Operations
- **Purpose**: Detect collisions across operation types
- **Input**: Create task, then create session with same ID format
- **Expected**: Both succeed (different namespaces), verify no false positives
- **Location**: `src/store/__tests__/collision-detection.test.ts`
- **Verification Points**:
  - Task namespace separate from session namespace
  - No collision false positives

#### Test: Sequence Repair After Collision Attempt
- **Purpose**: Ensure sequence consistency after collision
- **Input**: Attempt collision (fails), then create with new ID
- **Expected**: Sequence correct, new task gets proper ID
- **Location**: `src/store/__tests__/collision-detection.test.ts`
- **Verification Points**:
  - Sequence counter valid after failed attempt
  - New task receives sequential ID
  - No gaps in ID sequence

### 4.2 Namespace Collision Tests

#### Test: Task vs Archive ID Collision
- **Purpose**: Handle archived task ID conflicts
- **Input**: Archive task T100, attempt to create new task T100
- **Expected**: New task creation succeeds (archive is separate)
- **Location**: `src/store/__tests__/collision-detection.test.ts`
- **Verification Points**:
  - Active task namespace separate from archive
  - Archived task IDs reusable (optional)

---

## 5. Write Verification Tests

### 5.1 Verification Scenarios

#### Test: Successful Write Verification
- **Purpose**: Confirm successful writes are verified
- **Input**: Create task with verify enabled
- **Expected**: Read-back data matches written data exactly
- **Location**: `src/store/__tests__/write-verification.test.ts`
- **Verification Points**:
  - Tasks array present in read-back
  - Task count matches
  - Last written task found
  - All primitive fields match

#### Test: Failed Write Detection
- **Purpose**: Detect when write fails silently
- **Input**: Mock write to return success but not persist
- **Expected**: Verification detects missing data
- **Location**: `src/store/__tests__/write-verification.test.ts`
- **Verification Points**:
  - `VERIFICATION_FAILED` error thrown
  - Expected vs actual counts in error
  - Context includes operation details

#### Test: Partial Write Detection
- **Purpose**: Detect incomplete writes (e.g., power loss)
- **Input**: Write partial JSON (truncated)
- **Expected**: Parse error during verification
- **Location**: `src/store/__tests__/write-verification.test.ts`
- **Verification Points**:
  - JSON parse error caught
  - Error indicates file corruption
  - Recovery procedures suggested

#### Test: Database Corruption Detection
- **Purpose**: Detect corrupted database structure
- **Input**: Corrupt SQLite database (random bytes in file)
- **Expected**: Load failure detected during verification
- **Location**: `src/store/__tests__/write-verification.test.ts`
- **Verification Points**:
  - Database load throws error
  - Corruption detected before data access
  - Backup restoration initiated

### 5.2 Verification Options

#### Test: Verification Disabled
- **Purpose**: Allow high-performance mode without verification
- **Input**: Write with `verify: false`
- **Expected**: Write succeeds without read-back
- **Location**: `src/store/__tests__/write-verification.test.ts`
- **Verification Points**:
  - No read-back performed
  - `stats.verifications` not incremented
  - Faster operation completion

---

## 6. Recovery Procedure Tests

### 6.1 Checkpoint Restoration

#### Test: Restore from Checkpoint
- **Purpose**: Verify data restoration from git checkpoint
- **Input**: Corrupt data, restore from last checkpoint
- **Expected**: Data restored to checkpoint state
- **Location**: `src/store/__tests__/recovery.test.ts`
- **Verification Points**:
  - Git checkout restores files
  - Sequence repaired after restore
  - Data integrity check passes

#### Test: Restore from Multiple Checkpoints
- **Purpose**: Verify restoration from older checkpoint
- **Input**: Multiple checkpoints exist, restore to specific commit
- **Expected**: Data restored to specified point
- **Location**: `src/store/__tests__/recovery.test.ts`
- **Verification Points**:
  - Specific commit checkout works
  - Data from that point loaded
  - Roll forward possible if needed

### 6.2 Sequence Repair

#### Test: Sequence Auto-Repair
- **Purpose**: Verify automatic sequence correction
- **Input**: Sequence counter = 10, max task ID = T15
- **Expected**: Sequence repaired to 16
- **Location**: `src/store/__tests__/recovery.test.ts`
- **Verification Points**:
  - Counter updated to max + 1
  - Repair logged
  - Subsequent operations use correct sequence

#### Test: Sequence Manual Repair
- **Purpose**: Verify manual sequence repair command
- **Input**: Run `cleo sequence repair`
- **Expected**: Sequence file corrected
- **Location**: `src/store/__tests__/recovery.test.ts`
- **Verification Points**:
  - Command updates sequence.json
  - Counter set to max ID + 1
  - Backup of old sequence created

### 6.3 Ghost Entry Cleanup

#### Test: Ghost Entry Detection
- **Purpose**: Detect entries in log but not in database
- **Input**: Log entry for task that doesn't exist in DB
- **Expected**: Ghost entry identified during integrity check
- **Location**: `src/store/__tests__/recovery.test.ts`
- **Verification Points**:
  - `runDataIntegrityCheck()` detects mismatch
  - Ghost entries listed in report
  - Repair option available

#### Test: Ghost Entry Removal
- **Purpose**: Clean up orphaned log entries
- **Input**: Run cleanup command with ghost entries present
- **Expected**: Ghost entries removed, logs compacted
- **Location**: `src/store/__tests__/recovery.test.ts`
- **Verification Points**:
  - Log entries for missing tasks removed
  - Valid log entries preserved
  - Integrity check passes after cleanup

### 6.4 Data Integrity Restoration

#### Test: Full Integrity Restoration
- **Purpose**: Complete data recovery from various corruption types
- **Input**: Multiple corruption types: sequence invalid, ghost entries, missing tasks
- **Expected**: All issues repaired automatically
- **Location**: `src/store/__tests__/recovery.test.ts`
- **Verification Points**:
  - Sequence repaired
  - Ghost entries cleaned
  - Missing tasks identified
  - Final integrity check passes

---

## 7. Performance Test Criteria

### 7.1 Write Operation Performance

#### Test: Single Write Latency
- **Purpose**: Measure time for single task creation with full safety
- **Target**: <100ms (including verify + checkpoint)
- **Acceptance**: 95th percentile under 100ms
- **Location**: `src/store/__tests__/performance.test.ts`
- **Measurement**: `Date.now()` before/after `createTaskSafe()`
- **Environment**: Local SSD, no network delays

#### Test: Bulk Write Performance
- **Purpose**: Measure batch operation performance
- **Target**: <500ms for 50 tasks
- **Acceptance**: Linear scaling, <10ms per task
- **Location**: `src/store/__tests__/performance.test.ts`
- **Measurement**: Total time for batch creation

### 7.2 Checkpoint Performance

#### Test: Checkpoint Frequency
- **Purpose**: Verify checkpoints occur at configured intervals
- **Target**: Every 5 minutes (configurable)
- **Acceptance**: ±30 seconds of target interval
- **Location**: `src/store/__tests__/performance.test.ts`
- **Measurement**: Time between checkpoint timestamps

#### Test: Checkpoint Overhead
- **Purpose**: Measure time impact of checkpointing
- **Target**: <50ms per checkpoint
- **Acceptance**: Non-blocking, async execution
- **Location**: `src/store/__tests__/performance.test.ts`
- **Measurement**: Git operation timing

### 7.3 Verification Overhead

#### Test: Write Verification Latency
- **Purpose**: Measure cost of read-back verification
- **Target**: <50ms for typical task file
- **Acceptance**: <100ms for files <1MB
- **Location**: `src/store/__tests__/performance.test.ts`
- **Measurement**: Time between write and verification complete

#### Test: Sequence Check Overhead
- **Purpose**: Measure sequence validation cost
- **Target**: <10ms per operation
- **Acceptance**: <25ms even with large datasets
- **Location**: `src/store/__tests__/performance.test.ts`
- **Measurement**: `checkSequence()` execution time

### 7.4 Concurrent Operation Handling

#### Test: Concurrent Write Scaling
- **Purpose**: Measure performance with concurrent operations
- **Target**: Linear scaling up to 4 concurrent operations
- **Acceptance**: No deadlocks, <2x single-operation time
- **Location**: `src/store/__tests__/performance.test.ts`
- **Measurement**: Total time for N concurrent operations

---

## 8. Test Environment Setup

### 8.1 Test Database Setup

#### SQLite Test Database
- **Location**: Temp directory per test (`tmpdir()` + unique suffix)
- **Isolation**: Each test gets fresh database
- **Teardown**: Automatic cleanup after each test
- **Schema**: Full production schema applied
- **Seeding**: Optional test data fixtures

```typescript
// Example setup pattern
beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'cleo-test-'));
  cleoDir = join(tempDir, '.cleo');
  process.env['CLEO_DIR'] = cleoDir;
  // Initialize database
});

afterEach(async () => {
  delete process.env['CLEO_DIR'];
  await rm(tempDir, { recursive: true, force: true });
});
```

#### Mock Database Configuration
- **Purpose**: Fast unit tests without filesystem
- **Implementation**: In-memory SQLite (`:memory:`)
- **Use Cases**: Safety logic tests, collision detection
- **Limitations**: No checkpoint testing

### 8.2 Mock Git Repository

#### Git Repository Setup
- **Location**: Temp directory with initialized git repo
- **Configuration**: Dummy user.name/user.email
- **Initial Commit**: Empty commit for baseline
- **Hooks**: Disabled for test speed

```typescript
// Git initialization
await execFile('git', ['init'], { cwd: tempDir });
await execFile('git', ['config', 'user.name', 'Test User'], { cwd: tempDir });
await execFile('git', ['config', 'user.email', 'test@example.com'], { cwd: tempDir });
```

#### Git Checkpoint Mocking
- **Purpose**: Test without actual git operations
- **Implementation**: Vitest mocks for `gitCheckpoint()`
- **Verification**: Mock call assertions
- **Use Cases**: Unit tests for safety logic

### 8.3 Simulated Failure Injection

#### Filesystem Failure Simulation
- **Method**: Proxyquire or dependency injection
- **Scenarios**: 
  - `EACCES` permission denied
  - `ENOSPC` disk full
  - `EIO` I/O error
  - `EPIPE` broken pipe
- **Library**: `mock-fs` or custom wrappers

#### Network Failure Simulation (for future use)
- **Method**: Nock or MSW for HTTP mocking
- **Scenarios**: Timeout, connection reset, 5xx errors
- **Use Cases**: Remote backup sync testing

#### Corruption Injection
- **Method**: Direct file manipulation
- **Scenarios**:
  - Truncated JSON files
  - Random byte corruption
  - Missing closing braces
  - Invalid UTF-8 sequences
- **Verification**: Detection and recovery

### 8.4 Performance Measurement Tools

#### Benchmark Harness
- **Library**: `benchmark` or custom timing
- **Metrics**: Mean, median, p95, p99 latencies
- **Warmup**: 10 iterations before measurement
- **Samples**: Minimum 100 measurements
- **Output**: JSON results for CI tracking

#### Memory Profiling
- **Tool**: Node.js `--inspect` + Chrome DevTools
- **Metrics**: Heap usage, leak detection
- **Scenarios**: Long-running operations, bulk imports
- **Threshold**: <100MB growth over 1000 operations

---

## 9. CI/CD Integration

### 9.1 Pre-Commit Safety Checks

#### Git Pre-Commit Hook
- **Trigger**: `git commit` command
- **Checks**:
  1. Run `cleo --validate` for data integrity
  2. Verify sequence consistency
  3. Check for uncheckpointed changes
  4. Run unit tests for modified files
- **Failure Behavior**: Block commit, show errors
- **Bypass**: `--no-verify` (with warning)

```bash
#!/bin/sh
# .git/hooks/pre-commit
echo "Running CLEO safety checks..."
cleo --validate || exit 1
cleo sequence check || exit 1
```

#### Pre-Push Validation
- **Trigger**: `git push` command
- **Checks**:
  1. Full test suite for affected modules
  2. Integration tests for safety mechanisms
  3. Lint and type checking
- **Timeout**: 5 minutes maximum

### 9.2 PR Validation Tests

#### Pull Request CI Pipeline
- **Trigger**: PR opened or updated
- **Stages**:
  1. **Build**: Compile TypeScript, check types
  2. **Unit Tests**: All unit tests (parallel)
  3. **Integration Tests**: Safety integration tests
  4. **Safety Tests**: Data safety specific tests
  5. **Performance Tests**: Baseline performance checks
- **Requirements**: All stages pass for merge

#### Safety-Specific Test Suite
- **Command**: `npm test -- --testPathPattern="safety|collision|recovery"`
- **Timeout**: 10 minutes
- **Coverage Requirement**: 100% of safety code paths
- **Parallelization**: 4 workers

### 9.3 Nightly Integrity Checks

#### Scheduled Nightly Job
- **Schedule**: Daily at 2:00 AM UTC
- **Duration**: 30-60 minutes
- **Environment**: Clean VM, production-like dataset

#### Comprehensive Checks
1. **Full Test Suite**: All 2000+ tests
2. **Data Integrity**: `runDataIntegrityCheck()` on sample data
3. **Collision Detection**: Stress test with 1000 rapid creates
4. **Recovery Procedures**: Full backup/restore cycle
5. **Performance Baseline**: Compare to previous runs

#### Reporting
- **Success**: Silent (no notification)
- **Failure**: Slack/email alert to team
- **Metrics**: Published to monitoring dashboard

### 9.4 Migration Dry-Run Tests

#### Pre-Release Migration Testing
- **Trigger**: Release candidate created
- **Scenarios**:
  1. Clean migration (no existing DB)
  2. Migration with existing data (force mode)
  3. Migration interruption and resume
  4. Migration rollback on failure
- **Data Sets**:
  - Minimal (10 tasks)
  - Medium (500 tasks)
  - Large (10,000 tasks)
  - Edge cases (all field types, dependencies)

#### Migration Performance Gates
- **Small Dataset**: <5 seconds
- **Medium Dataset**: <30 seconds
- **Large Dataset**: <5 minutes
- **Memory Usage**: <500MB peak

---

## Test File Organization

```
src/store/__tests__/
├── data-safety-central.test.ts      # Core safety mechanism tests
├── collision-detection.test.ts      # ID collision tests
├── write-verification.test.ts       # Write verification tests
├── sequence-validation.test.ts      # Sequence safety tests
├── recovery.test.ts                 # Recovery procedure tests
├── migration-safety.test.ts         # Migration safety tests
├── task-lifecycle.test.ts           # End-to-end task tests
├── session-lifecycle.test.ts        # End-to-end session tests
├── concurrency.test.ts              # Concurrent operation tests
├── bulk-operations.test.ts          # Bulk operation tests
├── performance.test.ts              # Performance benchmarks
└── integration-safety.test.ts       # Full integration tests
```

---

## Success Criteria

### Minimum Viable Testing
- ✅ 100% of safety code paths covered by unit tests
- ✅ All collision scenarios tested
- ✅ All write verification scenarios tested
- ✅ Migration safety tests passing
- ✅ Recovery procedures tested

### Full Compliance
- ✅ Integration tests for all lifecycle workflows
- ✅ Concurrent operation safety validated
- ✅ Performance criteria met (latency <100ms)
- ✅ CI/CD pipeline passing
- ✅ Nightly integrity checks passing
- ✅ Zero data loss in migration tests

### Continuous Validation
- ✅ Pre-commit hooks active
- ✅ PR validation blocking on failures
- ✅ Nightly tests running
- ✅ Performance regression alerts
- ✅ Safety violation logging

---

## References

- **Safety Implementation**: `src/store/data-safety-central.ts`
- **Safety Guide**: `docs/SAFETY-GUIDE.md`
- **Incident Report**: `.cleo/INCIDENT-2026-02-19-database-corruption.md`
- **Existing Tests**: `src/store/__tests__/`
- **Test Framework**: Vitest

---

## Document Maintenance

- **Update Frequency**: After each safety-related change
- **Review Cycle**: Monthly
- **Owner**: Data Safety Team
- **Approval**: Technical Lead sign-off required

---

**Version History**:
- 2026.2.19 - Initial creation (T4746)
