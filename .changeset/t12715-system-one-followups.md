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

**Lazy capability detection (AC b).** Capabilities were detected only by
`cleo decide config` and `cleo decide status`. `decideBatch` now detects them
on first use when the cached provider state is absent or older than 10
minutes, before it builds the provider, bounded by 5 s and by the batch
deadline. The shared `refreshProviderState` (also used by `cleo decide
status`) runs at most one detection per base URL and key hash per 10 minutes:
it writes a failed detection too, keeps the previous capabilities after a
transient failure (network, timeout, 5xx, 429), and keeps an in-process
attempt memo for an unwritable state file. A single 300 ms `decide()` never
detects, neither in line nor in the background, because a pending background
request would keep a one-shot CLI process alive past its work. It uses the
cached state, or the Jev minimum until one exists; the minimum only omits the
optional `lang` and `cache` body fields. `DecideOptions` gains `fetch` and
`providerStatePath`.

**Live decision-contradiction site (AC c).** `memory.decision-contradiction`
never fired: `storeDecision` ran it only when `validateWithLlm === true`, and
no caller set that flag. The spec (§3 site table) keeps the site at `shadow`
by default and advisory, so it is now wired rather than removed. Every ADR
write (`adrPath` set, e.g. `cleo memory decision-store --adr-path`) without
`validateWithLlm` calls the new `adviseDecisionConflicts`. It runs the System
One site with the generative tier forced off, within the site's 300 ms
budget. In `shadow`, the default once a provider is configured, it only
audits. In `on`, a confident contradiction is logged as a warning. With no
provider configured it is `off` and makes no network call. It never throws
and never rejects the write. Owner decision: this shadow check runs by
default on every ADR write once System One is configured, so each such write
can cost one billed System One call. A re-store of identical text (the
duplicate-update path) skips the check entirely, and a stored decision with
the same normalized text is never a candidate, so a decision is never
reported as contradicting itself. The generative (T1828) check and rejection below
the confidence threshold still run only with an explicit `validateWithLlm`.
