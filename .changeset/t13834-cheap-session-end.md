---
id: t13834-cheap-session-end
tasks: [T13834]
kind: perf
summary: "cleo session end no longer loads the whole CORE barrel: about 0.7 s instead of 1.7 s, so every Claude Code Stop is about 0.5 s faster"
---

Every Claude Code Stop runs `cleo session end`. After the session ended, it
imported two best-effort memory helpers (`persistSessionMemory`,
`refreshMemoryBridge`) from `@cleocode/core/internal`. That pulled the whole
CORE barrel: about 2,170 modules, model SDKs, ajv, node-cron and graphology.
It now imports them from their defining modules.

Ending a real session drops from about 1.6–2.1 s to about 0.70–0.78 s, and
loads about 905 modules. `cleo hook stop --provider claude-code` drops from
about 1.15 s to about 0.69 s. The session record, the journal entry, the
debrief and handoff, memory persistence and the detached VACUUM INTO snapshot
all still run.

A gate 39 probe, `session-end`, caps it at 1,000 modules and forbids the CORE
barrel and model SDKs.
