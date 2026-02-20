> **⚠️ ARCHIVED DOCUMENT**
>
> **Archived**: 2025-12-30
> **Reason**: Analysis complete; findings integrated into TASK-HIERARCHY-SPEC.md v3.0.0
> **Superseded by**:
>   - TASK-HIERARCHY-SPEC.md Parts 5-8 (specification)
>   - T1028-DEFINITIVE-WORK-MAP.md (consensus decisions)
>   - T1032-WAVE-COMPUTATION-ALGORITHM.md (algorithm details)
>
> This document is preserved for historical reference only.

---

═══════════════════════════════════════════════════════════════════════════════
DEEP ANALYSIS: Epic Report Enhancement
═══════════════════════════════════════════════════════════════════════════════

CURRENT STATE
─────────────────────────────────────────────────────────────────────────────

Commands Available: 44 total
Key Analysis Commands:
• tree (list --tree)  → Hierarchy only, no deps
• deps                → Project-wide, no epic scoping
• phases              → Phase listing, no task breakdown
• blockers            → Blocked tasks, global only
• analyze             → Triage/recommendations, global only

Task Schema Properties Available:
• phase      → setup|core|testing|polish|maintenance ✅
• depends    → Array of task IDs ✅
• parentId   → Hierarchy ✅
• type       → epic|task|subtask ✅
• status     → pending|active|blocked|done|cancelled ✅
• priority   → critical|high|medium|low ✅

Missing Schema Values:
• wave       → NOT in schema (but COMPUTABLE from dependency depth)
• depthLevel → NOT in schema (but COMPUTABLE)

GAP ANALYSIS
─────────────────────────────────────────────────────────────────────────────

What I Had to Do (7 Steps):
1. cleo list --parent T998          → Get children
2. cleo list --parent T1013         → Get subtasks
3. Parse .depends from each task    → Manual extraction
4. Cross-reference .status          → Manual check
5. Group by .phase                  → Manual grouping
6. Calculate dependency depth       → Manual computation
7. Construct ASCII visualization    → Manual formatting

What Should Exist:
ONE command that computes all of this from existing schema values

DESIGN RECOMMENDATION
─────────────────────────────────────────────────────────────────────────────

Option: Enhance `analyze` with --parent scoping (BEST FIT)

Rationale:
• analyze already does triage/recommendations
• Follows existing pattern: list --parent, tree --parent
• No new command to learn
• Just adds scoping to existing capability

Usage:
cleo analyze                    # Project-wide (current behavior)
cleo analyze --parent T998      # Epic-scoped (new capability)
cleo analyze --parent T998 --human  # ASCII visualization

PROPOSED JSON OUTPUT STRUCTURE
─────────────────────────────────────────────────────────────────────────────

{
"epic": {
  "id": "T998",
  "title": "...",
  "progress": { "done": 8, "total": 30, "percent": 27 }
},

"phases": [
  {
    "phase": "setup",
    "status": "complete",      // complete|in_progress|blocked|pending
    "progress": { "done": 4, "total": 4 },
    "waves": [                 // Grouped by dependency depth
      { "depth": 0, "tasks": ["T1014"], "allDone": true },
      { "depth": 1, "tasks": ["T1015"], "allDone": true },
      { "depth": 2, "tasks": ["T1016"], "allDone": true }
    ]
  },
  {
    "phase": "core",
    "status": "in_progress",
    "progress": { "done": 4, "total": 16 },
    "waves": [
      { "depth": 0, "tasks": ["T1022", "T1019"], "allDone": false },
      { "depth": 1, "tasks": ["T1017", "T1025", "T1026"], "allDone": false }
      // ...
    ]
  }
],

"dependencyChains": [
  {
    "id": "A",
    "name": "Original Setup Chain",
    "path": ["T1014", "T1015", "T1016", "T1008", "T1003"],
    "status": "partial",       // complete|partial|blocked
    "completedCount": 4
  },
  {
    "id": "B",
    "name": "Exit Code Chain",
    "path": ["T1022", "T1017", "T1018", "T1021", "T1027"],
    "status": "blocked",
    "completedCount": 0
  }
],

"inventory": {
  "completed": [
    { "id": "T1013", "phase": "setup", "title": "..." }
  ],
  "ready": [                   // All deps satisfied
    { "id": "T1022", "phase": "core", "priority": "critical", "deps": [] },
    { "id": "T999", "phase": "polish", "deps": ["T1008✓", "T1012✓"] }
  ],
  "blocked": [                 // Waiting on pending deps
    { "id": "T1017", "phase": "core", "waitingOn": ["T1022"] }
  ]
},

"executionPlan": {
  "criticalPath": {
    "entry": "T1022",
    "chain": ["T1022", "T1017", "T1018", "T1020", "T1024"],
    "depth": 5
  },
  "waves": [
    { "wave": 1, "parallel": ["T1022", "T1019", "T1003", "T999", "T1000"] },
    { "wave": 2, "parallel": ["T1017", "T1025", "T1026"], "after": "T1022" },
    { "wave": 3, "parallel": ["T1018", "T1023"], "after": "T1017" }
  ]
}
}

HUMAN OUTPUT (--human flag)
─────────────────────────────────────────────────────────────────────────────

The ASCII visualization I created earlier - automatically generated from
the same data structure.

KEY COMPUTATIONS NEEDED (from existing schema)
─────────────────────────────────────────────────────────────────────────────

1. Wave/Depth Calculation:
 depth = max(deps.map(d => depth(d))) + 1
 Tasks with no deps in phase = depth 0

2. Ready Calculation:
 ready = task.depends.every(d => getTask(d).status === 'done')

3. Chain Detection:
 Follow depends relationships, group into named chains

4. Phase Status:
 complete = all tasks done
 in_progress = some done, some pending
 blocked = has pending deps outside phase
 pending = no tasks started

BENEFITS
─────────────────────────────────────────────────────────────────────────────

For LLM Agents:
• Single command instead of 7-step process
• Self-documenting JSON output
• No jq manipulation needed
• Consistent structure every time

For Humans:
• --human flag for ASCII visualization
• Clear phase/wave organization
• Ready-to-start tasks highlighted
• Critical path identified

For CLEO:
• No new schema fields needed
• Uses existing --parent pattern
• Enhances existing analyze command
• Both JSON and human output
═══════════════════════════════════════════════════════════════════════════════

cleo epic T998 --full        # Full epic breakdown
cleo epic T998 --deps        # Epic dependency chain
cleo epic T998 --phases      # Phase progress
cleo epic T998 --ready       # Ready to start tasks

