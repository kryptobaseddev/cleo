# STALE — DO NOT READ THIS FILE FOR STATE

**This file is deprecated as canonical state per T1593 (shipped in v2026.4.157).**

The current state of the project lives in **TASKS + BRAIN** — never in markdown.

## What you must do instead

```bash
cleo briefing
```

That command returns:
- The structured `lastSession.handoff.note` — guaranteed current, written at session-end
- `nextTasks` ranked by score — the system's recommendation for what to work on
- `blockedTasks` showing dependency chains — what cannot start yet
- `memoryContext` with relevant BRAIN observations
- `activeEpics` with completion percentages

## If you are seeing this and you ALREADY started reading instead of running `cleo briefing`

Stop. Run `cleo briefing`. Then `cleo memory find "IRONCLAD-ROADMAP"` if needed.
The system has explicit instructions for the next orchestrator that do NOT live in this file.

## Verification

Run any of these to verify state from the canonical source:

```bash
cleo briefing                        # next-session handoff (canonical)
cleo dash                            # task counts
cleo memory find "roadmap"           # roadmap observations in BRAIN
```

---

*This file deliberately contains no state. Reading it cannot mislead you. Run `cleo briefing`.*
