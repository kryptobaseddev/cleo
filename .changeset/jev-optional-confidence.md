---
id: jev-optional-confidence
tasks: [T12715]
kind: fix
summary: System One accepts Jev answers without `confidence`, so plain Jev hosts stop falling back to the heuristic
---

A plain Jev host (for example `jev-latest` → `jev-1.13.0`) answers
`POST /v1/systemone` with `{"answers":{"q":{"type":"noul","noul":0.99}}}` and
no `confidence` field; only layahost sends one. The wire adapter required it,
so every decision from such a host was rejected as `invalid_response` and fell
back to the heuristic (the setup wizard's smoke test showed
`Fallback: invalid_response`).

`confidence` is now optional on the wire. When a host omits it, the adapter
derives it from the probabilities as the margin between the two most likely
outcomes: `|2p − 1|` for a noul answer, `p(top) − p(runner-up)` for choice and
score answers, always in [0, 1]. A reported `confidence` is still preferred.
The single and batch (`/v1/systemone/batch`) paths share this mapping.

The adapter version is now `jev-wire/4`, which invalidates cached outcomes
from the old mapping. A host that reports no cost (`meta.cost_*` absent) is
still charged nothing in the spend ledger. The `cleo decide bench` report now
marks such a provider's cost column as an estimate (`~$… (est.)`) instead of
presenting the reservation estimate as a billed cost.
