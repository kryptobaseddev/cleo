---
id: remove-dead-conduit-span-writer
tasks: [T14376]
kind: breaking
summary: "the OpenAI SDK adapter no longer shells out to the removed cleo conduit send verb for every span, and the doctor I5 fix no longer names a missing cleo conduit prune verb"
breaking: "Removed: the CleoConduitTraceProcessor export of @cleocode/adapters (openai-sdk) and the internal conduit-trace-writer module; spawns no longer register a default trace processor. Replacement: implement CleoTraceProcessor and pass your own processor to registerTraceProcessor (unregisterTraceProcessor to remove it)."
---

`CleoConduitTraceProcessor` and the shared `conduit-trace-writer` module are
removed. The writer ran `cleo conduit send --type agent_span --payload …` on
every span end; those flags never existed and the verb is retired, so every
write failed silently. Spans still dispatch to any processor registered with
`registerTraceProcessor`; none is registered by default.

The `cleo doctor db-substrate` I5 suggested fix now says to re-anchor or
delete the orphan `conduit_dead_letters` row instead of naming
`cleo conduit prune --orphans`, which never existed.
