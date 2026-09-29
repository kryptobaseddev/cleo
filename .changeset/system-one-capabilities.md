---
id: system-one-capabilities
tasks: [T12664]
kind: feature
summary: System One provider capabilities, layahost extensions, a $1/month spend cap, key-limit and overload handling, and a richer `cleo decide status`
---

This is phase 3 of the System One integration (spec `system-one-integration`
§2.2–2.4 and §7, D11159).

**Provider capabilities.** `DecisionProvider` keeps `decide(req, signal)`.
It gains optional `capabilities()`, `decideBatch()`, `usage()` and
`decideTemplate()`, which the client uses only when the matching capability is
present. A provider without `capabilities()` is treated as the Jev minimum.

The Jev adapter is now `jev-wire/2`:

- It reads cost in integer micros (`meta.cost_micros` or
  `x-layahost-cost-micros`), the `x-layahost-balance-micros` balance and
  `meta.checkpoint`, and records all three in the audit row.
- It sends the `lang` and `cache` request fields only when the provider
  supports them.
- It adds `POST /v1/systemone/batch` (up to 64 requests and 256 questions,
  with a status per item) and `GET /v1/usage`.

The extensions are detected from the `/v1/usage` and `/v1/templates`
responses, never from the host name, so a plain Jev host sees exactly the Jev
body.

**Errors.** A 403 `key_limit_exceeded` is now its own kind and is never
reported as `unauthorized`. Decisions stop until the UTC month rolls over.
A 529 or 503 is `overloaded`: a short circuit-breaker trip on the request
bucket that honours `retry-after` (30 s by default).

**Spend cap (D11159).** `decide.budget.monthlyMicros` (default 1,000,000,
i.e. $1) is enforced across processes in `<cleoHome>/decide/spend.json`. Once
the month-to-date spend reaches it, every site degrades to its heuristic with
fallback reason `budget`, and no command fails. The request-rate token bucket
stays in place.

**`decideBatch()`** in the client sends one batch call when the provider has
the capability. Otherwise it makes sequential calls that share the deadline.

**`cleo decide status`** reports:

- the sites count;
- the capabilities;
- the balance, from `/v1/usage` read at most every 10 minutes;
- the month-to-date spend against the cap;
- `key_limit_reached` when the key's monthly limit is hit.

Gate 35 now also checks site ids passed to `decideBatch()`.
