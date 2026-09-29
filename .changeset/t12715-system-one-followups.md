---
id: t12715-system-one-followups
tasks: [T12715]
kind: fix
summary: System One follow-ups — cost read from the OpenAPI meta only, a 30 s batch timeout, lazy capability detection and a live decision-contradiction site
---

**Cost comes from the response body (AC d).** The Jev wire adapter reads cost
only from `meta.cost_micros` and `meta.cost_usd`, the two fields the layahost
OpenAPI 1.0.0 declares on `SystemOneResponse.meta`. When only `cost_usd` is
present, micros are derived from it. The OpenAPI declares no response headers,
so the unverified `x-layahost-cost-micros` and `x-layahost-balance-micros`
header reads (and the `COST_MICROS_HEADER` / `BALANCE_MICROS_HEADER` /
`JevResponseHeaders` exports) are removed; the balance comes from
`GET /v1/usage`. The adapter version is now `jev-wire/3`, which invalidates
cached outcomes mapped by the old rules.

**Batch deadline (AC a).** `decideBatch` now defaults to
`DEFAULT_BATCH_DECISION_TIMEOUT_MS` (30 s) for the whole call instead of the
300 ms single-decision default, because `/v1/systemone/batch` answers its
items serially (2–5 s per 64) and the spec requires at least 30 s. When the
provider has no batch capability and the call degrades to sequential
decisions, each one is still capped at 300 ms unless the caller set
`timeoutMs`.
