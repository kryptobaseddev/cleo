---
id: legacy-alias-ambiguity-focus-diagnostics
tasks: [T12589, T12590]
kind: fix
summary: "A truncated legacy project alias shared by several projects resolves to none and no longer warns on every command; `cleo focus` no longer fails its memory and ready-wave sources"
---
**T12589.** The legacy project id is `base64url(path).slice(0, 32)`, which
encodes only the first 24 path bytes. Every project under a long shared prefix
(for example `/Users/<name>/projects/`) derived the same key. The first project
to record it owned it, so the key resolved to the wrong project for all the
others. Each later project's encounter also wrote
`[cleo] Project encounter omitted colliding legacy alias` to stderr on every
command, which broke agents that parse `2>&1` as JSON.

A key that more than one registered project claims is now ambiguous. It is not
recorded for a second project, and the encounter says nothing about it.
`resolveProjectById`, `nexusGetProject` (which throws
`E_NEXUS_PROJECT_AMBIGUOUS`) and `@cleocode/paths` `resolveCanonicalCleoDir`
all refuse it. A key that only one project claims still resolves.
`cleo doctor projects` lists existing ambiguous alias rows in
`ambiguousAliases`. `--apply` removes them under its receipt, and `--rollback`
restores them. The substrate invariant I3 now looks up the project's declared
id, not the shared legacy key.

**T12590.** `resolveAttentionIdentity` closed its task accessor. That close
evicts every project-scope database binding in the process. `cleo focus` builds
the attention digest at the same time as memory search and the ready wave, so
those failed with `BRAIN database unavailable` and
`Failed query: select "id" from "tasks_tasks"`. The accessor is no longer
closed, because its lifecycle belongs to the dual-scope chokepoint. A failed
focus source diagnostic now includes the underlying error code and message.
