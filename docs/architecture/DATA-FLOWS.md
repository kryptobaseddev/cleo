# CLEO Data Flow Diagrams

## System Component Relationships

```
┌─────────────────────────────────────────────────────────────────────┐
│                        CLEO SYSTEM                           │
│                                                                     │
│  ┌────────────────────────────────────────────────────────────┐   │
│  │                   Global Installation                       │   │
│  │              ~/.cleo/                                │   │
│  │                                                             │   │
│  │  ┌──────────┐  ┌───────────┐  ┌────────┐  ┌──────────┐   │   │
│  │  │ schemas/ │  │ templates/│  │scripts/│  │   lib/   │   │   │
│  │  └─────┬────┘  └─────┬─────┘  └────┬───┘  └────┬─────┘   │   │
│  │        │             │              │           │          │   │
│  │        └─────────────┴──────────────┴───────────┘          │   │
│  │                         │                                   │   │
│  └─────────────────────────┼───────────────────────────────────┘   │
│                            │                                       │
│                            │ Provides schemas, scripts, libraries  │
│                            ▼                                       │
│  ┌────────────────────────────────────────────────────────────┐   │
│  │                  Per-Project Instance                      │   │
│  │              your-project/.cleo/                         │   │
│  │                                                            │   │
│  │  ┌──────────────┐  ┌─────────────────┐  ┌──────────────┐ │   │
│  │  │  todo.json   │  │todo-archive.json│  │todo-log.json │ │   │
│  │  │  (active)    │  │  (completed)    │  │  (history)   │ │   │
│  │  └──────┬───────┘  └────────┬────────┘  └──────┬───────┘ │   │
│  │         │                   │                   │         │   │
│  │  ┌──────┴──────────────┐    │                   │         │   │
│  │  │ config.json    │    │                   │         │   │
│  │  │  (configuration)    │    │                   │         │   │
│  │  └─────────────────────┘    │                   │         │   │
│  │                              │                   │         │   │
│  └──────────────────────────────┼───────────────────┼─────────┘   │
│                                 │                   │             │
│                   ┌─────────────┴───────────────────┘             │
│                   │                                               │
│                   ▼                                               │
│  ┌────────────────────────────────────────────────────────────┐   │
│  │                    User Operations                         │   │
│  │  add-task | complete-task | archive | list | stats        │   │
│  └────────────────────────────────────────────────────────────┘   │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

---

## Complete Task Lifecycle with All Operations

```
                             USER INPUT
                                 │
                                 │
        ┌────────────────────────┼────────────────────────┐
        │                        │                        │
        ▼                        ▼                        ▼
   ┌─────────┐             ┌──────────┐            ┌──────────┐
   │  CREATE │             │ COMPLETE │            │  QUERY   │
   │  TASK   │             │   TASK   │            │  TASKS   │
   └────┬────┘             └─────┬────┘            └─────┬────┘
        │                        │                       │
        │                        │                       │
        ▼                        ▼                       ▼
┌────────────────┐      ┌────────────────┐      ┌───────────────┐
│  Load Config   │      │  Load Config   │      │  Load Config  │
│  + Validate    │      │  + Validate    │      │  + Validate   │
└───────┬────────┘      └───────┬────────┘      └───────┬───────┘
        │                       │                        │
        ▼                       ▼                        ▼
┌────────────────┐      ┌────────────────┐      ┌───────────────┐
│ Parse & Valid. │      │ Find Task by ID│      │ Load todo.json│
│ Task Input     │      │ in todo.json   │      │               │
└───────┬────────┘      └───────┬────────┘      └───────┬───────┘
        │                       │                        │
        │                       │ Found?                 │
        │                       ├── No ──► ERROR         │
        │                       │                        │
        │                       ▼ Yes                    │
        ▼                ┌────────────────┐              │
┌────────────────┐      │ Update Status  │              │
│ Schema Valid.  │      │ to "completed" │              │
│ Anti-Hallucin. │      └───────┬────────┘              │
└───────┬────────┘              │                        │
        │                       ▼                        │
        │ Valid?         ┌────────────────┐              │
        ├── No ──► ERROR │ Add Timestamp  │              │
        │                │  completedAt   │              │
        ▼ Yes            └───────┬────────┘              │
┌────────────────┐              │                        │
│ Generate ID    │              ▼                        ▼
│ Add Timestamp  │       ┌────────────────┐      ┌──────────────┐
└───────┬────────┘       │Schema Validate │      │Apply Filters │
        │                │  Updated Task  │      │ (status, etc)│
        ▼                └───────┬────────┘      └──────┬───────┘
┌────────────────┐              │                       │
│  Add to        │              │ Valid?                ▼
│  todo.json     │              ├── No ──► ERROR  ┌─────────────┐
└───────┬────────┘              │                 │   Format    │
        │                       ▼ Yes             │   Output    │
        │                ┌────────────────┐       └──────┬──────┘
        │                │  Atomic Write  │              │
        │                │   todo.json    │              │
        │                └───────┬────────┘              │
        │                        │                       │
        └────────────────┬───────┘                       │
                         │                               │
                         ▼                               │
                  ┌─────────────┐                        │
                  │   Backup    │                        │
                  │  Old File   │                        │
                  └──────┬──────┘                        │
                         │                               │
                         ▼                               │
                  ┌─────────────┐                        │
                  │  Log Entry  │                        │
                  │ Append to   │                        │
                  │todo-log.json│                        │
                  └──────┬──────┘                        │
                         │                               │
                         ▼                               │
                  ┌─────────────┐                        │
                  │Check Archive│                        │
                  │   Policy    │                        │
                  └──────┬──────┘                        │
                         │                               │
            ┌────────────┴────────────┐                  │
            │                         │                  │
      Should Archive?           No Archive               │
            │                         │                  │
            ▼ Yes                     ▼                  │
      ┌──────────┐              ┌──────────┐            │
      │ ARCHIVE  │              │ SUCCESS  │◄───────────┘
      │ WORKFLOW │              │ RESPONSE │
      └────┬─────┘              └──────────┘
           │
           │
           ▼
    (See Archive Flow Below)
```

---

## Archive Workflow Detailed

```
                        ARCHIVE TRIGGER
                              │
                 ┌────────────┼────────────┐
                 │            │            │
                 ▼            ▼            ▼
            ┌────────┐   ┌────────┐   ┌────────┐
            │  Auto  │   │ Manual │   │  Hook  │
            │ Policy │   │  Call  │   │ Cron   │
            └───┬────┘   └───┬────┘   └───┬────┘
                │            │            │
                └────────────┴────────────┘
                             │
                             ▼
                  ┌───────────────────┐
                  │  Load Config      │
                  │  archive_policy   │
                  └──────────┬────────┘
                             │
                             ▼
                  ┌───────────────────┐
                  │  Load todo.json   │
                  │  Find completed   │
                  │  tasks            │
                  └──────────┬────────┘
                             │
                             ▼
                  ┌───────────────────┐
                  │  Apply Filters:   │
                  │  - status = done  │
                  │  - age > N days   │
                  └──────────┬────────┘
                             │
                    ┌────────┴────────┐
                    │                 │
              No Tasks           Has Tasks
              to Archive         to Archive
                    │                 │
                    ▼                 ▼
              ┌──────────┐   ┌────────────────┐
              │   EXIT   │   │  Load archive  │
              │  SUCCESS │   │  todo-archive  │
              └──────────┘   └───────┬────────┘
                                     │
                                     ▼
                          ┌────────────────────┐
                          │ Check Archive Size │
                          │ Policy Enforcement │
                          └──────────┬─────────┘
                                     │
                        ┌────────────┴────────────┐
                        │                         │
                  Size OK                   Size Exceeded
                        │                         │
                        ▼                         ▼
                ┌───────────────┐       ┌─────────────────┐
                │Append Tasks   │       │ Prune Oldest    │
                │to Archive     │       │ Archive Entries │
                └───────┬───────┘       └────────┬────────┘
                        │                        │
                        │                        ▼
                        │              ┌──────────────────┐
                        │              │ Then Append New  │
                        │              │     Tasks        │
                        │              └────────┬─────────┘
                        │                       │
                        └───────────┬───────────┘
                                    │
                                    ▼
                          ┌──────────────────┐
                          │ Validate Archive │
                          │ Against Schema   │
                          └─────────┬────────┘
                                    │
                       ┌────────────┴────────────┐
                       │                         │
                   Invalid                    Valid
                       │                         │
                       ▼                         ▼
                  ┌─────────┐         ┌──────────────────┐
                  │ ROLLBACK│         │ Remove Archived  │
                  │  ERROR  │         │ Tasks from       │
                  └─────────┘         │ todo.json        │
                                      └─────────┬────────┘
                                                │
                                                ▼
                                      ┌──────────────────┐
                                      │ Validate Updated │
                                      │   todo.json      │
                                      └─────────┬────────┘
                                                │
                                   ┌────────────┴────────────┐
                                   │                         │
                               Invalid                    Valid
                                   │                         │
                                   ▼                         ▼
                              ┌─────────┐         ┌──────────────────┐
                              │ ROLLBACK│         │  Atomic Write    │
                              │  ERROR  │         │  Both Files      │
                              └─────────┘         │  (synchronized)  │
                                                  └─────────┬────────┘
                                                            │
                                                            ▼
                                                  ┌──────────────────┐
                                                  │  Backup Both     │
                                                  │  Files           │
                                                  └─────────┬────────┘
                                                            │
                                                            ▼
                                                  ┌──────────────────┐
                                                  │  Log Operation   │
                                                  │  - task IDs      │
                                                  │  - count         │
                                                  │  - timestamp     │
                                                  └─────────┬────────┘
                                                            │
                                                            ▼
                                                  ┌──────────────────┐
                                                  │  SUCCESS         │
                                                  │  Display Stats   │
                                                  │  "Archived N"    │
                                                  └──────────────────┘
```

---

## Validation Pipeline (All Operations)

```
                     ANY FILE OPERATION
                            │
                            ▼
                 ┌────────────────────┐
                 │   Read JSON File   │
                 └──────────┬─────────┘
                            │
                            ▼
                 ┌────────────────────┐
                 │  Parse JSON        │
                 │  (syntax check)    │
                 └──────────┬─────────┘
                            │
               ┌────────────┴────────────┐
               │                         │
          Parse Error                 Success
               │                         │
               ▼                         ▼
          ┌────────┐          ┌──────────────────┐
          │ ERROR  │          │ Detect File Type │
          │ ABORT  │          │ (schema ref)     │
          └────────┘          └────────┬─────────┘
                                       │
                    ┌──────────────────┼──────────────────┐
                    │                  │                  │
                    ▼                  ▼                  ▼
            ┌──────────────┐   ┌──────────────┐  ┌──────────────┐
            │  todo.json   │   │todo-archive  │  │ todo-log.json│
            │  schema      │   │   schema     │  │   schema     │
            └──────┬───────┘   └──────┬───────┘  └──────┬───────┘
                   │                  │                  │
                   └──────────────────┴──────────────────┘
                                      │
                                      ▼
                          ┌───────────────────────┐
                          │  JSON Schema Validate │
                          │  - Structure          │
                          │  - Types              │
                          │  - Required fields    │
                          └──────────┬────────────┘
                                     │
                        ┌────────────┴────────────┐
                        │                         │
                  Schema Invalid            Schema Valid
                        │                         │
                        ▼                         ▼
                   ┌─────────┐        ┌──────────────────────┐
                   │  ERROR  │        │ Anti-Hallucination   │
                   │  Report │        │ Checks               │
                   │  Details│        │                      │
                   └─────────┘        │ 1. ID Uniqueness     │
                                      │ 2. Status Enum       │
                                      │ 3. Timestamp Sanity  │
                                      │ 4. Content Pairing   │
                                      │ 5. Duplicate Content │
                                      └──────────┬───────────┘
                                                 │
                                    ┌────────────┴────────────┐
                                    │                         │
                              Semantic Invalid          All Valid
                                    │                         │
                                    ▼                         ▼
                              ┌──────────┐          ┌─────────────────┐
                              │  ERROR   │          │ Config Validate │
                              │  Details │          │ Apply Policies  │
                              │  + Fix   │          └────────┬────────┘
                              │  Suggest │                   │
                              └──────────┘                   │
                                                             ▼
                                                   ┌──────────────────┐
                                                   │ Cross-File Check │
                                                   │ - ID conflicts   │
                                                   │ - Referential    │
                                                   │   integrity      │
                                                   └────────┬─────────┘
                                                            │
                                              ┌─────────────┴─────────────┐
                                              │                           │
                                       Conflicts Found              No Conflicts
                                              │                           │
                                              ▼                           ▼
                                        ┌──────────┐              ┌─────────────┐
                                        │  ERROR   │              │  VALID ✅   │
                                        │  Abort   │              │  Proceed    │
                                        └──────────┘              └─────────────┘
```

---

## File Interaction Matrix (Read/Write Operations)

```
┌──────────────────┬─────────────┬──────────────────┬──────────────────┬──────────────────┐
│  OPERATION       │  todo.json  │ todo-archive.json│ config.json │ todo-log.json    │
├──────────────────┼─────────────┼──────────────────┼──────────────────┼──────────────────┤
│  init.sh         │   W (new)   │   W (new)        │   W (new)        │   W (new)        │
├──────────────────┼─────────────┼──────────────────┼──────────────────┼──────────────────┤
│  add.sh     │   R + W     │      -           │      R           │      W           │
├──────────────────┼─────────────┼──────────────────┼──────────────────┼──────────────────┤
│  complete.sh│   R + W     │      -           │      R           │      W           │
├──────────────────┼─────────────┼──────────────────┼──────────────────┼──────────────────┤
│  archive.sh      │   R + W     │   R + W          │      R           │      W           │
├──────────────────┼─────────────┼──────────────────┼──────────────────┼──────────────────┤
│  list.sh   │      R      │   R (--all)      │      R           │      -           │
├──────────────────┼─────────────┼──────────────────┼──────────────────┼──────────────────┤
│  stats.sh        │      R      │      R           │      R           │      R           │
├──────────────────┼─────────────┼──────────────────┼──────────────────┼──────────────────┤
│  validate.sh     │      R      │      R           │      R           │      R           │
├──────────────────┼─────────────┼──────────────────┼──────────────────┼──────────────────┤
│  backup.sh       │      R      │      R           │      R           │      R           │
├──────────────────┼─────────────┼──────────────────┼──────────────────┼──────────────────┤
│  restore.sh      │   W (all)   │   W (all)        │   W (all)        │   W (all)        │
└──────────────────┴─────────────┴──────────────────┴──────────────────┴──────────────────┘

Legend:
  R = Read operation
  W = Write operation
  R + W = Read then Write (atomic update)
  - = Not accessed
  (new) = Creates new file
  (--all) = Only with flag
```

---

## Atomic Write Operation Pattern (Critical for Data Integrity)

```
                     ATOMIC WRITE REQUEST
                     (Update todo.json)
                             │
                             ▼
                  ┌────────────────────┐
                  │  Generate Temp     │
                  │  Filename          │
                  │  .todo.json.tmp    │
                  └──────────┬─────────┘
                             │
                             ▼
                  ┌────────────────────┐
                  │  Write Data to     │
                  │  Temp File         │
                  └──────────┬─────────┘
                             │
                             ▼
                  ┌────────────────────┐
                  │  Validate Temp     │
                  │  File (Schema +    │
                  │  Anti-Hallucin.)   │
                  └──────────┬─────────┘
                             │
                ┌────────────┴────────────┐
                │                         │
           Invalid                     Valid
                │                         │
                ▼                         ▼
           ┌─────────┐          ┌──────────────────┐
           │ Delete  │          │ Create Backup    │
           │  Temp   │          │ todo.json →      │
           │  ERROR  │          │ .cleo/.backups/│
           └─────────┘          │ todo.json.N      │
                                └────────┬─────────┘
                                         │
                                         ▼
                                ┌──────────────────┐
                                │  Atomic Rename   │
                                │  .tmp → .json    │
                                │  (mv operation)  │
                                └────────┬─────────┘
                                         │
                            ┌────────────┴────────────┐
                            │                         │
                      Rename Failed             Rename Success
                            │                         │
                            ▼                         ▼
                       ┌─────────┐            ┌──────────────┐
                       │ Restore │            │  SUCCESS     │
                       │ Backup  │            │  Cleanup Temp│
                       │  ERROR  │            │  Rotate Old  │
                       └─────────┘            │  Backups     │
                                              └──────────────┘

Key Properties:
- Never overwrites directly (prevents corruption)
- Validates before committing
- Backup before modification
- Atomic rename (OS-level guarantee)
- Rollback on failure
- Preserves original on error
```

---

## Checksum Verification Flow (Detection, Not Blocking)

```
                    ANY WRITE OPERATION
                           │
                           ▼
                ┌────────────────────┐
                │  Read todo.json    │
                │  Extract _meta     │
                │  checksum          │
                └──────────┬─────────┘
                           │
                           ▼
                ┌────────────────────┐
                │  Compute Current   │
                │  Checksum          │
                │                    │
                │  jq -c '.tasks' |  │
                │  sha256sum |       │
                │  cut -c1-16        │
                └──────────┬─────────┘
                           │
                           ▼
                ┌────────────────────┐
                │  Compare Stored    │
                │     vs             │
                │  Computed          │
                └──────────┬─────────┘
                           │
              ┌────────────┴────────────┐
              │                         │
         MISMATCH                    MATCH
              │                         │
              ▼                         │
       ┌─────────────┐                  │
       │  Log Info:  │                  │
       │  "External  │                  │
       │  modification                  │
       │  detected"  │                  │
       └──────┬──────┘                  │
              │                         │
              └─────────────────────────┤
                                        │
                                        ▼
                               ┌─────────────────┐
                               │  PROCEED with   │
                               │  Write          │
                               └────────┬────────┘
                                        │
                                        ▼
                               ┌─────────────────┐
                               │  Perform Data   │
                               │  Modification   │
                               └────────┬────────┘
                                        │
                                        ▼
                               ┌─────────────────┐
                               │  Recalculate    │
                               │  New Checksum   │
                               │  After Changes  │
                               └────────┬────────┘
                                        │
                                        ▼
                               ┌─────────────────┐
                               │  Update _meta   │
                               │  checksum       │
                               │  lastModified   │
                               └────────┬────────┘
                                        │
                                        ▼
                               ┌─────────────────┐
                               │  Atomic Write   │
                               │  (see above)    │
                               └────────┬────────┘
                                        │
                                        ▼
                               ┌─────────────────┐
                               │    SUCCESS      │
                               └─────────────────┘

Checksum Calculation:
  Input:  .tasks array (JSON, compact)
  Hash:   SHA-256
  Output: First 16 characters of hex digest

Purpose (Detection & Audit):
  1. Detects external file modifications (e.g., TodoWrite)
  2. Provides audit trail for file changes
  3. Enables backup integrity verification
  4. Catches file corruption during restore

Design Note:
  Checksum is for DETECTION, not BLOCKING. In multi-writer
  scenarios (cleo CLI + TodoWrite), external modifications
  are expected and legitimate. Real data protection comes from:
  - Schema validation (Layer 1)
  - Semantic validation (Layer 2)
  - Atomic writes with backups (Layer 3)

Commands:
  Compute:  jq -c '.tasks' todo.json | sha256sum | cut -c1-16
  Verify:   jq -r '._meta.checksum' todo.json
  Fix:      cleo validate --fix
```

---

## Backup Rotation Strategy

```
                  BACKUP ROTATION POLICY
                  (max_backups: 10)

Current State (Tier 1 - Operational Backups):
.cleo/.backups/
├── todo.json.1  (most recent)
├── todo.json.2
├── todo.json.3
├── ...
├── todo.json.9
└── todo.json.10 (oldest)

                         ▼
                 NEW BACKUP NEEDED
                         │
                         ▼
              ┌────────────────────┐
              │  Check Backup      │
              │  Count (currently  │
              │  10 = at limit)    │
              └──────────┬─────────┘
                         │
            ┌────────────┴────────────┐
            │                         │
      Below Limit                At Limit
            │                         │
            ▼                         ▼
   ┌──────────────────┐      ┌─────────────────┐
   │  Shift Numbers:  │      │ Delete Oldest:  │
   │  N → N+1         │      │ todo.json.10    │
   └────────┬─────────┘      └────────┬────────┘
            │                         │
            │                         ▼
            │                ┌─────────────────┐
            │                │  Shift Numbers: │
            │                │  9→10, 8→9, ... │
            │                │  1→2            │
            │                └────────┬────────┘
            │                         │
            └─────────────┬───────────┘
                          │
                          ▼
                ┌──────────────────────┐
                │  Copy Current File   │
                │  to todo.json.1      │
                │  (newest backup)     │
                └──────────────────────┘

Result:
.cleo/.backups/
├── todo.json.1  (NEW - just backed up)
├── todo.json.2  (was .1)
├── todo.json.3  (was .2)
├── ...
├── todo.json.10 (was .9)
└── [old .10 deleted]
```

---

## Configuration Override Hierarchy

```
                     USER OPERATION
                           │
                           ▼
                ┌────────────────────┐
                │  Load Defaults     │
                │  (hardcoded in     │
                │   scripts)         │
                └──────────┬─────────┘
                           │
                           ▼
                ┌────────────────────┐
                │  Load Global       │
                │  ~/.cleo/   │
                │  config.json  │
                │  (if exists)       │
                └──────────┬─────────┘
                           │
                           │ Merge (override defaults)
                           ▼
                ┌────────────────────┐
                │  Load Project      │
                │  .cleo/          │
                │  config.json  │
                └──────────┬─────────┘
                           │
                           │ Merge (override global)
                           ▼
                ┌────────────────────┐
                │  Check Environment │
                │  CLEO_*     │
                │  variables         │
                └──────────┬─────────┘
                           │
                           │ Merge (override project)
                           ▼
                ┌────────────────────┐
                │  Parse CLI Flags   │
                │  --option=value    │
                └──────────┬─────────┘
                           │
                           │ Merge (override environment)
                           ▼
                ┌────────────────────┐
                │  Final Config      │
                │  (applied to       │
                │   operation)       │
                └────────────────────┘

Example:
  Default:     archive_after_days = 7
  Global:      archive_after_days = 14  (overrides default)
  Project:     archive_after_days = 3   (overrides global)
  Environment: CLEO_ARCHIVE_DAYS=30 (overrides project)
  CLI Flag:    --archive-days=1   (overrides environment)

  Final Value: 1 day
```

---

## Error Recovery Flow

```
                    OPERATION FAILURE
                           │
                           ▼
                 ┌───────────────────┐
                 │  Detect Error     │
                 │  Type             │
                 └─────────┬─────────┘
                           │
        ┌──────────────────┼──────────────────┐
        │                  │                  │
        ▼                  ▼                  ▼
┌──────────────┐   ┌──────────────┐   ┌──────────────┐
│Schema Error  │   │File System   │   │Config Error  │
│(Validation)  │   │Error         │   │(Invalid)     │
└──────┬───────┘   └──────┬───────┘   └──────┬───────┘
       │                  │                  │
       │                  │                  │
       ▼                  ▼                  ▼
┌──────────────┐   ┌──────────────┐   ┌──────────────┐
│Check for     │   │Check for     │   │Load Default  │
│Backup        │   │Backup        │   │Config        │
└──────┬───────┘   └──────┬───────┘   └──────┬───────┘
       │                  │                  │
       │                  │                  │
   ┌───┴────┐         ┌───┴────┐         ┌───┴────┐
   │        │         │        │         │        │
Backup   No Backup Backup   No Backup  Success  Fail
Found               Found                          │
   │                  │        │           │       │
   ▼                  ▼        ▼           │       ▼
┌─────────┐   ┌──────────┐ ┌─────────┐   │  ┌─────────┐
│Validate │   │Attempt   │ │Restore  │   │  │Manual   │
│Backup   │   │Manual    │ │Backup   │   │  │Fix      │
│         │   │Recovery  │ │         │   │  │Required │
└────┬────┘   └────┬─────┘ └────┬────┘   │  └─────────┘
     │             │            │         │
 ┌───┴────┐        │            │         │
 │        │        │            │         │
Valid  Invalid     │            │         │
 │        │        │            │         │
 ▼        ▼        ▼            ▼         ▼
┌───────────────────────────────────────────┐
│         Restore or Report Error           │
│         - Show error details              │
│         - Suggest fix steps               │
│         - Preserve data integrity         │
└───────────────────────────────────────────┘
```

---

## Multi-File Synchronization (Archive Operation)

```
     ARCHIVE OPERATION (Critical: 2 files must stay in sync)
                           │
                           ▼
                ┌────────────────────┐
                │  BEGIN TRANSACTION │
                │  (Logical - not DB)│
                └──────────┬─────────┘
                           │
                           ▼
                ┌────────────────────┐
                │  Lock Files        │
                │  (prevent          │
                │   concurrent ops)  │
                └──────────┬─────────┘
                           │
                           ▼
                ┌────────────────────┐
                │  Read todo.json    │
                │  Find completed    │
                │  tasks to archive  │
                └──────────┬─────────┘
                           │
                           ▼
                ┌────────────────────┐
                │  Read              │
                │  todo-archive.json │
                │  Prepare for merge │
                └──────────┬─────────┘
                           │
                           ▼
                ┌────────────────────┐
                │  Create Temp Files │
                │  .todo.json.tmp    │
                │  .todo-archive.    │
                │   json.tmp         │
                └──────────┬─────────┘
                           │
                           ▼
                ┌────────────────────┐
                │  Write Updated     │
                │  todo.json.tmp     │
                │  (tasks removed)   │
                └──────────┬─────────┘
                           │
                           ▼
                ┌────────────────────┐
                │  Write Updated     │
                │  todo-archive.     │
                │   json.tmp         │
                │  (tasks added)     │
                └──────────┬─────────┘
                           │
                           ▼
                ┌────────────────────┐
                │  Validate BOTH     │
                │  Temp Files        │
                └──────────┬─────────┘
                           │
              ┌────────────┴────────────┐
              │                         │
       Either Invalid              Both Valid
              │                         │
              ▼                         ▼
       ┌──────────────┐      ┌──────────────────┐
       │ Delete Temps │      │  Backup BOTH     │
       │  ROLLBACK    │      │  Original Files  │
       │  ERROR       │      └────────┬─────────┘
       └──────────────┘               │
                                      ▼
                           ┌──────────────────┐
                           │  Atomic Rename   │
                           │  BOTH Temp Files │
                           │  (critical order)│
                           └────────┬─────────┘
                                    │
                       ┌────────────┴────────────┐
                       │                         │
                 Either Failed              Both Success
                       │                         │
                       ▼                         ▼
                  ┌─────────┐           ┌──────────────┐
                  │ Restore │           │  Unlock Files│
                  │  Both   │           │  SUCCESS     │
                  │ Backups │           │  Log Op      │
                  │  ERROR  │           └──────────────┘
                  └─────────┘

Critical: If either rename fails, BOTH must be restored.
This ensures todo + archive are ALWAYS in sync.
```

---

## Statistics Generation Flow

```
                    STATS REQUEST
                         │
                         ▼
              ┌────────────────────┐
              │  Load Config       │
              │  (date format,     │
              │   timezone)        │
              └──────────┬─────────┘
                         │
         ┌───────────────┼───────────────┐
         │               │               │
         ▼               ▼               ▼
  ┌──────────┐   ┌──────────┐   ┌──────────┐
  │Load todo │   │Load      │   │Load log  │
  │.json     │   │archive   │   │.json     │
  └────┬─────┘   └────┬─────┘   └────┬─────┘
       │              │              │
       └──────────────┴──────────────┘
                      │
                      ▼
          ┌──────────────────────┐
          │  Parse All Tasks     │
          │  Extract Metadata:   │
          │  - status            │
          │  - createdAt         │
          │  - completedAt       │
          └──────────┬───────────┘
                     │
                     ▼
          ┌──────────────────────┐
          │  Current State Stats │
          │  - Count by status   │
          │  - Active tasks      │
          └──────────┬───────────┘
                     │
                     ▼
          ┌──────────────────────┐
          │  Completion Stats    │
          │  - Total completed   │
          │  - Completion rate   │
          │  - Avg time to done  │
          └──────────┬───────────┘
                     │
                     ▼
          ┌──────────────────────┐
          │  Trend Analysis      │
          │  - Tasks/day         │
          │  - Completion trend  │
          │  - Activity patterns │
          └──────────┬───────────┘
                     │
                     ▼
          ┌──────────────────────┐
          │  Log Analysis        │
          │  - Operation counts  │
          │  - Error rates       │
          │  - Activity timeline │
          └──────────┬───────────┘
                     │
                     ▼
          ┌──────────────────────┐
          │  Format Output       │
          │  - ASCII charts      │
          │  - Colored text      │
          │  - Summary tables    │
          └──────────┬───────────┘
                     │
                     ▼
          ┌──────────────────────┐
          │  Display Report      │
          │  to User             │
          └──────────────────────┘
```

---

## Phase Operation Data Flows (v2.2.0+)

### Phase Set Operation

```
                     PHASE SET REQUEST
                     (cleo phase set <slug>)
                              │
                              ▼
                   ┌────────────────────┐
                   │  Load todo.json    │
                   │  Validate phase    │
                   │  slug exists       │
                   └──────────┬─────────┘
                              │
                 ┌────────────┴────────────┐
                 │                         │
           Phase Not Found           Phase Found
                 │                         │
                 ▼                         ▼
            ┌─────────┐         ┌──────────────────┐
            │  ERROR  │         │  Get Previous    │
            │  "Phase │         │  Phase Status    │
            │  does   │         └────────┬─────────┘
            │  not    │                  │
            │  exist" │                  ▼
            └─────────┘         ┌──────────────────┐
                                │  Update Previous │
                                │  Phase:          │
                                │  status=completed│
                                │  (if active)     │
                                └────────┬─────────┘
                                         │
                                         ▼
                                ┌──────────────────┐
                                │  Set New Phase:  │
                                │  project.        │
                                │   currentPhase   │
                                │  focus.          │
                                │   currentPhase   │
                                └────────┬─────────┘
                                         │
                                         ▼
                                ┌──────────────────┐
                                │  Update New      │
                                │  Phase:          │
                                │  status=active   │
                                │  startedAt=now   │
                                └────────┬─────────┘
                                         │
                                         ▼
                                ┌──────────────────┐
                                │  Atomic Write    │
                                │  + Log Operation │
                                │  + Backup        │
                                └────────┬─────────┘
                                         │
                                         ▼
                                ┌──────────────────┐
                                │    SUCCESS       │
                                │  "Phase set to   │
                                │   <slug>"        │
                                └──────────────────┘
```

### Task Phase Inheritance Flow

```
                      ADD TASK REQUEST
                      (cleo add "Task title")
                               │
                               ▼
                    ┌────────────────────┐
                    │  Parse Arguments   │
                    │  Check --phase     │
                    └──────────┬─────────┘
                               │
              ┌────────────────┴────────────────┐
              │                                 │
       --phase provided              No --phase flag
              │                                 │
              ▼                                 ▼
    ┌──────────────────┐             ┌──────────────────┐
    │  Use Explicit    │             │  Read            │
    │  Phase from CLI  │             │  project.        │
    │                  │             │   currentPhase   │
    └────────┬─────────┘             └────────┬─────────┘
             │                                │
             └────────────────┬───────────────┘
                              │
                              ▼
                   ┌────────────────────┐
                   │  Validate Phase    │
                   │  Exists in         │
                   │  project.phases    │
                   └──────────┬─────────┘
                              │
             ┌────────────────┴────────────────┐
             │                                 │
       Phase Invalid                    Phase Valid
             │                                 │
             ▼                                 ▼
      ┌──────────────┐              ┌──────────────────┐
      │    ERROR     │              │  Create Task     │
      │  "Phase      │              │  with            │
      │  not found"  │              │  phase: <slug>   │
      └──────────────┘              └────────┬─────────┘
                                             │
                                             ▼
                                  ┌──────────────────┐
                                  │  Add to          │
                                  │  todo.json       │
                                  │  (standard flow) │
                                  └──────────────────┘

Key Points:
  - Tasks INHERIT currentPhase if not specified
  - Explicit --phase flag overrides inheritance
  - Phase must exist in project.phases
  - No phase validation skips inheritance
```

### Phase Listing Data Flow

```
                     PHASES COMMAND
                     (cleo phases)
                              │
                              ▼
                   ┌────────────────────┐
                   │  Load todo.json    │
                   │  Extract project   │
                   │  object            │
                   └──────────┬─────────┘
                              │
                              ▼
                   ┌────────────────────┐
                   │  Get phases:       │
                   │  project.phases    │
                   │  project.          │
                   │   currentPhase     │
                   └──────────┬─────────┘
                              │
                              ▼
                   ┌────────────────────┐
                   │  For Each Phase:   │
                   │  - Count tasks     │
                   │  - Count completed │
                   │  - Calculate %     │
                   └──────────┬─────────┘
                              │
                              ▼
                   ┌────────────────────┐
                   │  Sort by order     │
                   │  field             │
                   └──────────┬─────────┘
                              │
                              ▼
                   ┌────────────────────┐
                   │  Format Output:    │
                   │  - Status icon     │
                   │  - Progress bar    │
                   │  - Current marker  │
                   └──────────┬─────────┘
                              │
                              ▼
                   ┌──────────────────────────────────┐
                   │         OUTPUT EXAMPLE            │
                   │                                   │
                   │  Phases (4 phases)               │
                   │  ┌────────────────────────────┐  │
                   │  │ ✓ setup  [████████] 100%  │  │
                   │  │ ◉ core   [████░░░░]  50%  │◄─current
                   │  │ ○ polish [░░░░░░░░]   0%  │  │
                   │  │ ○ maint  [░░░░░░░░]   0%  │  │
                   │  └────────────────────────────┘  │
                   └──────────────────────────────────┘
```

### TodoWrite Sync Phase Filtering

```
                    INJECT COMMAND
                    (cleo sync --inject --focused-only)
                              │
                              ▼
                   ┌────────────────────┐
                   │  Read todo.json    │
                   │  Get currentPhase  │
                   └──────────┬─────────┘
                              │
                              ▼
                   ┌────────────────────┐
                   │  Filter Tasks:     │
                   │  WHERE             │
                   │  task.phase ==     │
                   │   currentPhase     │
                   └──────────┬─────────┘
                              │
                              ▼
                   ┌────────────────────┐
                   │  Export to         │
                   │  TodoWrite Format  │
                   │  (filtered set)    │
                   └──────────┬─────────┘
                              │
                              ▼
                   ┌────────────────────┐
                   │  Store Phase       │
                   │  Metadata in       │
                   │  Sync State File   │
                   └──────────────────────┘

                    EXTRACT COMMAND
                    (cleo sync --extract)
                              │
                              ▼
                   ┌────────────────────┐
                   │  Read TodoWrite    │
                   │  State from        │
                   │  stdin/file        │
                   └──────────┬─────────┘
                              │
                              ▼
                   ┌────────────────────┐
                   │  Read Sync State   │
                   │  Get original      │
                   │  phase context     │
                   └──────────┬─────────┘
                              │
                              ▼
                   ┌────────────────────┐
                   │  For NEW tasks     │
                   │  from TodoWrite:   │
                   │  Inherit phase     │
                   │  from sync state   │
                   └──────────┬─────────┘
                              │
                              ▼
                   ┌────────────────────┐
                   │  Merge Changes     │
                   │  Back to           │
                   │  todo.json         │
                   └──────────────────────┘
```

### File Interaction Matrix (Phase Operations)

```
┌──────────────────┬─────────────┬──────────────────┬──────────────────┬──────────────────┐
│  OPERATION       │  todo.json  │ todo-archive.json│ config.json │ todo-log.json    │
├──────────────────┼─────────────┼──────────────────┼──────────────────┼──────────────────┤
│  phase.sh set    │   R + W     │      -           │      R           │      W           │
├──────────────────┼─────────────┼──────────────────┼──────────────────┼──────────────────┤
│  phase.sh show   │      R      │      -           │      R           │      -           │
├──────────────────┼─────────────┼──────────────────┼──────────────────┼──────────────────┤
│  phases.sh       │      R      │      -           │      R           │      -           │
├──────────────────┼─────────────┼──────────────────┼──────────────────┼──────────────────┤
│  phases.sh show  │      R      │      -           │      R           │      -           │
├──────────────────┼─────────────┼──────────────────┼──────────────────┼──────────────────┤
│  phases.sh stats │      R      │      R           │      R           │      -           │
└──────────────────┴─────────────┴──────────────────┴──────────────────┴──────────────────┘

Legend:
  R = Read operation
  W = Write operation
  R + W = Read then Write (atomic update)
  - = Not accessed
```

---

## Summary

These data flow diagrams illustrate:

1. **System Architecture**: Global installation feeds per-project instances
2. **Complete Lifecycle**: From task creation through completion to archival
3. **Validation Pipeline**: Multi-stage validation with anti-hallucination checks
4. **Atomic Operations**: Safe file updates with rollback capability
5. **Backup Strategy**: Automatic rotation prevents data loss
6. **Configuration Hierarchy**: Flexible override system
7. **Error Recovery**: Comprehensive failure handling
8. **Synchronization**: Multi-file consistency guarantees
9. **Statistics**: Comprehensive reporting from all data sources
10. **Phase Operations** (v2.2.0+): Project-level phase tracking with task inheritance

The architecture prioritizes **data integrity**, **atomicity**, **recoverability**, **anti-hallucination protection**, and **phase-aware workflows** throughout all operations.
