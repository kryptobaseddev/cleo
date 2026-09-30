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
derives it from the probabilities as the margin of the chosen outcome over the
most likely other one, clamped to [0, 1]: `|2p − 1|` for a noul answer,
`p(chosen) − max(p(others))` for choice and score answers (a host-named choice
that is not the most probable option gets 0). A reported `confidence` is
still preferred; plain Jev reports one for choice and score and omits it only
for noul. The single and batch (`/v1/systemone/batch`) paths share this
mapping.

The adapter version is now `jev-wire/4`, which invalidates cached outcomes
from the old mapping. A host that reports no cost (`meta.cost_*` absent) is
now charged the per-question reservation estimate in the spend ledger, so the
monthly spend cap still applies to it; a reported cost is charged as
reported. `cleo decide bench` charges the same estimate. Its report now
marks such a provider's cost column as an estimate (`~$… (est.)`) instead of
presenting the reservation estimate as a billed cost.
