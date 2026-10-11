---
id: t13358-docs-decision-ownertype
tasks: [T13358]
kind: fix
summary: Bare D#### decision IDs infer ownerType 'decision' instead of falling through to 'task'.
---

`inferOwnerType` (dispatch + `generateDocsLlmsTxt` mirror) matched `D-`/`dec_` prefixes, but real brain decision IDs are bare `D####`, so every decision-owned doc was misfiled under `ownerType: 'task'` — the mechanism behind 0 of ~360 decisions being linked to a doc. `D####` now infers `decision` in both copies; existing prefixes are unchanged.
