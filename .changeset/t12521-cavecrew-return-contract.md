---
id: t12521-cavecrew-return-contract
tasks: [T12521]
kind: feat
summary: Spawn prompts use a compressed return + manifest contract (767 -> 357 est. tokens); validators accept it and the legacy one-liner
---

The Return Format Contract and Manifest Protocol blocks in every spawn prompt
now ask for a compressed cavecrew-style return:

```
<Type> <complete|partial|blocked>. manifest:<entryId>
commits: <sha7,sha7|none>
gates: <gate>=<pass|fail|skip> ...
blocker: <≤12 words|none>
```

The two blocks shrink from 767 to 357 estimated tokens (chars / 4) for
`implementation` (783 -> 372 with o200k_base); a test pins the ceiling. The
HITL line (subagents never ask the human) is unchanged.

Fixes in the same blocks:

- The manifest receipt is read with `--field /data/entryId` plus an empty-id
  guard and a `cleo manifest show` readback, not a `python3` pipe (ADR-086).
- Every protocol appends with its own manifest `--type`: `consensus`,
  `specification` and `architecture_decision` no longer fall through to
  `implementation`.

`checkReturnMessageFormat`, `checkReturnFormat` and `validateReturnMessage`
share a new `parseReturnMessage` and accept the compressed block AND the legacy
`<Type> <status>. Manifest appended to pipeline_manifest.` one-liner. They also
accept the `complete` spelling the prompt renders and the `ADR` type word.
