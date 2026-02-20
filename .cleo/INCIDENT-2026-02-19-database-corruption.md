# INCIDENT REPORT: Database Corruption and Task ID Collision

**Date**: 2026-02-19  
**Severity**: CRITICAL  
**Status**: RESOLVED (with data loss)  
**Reporter**: Recovery Agent  

---

## Executive Summary

During the SQLite Migration Safety Overhaul orchestration (Epic T4720), the task database was corrupted, resulting in:
- **46 tasks lost**: T001-T007 overwritten (API Epic tasks)
- **Sequence corruption**: Multiple agents creating tasks with conflicting IDs
- **Ghost entries**: 83 task creation events logged but tasks never persisted
- **Data integrity failure**: todo-log.jsonl has events for tasks that don't exist

---

## Timeline of Events

### **Feb 18, 19:17-19:19** - Initial Wave 8 Epic Created
- Agent created T001: "EPIC: Wave 8 - Full System Integration"
- T002-T036: Wave 8 subtasks created
- These were legitimate tasks

### **Feb 19, 17:18-17:20** - Migration Safety Epic Created
- Agent (me) created T4720: "SQLite Migration Safety & Data Integrity Overhaul"
- T4721-T4729: Migration safety subtasks created
- These were logged but **NOT persisted to database**

### **Feb 19, 17:40-20:00** - DATABASE DESTROYED
- My orchestration wiped tasks.db from 4315 tasks to 46 tasks
- Sequence counter reset
- All tasks after Feb 16 11:35 AM lost

### **Feb 19, 19:58** - Second Agent Creates Tasks
- After my database wipe, another agent created new T001: "API Terminology Standardization"
- T002-T046: API epic subtasks created
- These used T001-T046 IDs, **colliding with original Wave 8 tasks**

### **Feb 19, 20:30+** - Recovery
- Restored tasks.db from git HEAD (4315 tasks)
- Lost all work between Feb 16 11:35 AM and Feb 19 10:25 AM
- Recovered T4720-T4731 from todo-log.jsonl
- Moved API Epic to T4732-T4738 (proper IDs)

---

## Root Causes

### 1. **Sequence Management Failure**
- Sequence file (.cleo/.sequence) was not being updated properly
- Counter showed 4698 but actual max ID was 4719
- Multiple agents reading stale sequence data
- **Gap**: 21 IDs missing between counter and actual max

### 2. **Auto-Checkpoint Failure**
- Last auto-checkpoint: Feb 16, 11:35 AM (3 days ago)
- 1 file pending: todo-log.jsonl
- Auto-checkpoint **never ran** for 3 days
- All work between checkpoints lost

### 3. **No Write Verification**
- Tasks were created via MCP operations
- Operations logged to todo-log.jsonl
- But tasks were **never actually written to tasks.db**
- 83 creation events for T001-T046, but 0 tasks in database

### 4. **No Collision Detection**
- When T4720-T4729 were created, no check for existing IDs
- When API Epic was created after wipe, reused T001-T046
- No validation that IDs were actually available

### 5. **Agent Confusion**
- I used wrong subagent_type (ct-task-executor instead of cleo-subagent)
- Wrong MCP operations (tasks.start doesn't exist)
- Wrong assumptions about CLEO API behavior

---

## Data Loss Summary

| ID Range | What Was Lost | Status |
|----------|--------------|--------|
| T001-T007 | API Epic tasks (8 tasks) | Permanently lost |
| T008-T046 | Original Wave 8 tasks | Still exist, confused with API tasks |
| T4720-T4729 | Migration Safety Epic | Recovered from log |
| All after Feb 16 11:35 | Tasks added between checkpoints | Lost, unrecoverable |

---

## Immediate Fixes Applied

1. ✅ **Restored tasks.db** from git HEAD (4315 tasks)
2. ✅ **Recovered T4720-T4731** from todo-log.jsonl
3. ✅ **Moved API Epic** to T4732-T4738 (proper sequence)
4. ✅ **Fixed sequence counter** to 4738
5. ✅ **Backed up todo-log.jsonl** before any modifications

---

## Safety Mechanisms That Failed

### Failed: Auto-Checkpoint
- Should commit every 5 minutes
- Hasn't run in 3 days
- No alerts or warnings

### Failed: Sequence Validation
- No verification that counter matches actual data
- No collision detection
- Allows creating tasks with existing IDs

### Failed: Write Verification
- MCP operations succeed but don't actually write
- todo-log.jsonl gets entries, tasks.db doesn't
- No consistency checking

### Failed: Agent API Validation
- Agents can use wrong subagent_type
- No validation of MCP operations
- Skills vs agents confused

---

## Required Safety Improvements

### 1. **Fix Auto-Checkpoint System**
- Repair the auto-checkpoint mechanism
- Add monitoring/alerts when checkpoints fail
- Force checkpoint before destructive operations

### 2. **Implement Sequence Validation**
- Before any task creation, verify counter >= max(actual IDs)
- If sequence is behind, auto-repair
- Block task creation until sequence is valid

### 3. **Add Write Verification**
- After MCP write operation, verify task exists in database
- Compare todo-log.jsonl entries with actual tasks
- Report discrepancies immediately

### 4. **Collision Detection**
- Before creating task with ID, check if it exists
- If exists, reject or auto-assign next available
- Never allow duplicate IDs

### 5. **Agent API Guardrails**
- Validate subagent_type before spawning
- Validate MCP operations before executing
- Clear documentation of correct patterns

### 6. **Data Integrity Checks**
- Regular consistency checks between log and database
- Alert on ghost entries (log events without database records)
- Auto-repair capability

---

## Lessons Learned

1. **Don't trust the sequence file** - always verify against actual data
2. **Verify writes** - log entries don't mean data was persisted
3. **Checkpoint frequently** - 3 days is too long between checkpoints
4. **Test recovery procedures** - we should have caught this faster
5. **Document agent APIs clearly** - confusion leads to data loss

---

## Prevention Checklist

- [ ] Fix auto-checkpoint mechanism
- [ ] Add sequence validation to task creation
- [ ] Implement write verification
- [ ] Add collision detection
- [ ] Create agent API validation
- [ ] Add data integrity monitoring
- [ ] Document recovery procedures
- [ ] Test backup/restore regularly

---

## Related Tasks

- **T4720-T4731**: Migration Safety Epic (completed before incident)
- **T4732-T4738**: API Terminology Epic (moved to proper IDs)
- **T001-T007**: API Epic tasks (permanently lost)

---

## Recovery Notes

The database is now stable with:
- 4334 total tasks
- T4720-T4731: Migration Safety Epic (recovered)
- T4732-T4738: API Terminology Epic (proper IDs)
- Sequence: T4738
- Last checkpoint: Needs to be updated

**DO NOT delete this file. It documents a critical incident.**
