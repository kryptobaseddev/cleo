# T5124: Session Operation Decision Tree

## Quick Decision Tree

```
"I want to..."
|
+-- Know if a session is running
|   --> session.status (query, Tier 0)
|       No params. Returns active session info or null.
|
+-- See what happened last session
|   --> session handoff.show (query, Tier 0)
|       Optional: scope="global" or scope="epic:T1234"
|       Returns last task, completed tasks, next suggestions.
|
+-- Get a briefing before starting work
|   --> session briefing.show (query, Tier 0)
|       Optional: scope, maxNextTasks, maxBugs, maxBlocked, maxEpics
|       Returns next tasks, open bugs, blockers, epic summaries.
|
+-- Start working
|   --> session start (mutate, Tier 1)
|       Required: scope (e.g., "global" or "epic:T1234")
|       Optional: name, startTask/focus, grade
|
+-- Stop working
|   --> session end (mutate, Tier 1)
|       Optional: note, nextAction
|       Auto-computes debrief and handoff data.
|
+-- Record a decision I made
|   --> session record.decision (mutate, Tier 1)
|       Required: decision, rationale
|       Optional: sessionId, taskId, alternatives
|
+-- Find a past session
|   --> session find (query, Tier 1)
|       Optional: status, scope, query, limit
|       Returns minimal records. Preferred over list.
|
+-- See full details of a session
|   --> session show (query, Tier 2)
|       Required: sessionId
|
+-- Browse all sessions
|   --> session list (query, Tier 2)
|       Optional: active, limit (default 10)
|       Heavier than find. Use find for discovery.
|
+-- Pause work temporarily
|   --> session suspend (mutate, Tier 2)
|       Required: sessionId
|       Optional: reason
|
+-- Resume paused work
|   --> session resume (mutate, Tier 2)
|       Required: sessionId
|
+-- See session event timeline
|   --> session history (query, Tier 2)
|       Optional: sessionId, limit
|
+-- Review decisions from a session
|   --> session decision.log (query, Tier 2)
|       Optional: sessionId, taskId
|
+-- Record an assumption
|   --> session record.assumption (mutate, Tier 2)
|       Required: assumption, confidence (high/medium/low)
|       Optional: sessionId, taskId
|
+-- Get full session debrief
|   --> session debrief.show (query, Tier 2)
|       Required: sessionId
|       Superset of handoff. Includes git state, metrics.
|
+-- See session chain/lineage
|   --> session chain.show (query, Tier 2)
|       Required: sessionId
|
+-- Analyze context drift
|   --> session context.drift (query, Tier 3)
|       Optional: sessionId
|       Advanced: measures how far context drifted from start.
|
+-- Clean up old sessions
    --> session gc (mutate, Tier 3)
        Optional: maxAgeDays
        Maintenance only.
```

## Typical Agent Session Flow

```
Session Start:
  1. session status        --> Is there an active session?
  2. session handoff.show  --> What happened last time?
  3. session briefing.show --> What should I work on?
  4. session start         --> Begin work (scope: global or epic:T####)

During Work:
  5. session record.decision --> Document significant decisions

Session End:
  6. session end           --> End session (auto-computes debrief)
```

## Tier Summary

| Tier | Operations | Purpose |
|------|-----------|---------|
| 0 | status, handoff.show, briefing.show | Session awareness (every session) |
| 1 | start, end, find, record.decision | Core session lifecycle |
| 2 | show, list, resume, suspend, history, decision.log, record.assumption, debrief.show, chain.show | Detailed session management |
| 3 | context.drift, gc | Advanced/maintenance |

## Budget Guide

| Operation | ~Tokens | Frequency |
|-----------|---------|-----------|
| `status` | ~200 | Every session start |
| `handoff.show` | ~300-500 | Every session start |
| `briefing.show` | ~500-1000 | Every session start |
| `start` | ~200 | Once per session |
| `end` | ~200 | Once per session |
| `record.decision` | ~100 | As needed |
| `find` | ~200-400 | Rare |
| `list` | ~500-2000 | Avoid unless needed |
| `show` | ~300-600 | When specific session needed |
