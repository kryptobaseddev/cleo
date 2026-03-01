# T5168 Data Flow Diagrams

## ASCII Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────────────────────┐
│                              CLEO TASK RELATIONS SYSTEM                              │
└─────────────────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────────────────┐
│  LAYER 1: USER INTERFACE                                                            │
│  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐                     │
│  │   CLI Command   │  │   MCP Query     │  │   Direct API    │                     │
│  │ ct relates add  │  │ tasks.relates   │  │  addRelation()  │                     │
│  └────────┬────────┘  └────────┬────────┘  └────────┬────────┘                     │
└───────────┼────────────────────┼────────────────────┼───────────────────────────────┘
            │                    │                    │
            └────────────────────┼────────────────────┘
                                 ▼
┌─────────────────────────────────────────────────────────────────────────────────────┐
│  LAYER 2: DISPATCH & CORE                                                           │
│  ┌──────────────────────────────┐    ┌─────────────────────────────────────────┐   │
│  │   dispatch/domains/tasks.ts  │    │      core/tasks/task-ops.ts             │   │
│  │                              │    │                                         │   │
│  │   case 'relates.add':        │───▶│   coreTaskRelatesAdd()                  │   │
│  │     return taskRelatesAdd()  │    │     ├── Load TaskFile                   │   │
│  │                              │    │     ├── Add to task.relates[]           │   │
│  │   case 'relates':            │───▶│     ├── Call upsertSingleTask()         │   │
│  │     return taskRelates()     │    │     └── Call accessor.addRelation()     │   │
│  └──────────────────────────────┘    │         ▲                                 │   │
│                                      └─────────┼─────────────────────────────────┘   │
│                                                │                                     │
└────────────────────────────────────────────────┼─────────────────────────────────────┘
                                                 │
                                                 ▼
┌─────────────────────────────────────────────────────────────────────────────────────┐
│  LAYER 3: DATA ACCESSOR (SQLite)                                                    │
│  ┌──────────────────────────────────────────────────────────────────────────────┐  │
│  │                     src/store/sqlite-data-accessor.ts                        │  │
│  │                                                                              │  │
│  │  ┌────────────────────────────────────────────────────────────────────────┐  │  │
│  │  │ WRITE PATH (WORKING ✓)                                                │  │  │
│  │  │                                                                         │  │  │
│  │  │   addRelation(taskId, relatedTo, type)                                 │  │  │
│  │  │     └── INSERT INTO task_relations                                     │  │  │
│  │  │         VALUES (taskId, relatedTo, type)                               │  │  │
│  │  │         ▲                                                              │  │  │
│  │  │         │ Data successfully written to SQLite                          │  │  │
│  │  └─────────┼──────────────────────────────────────────────────────────────┘  │  │
│  │            │                                                                 │  │
│  │            │                    THE BUG IS HERE                              │  │
│  │            │                                                                 │  │
│  │  ┌─────────┼──────────────────────────────────────────────────────────────┐  │  │
│  │  │ READ PATH (BROKEN ✗)                                                  │  │  │
│  │  │                                                                         │  │  │
│  │  │   loadTaskFile()                                                       │  │  │
│  │  │     ├── SELECT * FROM tasks           ←── Loads task rows              │  │  │
│  │  │     ├── loadDependenciesForTasks()    ←── EXISTS ✓                     │  │  │
│  │  │     │   └── Populates task.depends[]                                   │  │  │
│  │  │     │                                                                   │  │  │
│  │  │     └── [MISSING!] loadRelationsForTasks()   ←── NOT CALLED ✗         │  │  │
│  │  │         └── Should populate task.relates[]                             │  │  │
│  │  │                                              ▲                         │  │  │
│  │  │                                              │                         │  │  │
│  │  │   Data in task_relations table NEVER READ!   │                         │  │  │
│  │  └──────────────────────────────────────────────┘                         │  │  │
│  └──────────────────────────────────────────────────────────────────────────┘  │  │
└──────────────────────────────────────────────────────────────────────────────────┘  │
                                                                                       │
                                                 ┌─────────────────────────────────────┘
                                                 │
                                                 ▼
┌─────────────────────────────────────────────────────────────────────────────────────┐
│  LAYER 4: DATABASE                                                                  │
│  ┌─────────────────────────────┐    ┌─────────────────────────────┐                │
│  │      tasks table            │    │   task_relations table      │                │
│  ├──────┬──────────┬───────────┤    ├──────┬──────────┬───────────┤                │
│  │  id  │  title   │  status   │    │task_id│related_to│ relation_ │                │
│  ├──────┼──────────┼───────────┤    ├──────┼──────────┤   type    │                │
│  │ T001 │ Task 1   │ pending   │◄───┤ T001 │   T002   │  blocks   │                │
│  │ T002 │ Task 2   │ pending   │◄───┤ T001 │   T003   │duplicates │                │
│  └──────┴──────────┴───────────┘    └──────┴──────────┴───────────┘                │
│                                                                                     │
│  ┌─────────────────────────────┐    ┌─────────────────────────────┐                │
│  │ task_dependencies table     │    │    schema_meta table        │                │
│  ├──────┬──────────┬───────────┤    ├──────┬──────────────────────┤                │
│  │task_id│depends_on│           │    │ key  │       value          │                │
│  ├──────┼──────────┤           │    ├──────┼──────────────────────┤                │
│  │ T001 │   T002   │           │    │project_meta│ {JSON}         │                │
│  │ T001 │   T003   │           │    │focus_state │ {JSON}         │                │
│  └──────┴──────────┴───────────┘    │file_meta   │ {JSON}         │                │
│                                     └──────┴──────────────────────┘                │
└─────────────────────────────────────────────────────────────────────────────────────┘
```

---

## Dependency Loading Pattern (WORKING)

```
┌────────────────────────────────────────────────────────────────────────────────┐
│                      HOW DEPENDENCIES WORK (CORRECTLY)                         │
└────────────────────────────────────────────────────────────────────────────────┘

┌────────────────────────────────────────────────────────────────────────────────┐
│ Step 1: Store Dependencies                                                      │
│                                                                                 │
│   addDependency(T001, T002)                                                     │
│     │                                                                           │
│     └── INSERT INTO task_dependencies (task_id, depends_on)                     │
│         VALUES ('T001', 'T002')                                                 │
│                                                                                 │
├────────────────────────────────────────────────────────────────────────────────┤
│ Step 2: Load Dependencies                                                       │
│                                                                                 │
│   loadTaskFile()                                                                │
│     │                                                                           │
│     ├── SELECT * FROM tasks WHERE status != 'archived'                          │
│     │   → Task[] (task.depends is undefined at this point)                     │
│     │                                                                           │
│     └── await loadDependenciesForTasks(db, tasks)    ←── CALLED!               │
│         │                                                                       │
│         ├── SELECT * FROM task_dependencies                                     │
│         │   WHERE task_id IN ('T001', 'T002', ...)                              │
│         │                                                                       │
│         ├── Map task_id → depends_on[]                                          │
│         │   { 'T001': ['T002', 'T003'], ... }                                   │
│         │                                                                       │
│         └── FOR each task: task.depends = map.get(task.id)                      │
│             → Task[] with populated task.depends[]                              │
│                                                                                 │
├────────────────────────────────────────────────────────────────────────────────┤
│ Step 3: Use Dependencies                                                        │
│                                                                                 │
│   task.depends  → ['T002', 'T003']  ✓ AVAILABLE                                 │
│                                                                                 │
└────────────────────────────────────────────────────────────────────────────────┘
```

---

## Relation Loading Pattern (BROKEN)

```
┌────────────────────────────────────────────────────────────────────────────────┐
│                      HOW RELATIONS WORK (BROKEN)                               │
└────────────────────────────────────────────────────────────────────────────────┘

┌────────────────────────────────────────────────────────────────────────────────┐
│ Step 1: Store Relations                                                         │
│                                                                                 │
│   addRelation(T001, T002, 'blocks')                                             │
│     │                                                                           │
│     └── INSERT INTO task_relations (task_id, related_to, relation_type)         │
│         VALUES ('T001', 'T002', 'blocks')                                       │
│                                                                                 │
│   ✓ Data is successfully stored in SQLite!                                      │
│                                                                                 │
├────────────────────────────────────────────────────────────────────────────────┤
│ Step 2: Load Relations                                                          │
│                                                                                 │
│   loadTaskFile()                                                                │
│     │                                                                           │
│     ├── SELECT * FROM tasks WHERE status != 'archived'                          │
│     │   → Task[] (task.relates is undefined at this point)                     │
│     │                                                                           │
│     ├── await loadDependenciesForTasks(db, tasks)    ←── EXISTS ✓              │
│     │   → Populates task.depends[]                                              │
│     │                                                                           │
│     └── [MISSING!] No loadRelationsForTasks() call   ←── NOT CALLED ✗          │
│         → task.relates[] remains undefined!                                     │
│                                                                                 │
│   ✗ Data is NEVER read from task_relations table!                               │
│                                                                                 │
├────────────────────────────────────────────────────────────────────────────────┤
│ Step 3: Use Relations                                                           │
│                                                                                 │
│   task.relates  → undefined  ✗ NOT AVAILABLE                                    │
│                                                                                 │
│   Result: Relations appear lost after restart!                                  │
│                                                                                 │
└────────────────────────────────────────────────────────────────────────────────┘
```

---

## The Fix: Adding loadRelationsForTasks

```
┌────────────────────────────────────────────────────────────────────────────────┐
│                    THE FIX (loadRelationsForTasks)                             │
└────────────────────────────────────────────────────────────────────────────────┘

┌────────────────────────────────────────────────────────────────────────────────┐
│ 1. Create loadRelationsForTasks() in db-helpers.ts                              │
│                                                                                 │
│   export async function loadRelationsForTasks(db, tasks) {                     │
│     if (tasks.length === 0) return;                                             │
│                                                                                 │
│     const taskIds = tasks.map(t => t.id);                                       │
│                                                                                 │
│     // Query ALL relations for these tasks at once                              │
│     const allRels = await db                                                    │
│       .select()                                                                 │
│       .from(schema.taskRelations)                                               │
│       .where(inArray(schema.taskRelations.taskId, taskIds))                     │
│       .all();                                                                   │
│                                                                                 │
│     // Build map: taskId -> relations[]                                         │
│     const relMap = new Map();                                                   │
│     for (const rel of allRels) {                                                │
│       if (!relMap.has(rel.taskId)) relMap.set(rel.taskId, []);                 │
│       relMap.get(rel.taskId).push({                                             │
│         taskId: rel.relatedTo,                                                  │
│         type: rel.relationType                                                  │
│       });                                                                       │
│     }                                                                           │
│                                                                                 │
│     // Assign to tasks in-place                                                 │
│     for (const task of tasks) {                                                 │
│       if (relMap.has(task.id)) task.relates = relMap.get(task.id);             │
│     }                                                                           │
│   }                                                                             │
│                                                                                 │
├────────────────────────────────────────────────────────────────────────────────┤
│ 2. Call it in sqlite-data-accessor.ts                                           │
│                                                                                 │
│   async loadTaskFile(): Promise<TaskFile> {                                    │
│     const tasks = taskRows.map(rowToTask);                                     │
│                                                                                 │
│     if (tasks.length > 0) {                                                     │
│       await loadDependenciesForTasks(db, tasks);       ←── EXISTS              │
│       await loadRelationsForTasks(db, tasks);          ←── ADD THIS            │
│     }                                                                           │
│                                                                                 │
│     // ... rest of function                                                     │
│   }                                                                             │
│                                                                                 │
├────────────────────────────────────────────────────────────────────────────────┤
│ 3. Also call in loadArchive()                                                   │
│                                                                                 │
│   async loadArchive(): Promise<ArchiveFile | null> {                           │
│     const archivedTasks = archivedRows.map(rowToTask);                         │
│                                                                                 │
│     if (archivedTasks.length > 0) {                                             │
│       await loadDependenciesForTasks(db, archivedTasks, allKnownIds);          │
│       await loadRelationsForTasks(db, archivedTasks);  ←── ADD THIS            │
│     }                                                                           │
│                                                                                 │
│     // ... rest of function                                                     │
│   }                                                                             │
│                                                                                 │
└────────────────────────────────────────────────────────────────────────────────┘
```

---

## Before/After Comparison

```
┌────────────────────────────────────────────────────────────────────────────────┐
│                              BEFORE FIX                                        │
├────────────────────────────────────────────────────────────────────────────────┤
│                                                                                 │
│   Session 1:                                                                    │
│   $ ct relates add T001 T002 --type blocks                                      │
│   ✓ Relation added successfully                                                 │
│   $ ct relates show T001                                                        │
│   ✓ Shows: T002 (blocks)      ←── In-memory, works during session              │
│                                                                                 │
│   [Restart CLEO / New session]                                                  │
│                                                                                 │
│   Session 2:                                                                    │
│   $ ct relates show T001                                                        │
│   ✗ Shows: No relations       ←── LOST! Data still in DB but never read        │
│                                                                                 │
└────────────────────────────────────────────────────────────────────────────────┘

┌────────────────────────────────────────────────────────────────────────────────┐
│                              AFTER FIX                                         │
├────────────────────────────────────────────────────────────────────────────────┤
│                                                                                 │
│   Session 1:                                                                    │
│   $ ct relates add T001 T002 --type blocks                                      │
│   ✓ Relation added successfully                                                 │
│   $ ct relates show T001                                                        │
│   ✓ Shows: T002 (blocks)                                                        │
│                                                                                 │
│   [Restart CLEO / New session]                                                  │
│                                                                                 │
│   Session 2:                                                                    │
│   $ ct relates show T001                                                        │
│   ✓ Shows: T002 (blocks)      ←── PERSISTS! Loaded from task_relations table   │
│                                                                                 │
└────────────────────────────────────────────────────────────────────────────────┘
```

---

## Data Flow Summary Table

| Component | Dependencies | Relations | Status |
|-----------|--------------|-----------|--------|
| **Table** | task_dependencies | task_relations | ✅ Exists |
| **Schema** | Defined in schema.ts | Defined in schema.ts | ✅ Exists |
| **Write Function** | updateDependencies() | addRelation() | ✅ Works |
| **Write Call Site** | saveTaskFile(), upsertSingleTask() | task-ops.ts coreTaskRelatesAdd() | ✅ Called |
| **Read Function** | loadDependenciesForTasks() | loadRelationsForTasks() | ❌ **MISSING** |
| **Read Call Site** | loadTaskFile(), loadArchive() | loadTaskFile(), loadArchive() | ❌ **NOT CALLED** |
| **Task Type Field** | depends?: string[] | relates?: Array<...> | ❌ **MISSING** |
| **Tests** | Comprehensive | Round-trip missing | ❌ **NEEDED** |

---

## Key Files and Their Roles

```
src/
├── types/
│   └── task.ts
│       └── Task interface
│           ├── depends?: string[]           ✓ EXISTS
│           └── relates?: Relation[]         ✗ ADD THIS
│
├── store/
│   ├── schema.ts
│   │   ├── taskDependencies table           ✓ EXISTS
│   │   └── taskRelations table              ✓ EXISTS
│   │       └── relation_type enum          ✗ EXPAND (optional)
│   │
│   ├── db-helpers.ts
│   │   ├── loadDependenciesForTasks()      ✓ EXISTS
│   │   └── loadRelationsForTasks()         ✗ ADD THIS
│   │
│   ├── sqlite-data-accessor.ts
│   │   ├── loadTaskFile()
│   │   │   ├── loadDependenciesForTasks()  ✓ CALLED
│   │   │   └── loadRelationsForTasks()     ✗ CALL THIS
│   │   │
│   │   ├── loadArchive()
│   │   │   ├── loadDependenciesForTasks()  ✓ CALLED
│   │   │   └── loadRelationsForTasks()     ✗ CALL THIS
│   │   │
│   │   └── addRelation()                   ✓ EXISTS (writes to DB)
│   │
│   └── converters.ts
│       └── rowToTask()
│           └── depends: undefined          ✓ Handled separately
│           └── relates: undefined          ✗ Will be handled separately too
│
└── core/
    └── tasks/
        ├── task-ops.ts
        │   ├── coreTaskRelatesAdd()        ✓ Calls addRelation()
        │   └── coreTaskRelates()           ✓ Reads task.relates (empty!)
        │
        └── relates.ts
            └── addRelation()               ✓ Adds to in-memory only (legacy)
```

---

## Visual: The Missing Link

```
                    ┌────────────────────────────────────────┐
                    │           DATABASE (SQLite)            │
                    │  ┌──────────────────────────────────┐  │
                    │  │     task_relations table         │  │
                    │  │  ┌────────┬──────────┬────────┐  │  │
                    │  │  │task_id │related_to│  type  │  │  │
                    │  │  ├────────┼──────────┼────────┤  │  │
        Writes to ──┼──┼──► T001   │   T002   │ blocks │  │  │
        (WORKING)   │  │  │ T001   │   T003   │ related│  │  │
                    │  │  └────────┴──────────┴────────┘  │  │
                    │  └──────────────────────────────────┘  │
                    └────────────────────────────────────────┘
                                   ▲
                                   │
                                   │ addRelation() writes here ✓
                                   │
┌──────────────────────────────────┼──────────────────────────────────┐
│                                  │                                  │
│  ┌───────────────────────────────┴───────────────────────────────┐  │
│  │              sqlite-data-accessor.ts                          │  │
│  │                                                               │  │
│  │  ┌─────────────────────────────────────────────────────────┐  │  │
│  │  │ loadTaskFile()                                          │  │  │
│  │  │                                                         │  │  │
│  │  │   1. Load tasks from DB                                 │  │  │
│  │  │   2. loadDependenciesForTasks(db, tasks)    ←── ✓       │  │  │
│  │  │   3. [MISSING!] No loadRelationsForTasks()  ←── ✗       │  │  │
│  │  │                                                         │  │  │
│  │  │   Returns TaskFile with task.relates = undefined        │  │  │
│  │  └─────────────────────────────────────────────────────────┘  │  │
│  │                                                               │  │
│  └───────────────────────────────────────────────────────────────┘  │
│                                  │                                  │
│                                  ▼ NEVER READS FROM task_relations  │
│                                  ✗                                  │
└─────────────────────────────────────────────────────────────────────┘
```
