# T5168 Bug Analysis: Task Relations Data Flow Investigation

## Executive Summary

**The Bug**: The `relates` field appears to work but is fundamentally broken due to a missing read path. Data is written to the database but never loaded back.

**Root Cause**: 
- `addRelation()` writes to `task_relations` table (working)
- `loadTaskFile()` NEVER reads from `task_relations` table (broken)
- The `relates` field exists in runtime code but not in the Task type

**Impact**: Relations appear to persist within a session (cached in memory) but disappear on restart.

---

## Current (Broken) Data Flow

### Write Path (WORKING)

```
┌─────────────────────────────────────────────────────────────────────────────┐
│ CLI / API Call                                                              │
│   ct relates add T001 T002 --type blocks                                    │
└─────────────────────┬───────────────────────────────────────────────────────┘
                      │
                      ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ dispatch/domains/tasks.ts                                                   │
│   case 'relates.add':                                                       │
│     return taskRelatesAdd(projectRoot, params)                              │
└─────────────────────┬───────────────────────────────────────────────────────┘
                      │
                      ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ core/tasks/task-ops.ts - coreTaskRelatesAdd()                               │
│   1. Load TaskFile via accessor.loadTaskFile()                              │
│   2. Add relation to task.relates[] array (in-memory)                       │
│   3. Call accessor.upsertSingleTask(fromTask)                               │
│   4. Call accessor.addRelation(taskId, relatedId, type)  ←──┐               │
└─────────────────────┬───────────────────────────────────────┘               │
                      │                                                      │
                      ▼                                                      │
┌────────────────────────────────────────────────────────────────────────────┴┐
│ src/store/sqlite-data-accessor.ts - addRelation()                           │
│   Writes to task_relations table:                                           │
│   INSERT INTO task_relations (task_id, related_to, relation_type)           │
│   VALUES ('T001', 'T002', 'blocks')                                         │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Read Path (BROKEN)

```
┌─────────────────────────────────────────────────────────────────────────────┐
│ CLI / API Call                                                              │
│   ct relates show T001                                                      │
└─────────────────────┬───────────────────────────────────────────────────────┘
                      │
                      ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ dispatch/domains/tasks.ts                                                   │
│   case 'relates':                                                           │
│     return taskRelates(projectRoot, params)                                 │
└─────────────────────┬───────────────────────────────────────────────────────┘
                      │
                      ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ core/tasks/task-ops.ts - coreTaskRelates()                                  │
│   1. Load TaskFile via accessor.loadTaskFile()                              │
│   2. Return task.relates  ←── PROBLEM: This is ALWAYS empty!                │
└─────────────────────────────────────────────────────────────────────────────┘

PROBLEM DETAIL:
┌─────────────────────────────────────────────────────────────────────────────┐
│ src/store/sqlite-data-accessor.ts - loadTaskFile()                          │
│                                                                             │
│   async loadTaskFile(): Promise<TaskFile> {                                 │
│     // 1. Query tasks table                                                 │
│     const taskRows = await db.select().from(schema.tasks)...               │
│     const tasks: Task[] = taskRows.map(rowToTask);                          │
│                                                                             │
│     // 2. Load dependencies ←── EXISTS!                                     │
│     await loadDependenciesForTasks(db, tasks);                              │
│                                                                             │
│     // 3. Load project meta, work state, labels, file meta                  │
│                                                                             │
│     // 4. MISSING! No loadRelationsForTasks() call!                        │
│                                                                             │
│     return { version, project, lastUpdated, _meta, focus, tasks };         │
│   }                                                                         │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## The Duplicate Storage Problem

There's confusion about WHERE relations are stored:

### 1. In-Memory Runtime Extension (relates.ts)
```typescript
// src/core/tasks/relates.ts - addRelation()
const taskAny = fromTask as unknown as Record<string, unknown>;
if (!taskAny.relates) {
  taskAny.relates = [];
}
const relates = taskAny.relates as Relation[];
relates.push({
  targetId: to,
  type,
  reason,
  addedAt: new Date().toISOString(),
});
```
- Stores in task object during runtime
- **Not persisted** to tasks.json or database
- Lost on reload

### 2. Database Table (task_relations)
```typescript
// src/store/sqlite-data-accessor.ts - addRelation()
await db.insert(schema.taskRelations)
  .values({ taskId, relatedTo, relationType: normalizedType })
  .onConflictDoNothing()
  .run();
```
- Writes to SQLite table
- **Never read back** by loadTaskFile()
- Data exists but is orphaned

### 3. Task Type Definition (MISSING!)
```typescript
// src/types/task.ts - Task interface
export interface Task {
  id: string;
  title: string;
  status: TaskStatus;
  // ... many fields ...
  depends?: string[];  // ←── EXISTS
  // relates? is MISSING from the type definition!
}
```

---

## Correct Data Flow (After Fix)

```
┌─────────────────────────────────────────────────────────────────────────────┐
│ WRITE PATH (unchanged)                                                      │
│   addRelation() → task_relations table                                      │
└─────────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────────┐
│ READ PATH (fixed)                                                           │
│                                                                             │
│   loadTaskFile()                                                            │
│     ├── SELECT * FROM tasks → Task[]                                        │
│     ├── loadDependenciesForTasks(db, tasks)     ←── exists                  │
│     └── loadRelationsForTasks(db, tasks)        ←── NEEDS TO BE ADDED       │
│                                                                             │
│   loadRelationsForTasks() (new function in db-helpers.ts)                   │
│     ├── SELECT * FROM task_relations WHERE task_id IN (...)                 │
│     ├── Map relations by task_id                                            │
│     └── Assign to task.relates[]                                            │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## Required Changes (6 Files)

### 1. src/types/task.ts
**Add relates field to Task interface**
```typescript
export interface Task {
  // ... existing fields ...
  depends?: string[];
  relates?: Array<{ taskId: string; type: string; reason?: string }>;  // ← ADD
}
```

### 2. src/store/schema.ts
**Expand relation_type enum (optional but recommended)**
```typescript
export const taskRelations = sqliteTable('task_relations', {
  taskId: text('task_id').notNull().references(() => tasks.id, { onDelete: 'cascade' }),
  relatedTo: text('related_to').notNull().references(() => tasks.id, { onDelete: 'cascade' }),
  relationType: text('relation_type', {
    enum: ['related', 'blocks', 'duplicates', 'absorbs', 'fixes', 'extends', 'supersedes'],  // ← EXPAND
  }).notNull().default('related'),
  reason: text('reason'),  // ← ADD for storing relation reason
}, (table) => [
  primaryKey({ columns: [table.taskId, table.relatedTo] }),
]);
```

**Note**: Schema changes require `drizzle-kit generate --custom` because CHECK constraint changes are invisible to drizzle-kit's diff engine.

### 3. src/store/db-helpers.ts
**Create loadRelationsForTasks() function**
```typescript
/**
 * Batch-load relations for a list of tasks and apply them in-place.
 * Mirrors loadDependenciesForTasks pattern.
 */
export async function loadRelationsForTasks(
  db: DrizzleDb,
  tasks: Task[],
): Promise<void> {
  if (tasks.length === 0) return;
  const taskIds = tasks.map(t => t.id);

  const allRelations = await db.select().from(schema.taskRelations)
    .where(inArray(schema.taskRelations.taskId, taskIds))
    .all();

  const relationMap = new Map<string, Array<{ taskId: string; type: string; reason?: string }>>();
  for (const rel of allRelations) {
    let arr = relationMap.get(rel.taskId);
    if (!arr) {
      arr = [];
      relationMap.set(rel.taskId, arr);
    }
    arr.push({
      taskId: rel.relatedTo,
      type: rel.relationType,
      // reason: rel.reason,  // if added to schema
    });
  }

  for (const task of tasks) {
    const relations = relationMap.get(task.id);
    if (relations && relations.length > 0) {
      task.relates = relations;
    }
  }
}
```

### 4. src/store/sqlite-data-accessor.ts
**Call loadRelationsForTasks in loadTaskFile()**
```typescript
async loadTaskFile(): Promise<TaskFile> {
  // ... existing code ...
  
  // 2. Load dependencies for all tasks (batch query)
  if (tasks.length > 0) {
    await loadDependenciesForTasks(db, tasks);
    await loadRelationsForTasks(db, tasks);  // ← ADD THIS LINE
  }
  
  // ... rest of function ...
}
```

**Call loadRelationsForTasks in loadArchive()**
```typescript
async loadArchive(): Promise<ArchiveFile | null> {
  // ... existing code to load archived tasks ...
  
  // Load dependencies AND relations for archived tasks
  if (archivedTasks.length > 0) {
    const activeRows = await db
      .select({ id: schema.tasks.id })
      .from(schema.tasks)
      .where(ne(schema.tasks.status, 'archived'))
      .all();
    const allKnownIds = new Set([
      ...archivedTasks.map(t => t.id),
      ...activeRows.map(r => r.id),
    ]);
    await loadDependenciesForTasks(db, archivedTasks, allKnownIds);
    await loadRelationsForTasks(db, archivedTasks);  // ← ADD THIS LINE
  }
  
  // ... rest of function ...
}
```

### 5. src/store/sqlite-data-accessor.ts (addRelation method)
**Fix type normalization (current silently normalizes invalid types)**
```typescript
async addRelation(taskId: string, relatedTo: string, relationType: string): Promise<void> {
  const db = await getDb(cwd);
  const validTypes = ['related', 'blocks', 'duplicates'] as const;
  
  // Option A: Throw on invalid type (fail fast)
  if (!validTypes.includes(relationType as typeof validTypes[number])) {
    throw new Error(`Invalid relation type: ${relationType}. Valid types: ${validTypes.join(', ')}`);
  }
  
  // Option B: Keep normalization but log warning
  // const normalizedType = validTypes.includes(relationType as typeof validTypes[number])
  //   ? relationType as typeof validTypes[number]
  //   : 'related' as const;
  // if (normalizedType !== relationType) {
  //   console.warn(`Normalized invalid relation type '${relationType}' to 'related'`);
  // }
  
  await db.insert(schema.taskRelations)
    .values({ taskId, relatedTo, relationType })
    .onConflictDoNothing()
    .run();
}
```

### 6. Tests
**Add round-trip test**
```typescript
// tests/integration/relations.test.ts
it('should persist and reload relations across sessions', async () => {
  // Setup
  const accessor = await createSqliteDataAccessor(testCwd);
  
  // Add task with relation
  await accessor.upsertSingleTask({
    id: 'T001',
    title: 'Task 1',
    status: 'pending',
    priority: 'medium',
    createdAt: new Date().toISOString(),
  });
  await accessor.upsertSingleTask({
    id: 'T002',
    title: 'Task 2',
    status: 'pending',
    priority: 'medium',
    createdAt: new Date().toISOString(),
  });
  await accessor.addRelation('T001', 'T002', 'blocks');
  
  // Close and reopen accessor (simulates restart)
  await accessor.close();
  const newAccessor = await createSqliteDataAccessor(testCwd);
  
  // Reload and verify
  const taskFile = await newAccessor.loadTaskFile();
  const task = taskFile.tasks.find(t => t.id === 'T001');
  
  expect(task?.relates).toHaveLength(1);
  expect(task?.relates?.[0]).toEqual({
    taskId: 'T002',
    type: 'blocks',
  });
});
```

**Add type validation test**
```typescript
it('should reject invalid relation types', async () => {
  const accessor = await createSqliteDataAccessor(testCwd);
  
  await expect(
    accessor.addRelation('T001', 'T002', 'invalid-type')
  ).rejects.toThrow('Invalid relation type');
});
```

---

## Visual Comparison: Dependencies vs Relations

### Dependencies (WORKING)
```
┌─────────────────────────────────────────────────────────────────┐
│ Table: task_dependencies                                        │
├──────────────┬──────────────┬───────────────────────────────────┤
│ task_id      │ depends_on   │                                   │
├──────────────┼──────────────┼───────────────────────────────────┤
│ T001         │ T002         │                                   │
│ T001         │ T003         │                                   │
└──────────────┴──────────────┴───────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────┐
│ Load Path                                                       │
├─────────────────────────────────────────────────────────────────┤
│ loadTaskFile()                                                  │
│   └── loadDependenciesForTasks(db, tasks)     ←── CALLED ✓      │
│         └── SELECT * FROM task_dependencies                     │
│         └── Map to task.depends[]                               │
└─────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────┐
│ Task Type                                                       │
├─────────────────────────────────────────────────────────────────┤
│ interface Task {                                                │
│   depends?: string[];              ←── DEFINED ✓                │
│ }                                                               │
└─────────────────────────────────────────────────────────────────┘
```

### Relations (BROKEN)
```
┌─────────────────────────────────────────────────────────────────┐
│ Table: task_relations                                           │
├──────────────┬──────────────┬─────────────────┬─────────────────┤
│ task_id      │ related_to   │ relation_type   │ reason          │
├──────────────┼──────────────┼─────────────────┼─────────────────┤
│ T001         │ T002         │ blocks          │ NULL            │
│ T001         │ T003         │ duplicates      │ NULL            │
└──────────────┴──────────────┴─────────────────┴─────────────────┘

┌─────────────────────────────────────────────────────────────────┐
│ Load Path                                                       │
├─────────────────────────────────────────────────────────────────┤
│ loadTaskFile()                                                  │
│   └── loadRelationsForTasks(db, tasks)        ←── MISSING ✗     │
│         (function doesn't exist!)                               │
└─────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────┐
│ Task Type                                                       │
├─────────────────────────────────────────────────────────────────┤
│ interface Task {                                                │
│   // relates? is MISSING from type!          ←── MISSING ✗      │
│ }                                                               │
└─────────────────────────────────────────────────────────────────┘
```

---

## Migration Strategy

### Step 1: Implement loadRelationsForTasks()
- Add function to db-helpers.ts
- Add call sites in sqlite-data-accessor.ts
- Add relates field to Task interface
- Run tests to verify round-trip works

### Step 2: Schema Enhancement (Optional)
- Add more relation types to enum
- Add reason column
- Generate migration with `drizzle-kit generate --custom`

### Step 3: Fix Type Safety
- Remove silent normalization in addRelation()
- Throw on invalid types or add validation layer

### Step 4: Backward Compatibility
- Existing data in task_relations table will suddenly appear once fix is deployed
- This is actually a feature - "lost" relations will be recovered!

---

## Testing Checklist

- [ ] Round-trip test: add relation → close accessor → reopen → verify loaded
- [ ] Archive test: relations persist on archived tasks
- [ ] Type validation test: invalid types rejected
- [ ] Duplicate prevention test: same relation added twice handled gracefully
- [ ] Delete cascade test: deleting task removes its relations
- [ ] Cross-reference test: querying T002 shows it's related by T001

---

## Summary

**The Problem**: Relations are written but never read, making the feature appear to work during a session but fail on reload.

**The Fix**: Add `loadRelationsForTasks()` following the `loadDependenciesForTasks()` pattern, and wire it into `loadTaskFile()` and `loadArchive()`.

**The Impact**: One missing function call causes complete feature failure. This is a classic "write-only" bug where data goes into the database but can't come out.

**Files to Modify**:
1. src/types/task.ts - Add relates field
2. src/store/schema.ts - Expand enum + add reason column (optional)
3. src/store/db-helpers.ts - Create loadRelationsForTasks()
4. src/store/sqlite-data-accessor.ts - Call it (2 places) + fix type normalization
5. Tests - Round-trip and validation tests

**Estimated Effort**: Small to medium (pattern already exists, just needs mirroring)
