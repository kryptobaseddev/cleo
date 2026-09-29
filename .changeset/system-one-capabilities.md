---
id: system-one-capabilities
tasks: [T12664]
kind: feat
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
- It adds `POST /v1/systemone/batch` (up to 64 requests and 256 questions).
  Responses are read per the provider's OpenAPI,
  `{responses:[{index,status,body}]}`, and placed by `index`. It also adds
  `GET /v1/usage`, whose field names are unverified and parsed tolerantly,
  and `GET /v1/templates`, keyed by `template`.

The extensions are detected from the `/v1/usage` and `/v1/templates`
responses, never from the host name, so a plain Jev host sees exactly the Jev
body.

**Errors.** A 402, or a 429 `insufficient_quota` (empty balance), is credit
exhaustion and is never reported as `unauthorized` or as a rate limit. A 503
is `overloaded`: a short circuit-breaker trip on the request bucket that
honours `retry-after` (30 s by default).

Two extras are handled tolerantly but are unverified; they appear in the
provider docs, not its OpenAPI:

- a 403 `key_limit_exceeded`, which stops decisions until the UTC month rolls
  over;
- a 529, treated as `overloaded`.

The same goes for the `x-layahost-*` cost and balance headers.

**Spend cap (D11159).** `decide.budget.monthlyMicros` (default 1,000,000,
i.e. $1) is enforced across processes in `<cleoHome>/decide/spend.json`. Once
the month-to-date spend reaches it, every site degrades to its heuristic with
fallback reason `budget`, and no command fails.

Each call reserves its estimated cost under the same lock as the cap check,
then commits the reported cost, so concurrent callers cannot overshoot the
cap. The lock waits about a second, so no concurrent cost is lost. A call
aborted after it was sent (deadline or caller) may still be billed, so its
estimate is committed; only a failure before send or an error response
releases it. A reservation still pending after 60 seconds (its process exited
first) is charged at its estimate, not dropped.

A corrupt ledger fails closed. `cleo decide status` names the repair,
`cleo decide budget reset`, which moves the old file aside as a receipt. It
refuses a readable ledger unless `--force` is given, and a forced reset keeps
the month-to-date spend, so a reset never lifts a reached cap. The
request-rate token bucket stays in place.

**`decideBatch()`** in the client sends one batch call when the provider has
the capability. Otherwise it makes sequential calls that share the deadline.
A failed batch item has the same effect on the gates as a failed single call
(key-limit stop, rate-limit and overload back-off).

Cached provider capabilities are keyed by base URL and a truncated sha256 of
the API key; the key itself is never stored.

**`cleo decide status`** reports:

- the sites count;
- the capabilities;
- the balance, from `/v1/usage` read at most every 10 minutes;
- the month-to-date spend against the cap;
- `key_limit_reached` when the key's monthly limit is hit.

Gate 35 now also checks site ids passed to `decideBatch()`.
