---
id: duplicate-detection-system-one
tasks: [T12492]
kind: feat
summary: "`cleo add` duplicate detection asks System One one batched noul question per candidate (300 ms budget, shadow mode by default). The 15 s generative-LLM tier is now opt-in"
---
Tier 3 of `cleo add` duplicate detection used to be a generative LLM call on
the write path, with a 15 s timeout. It is now ONE `decide()` request that
carries up to 3 Tier-2-ambiguous candidates as noul questions. The request is
bounded at 300 ms, measured from the start of the decision step, so the
client's own setup counts against it. On timeout, provider error, budget
denial or an unconfigured provider, detection falls back to the Tier-1 answer.

**Data sent to the provider.** Once a provider is configured with
`cleo decide config`, the default mode is `shadow`. On every *ambiguous* add,
shadow mode sends the provider:

- the new task's title and description;
- the ids, titles and descriptions of up to 3 existing active tasks.

Each field is redacted for known credential patterns and then clipped (titles
to 160 characters, descriptions to 440). Nothing is sent when no provider is
configured, or when `decide.sites.duplicateDetection` is `off`.

- `decide.sites.duplicateDetection` takes `off`, `shadow` or `on`.
  - `shadow` (the default once configured) asks the provider, then acts on the
    heuristic.
  - `on` acts on the decision, but only when every answer has confidence of at
    least 0.6. A rejection in `on` mode reports the value as a "System One
    duplicate probability", not as a similarity score.
  - With no provider configured, the mode is always `off` and no network call
    is made.
- **Shadow audit.** Each line in `.cleo/audit/decisions.jsonl` now carries
  `model` and a `shadow` record. The record holds:
  - the heuristic's overall verdict;
  - each candidate's Tier-3 verdict (`warn` or `pass`) and raw Tier-1 score,
    next to the decision answers;
  - which answer was acted on;
  - `agree` (null on fallback);
  - the task id behind each question.

  The file rotates by size: 5 MB, with 3 older generations kept. The API key
  is never written.
- **Generative-LLM tier.** The T1681 tier now runs only when
  `decide.generativeFallback.duplicateDetection: true`. An unconfigured
  `cleo add` returns the same verdicts as before, and it no longer resolves
  LLM credentials or loads the LLM stack.
- **Transport (process exit).** Provider calls now use an abort-complete
  node:http(s) transport instead of the global `fetch`. An aborted request
  used to keep its connect-phase handle, and `cleo add` then waited for the
  3 s teardown backstop (exit at about 4.4 s):
  - a TLS black hole: the server accepts the connection and never replies;
  - an unroutable address;
  - slow DNS.

  DNS now goes through a cancellable `dns.Resolver`. Sockets are unpooled
  (`agent: false`) and are destroyed on abort, in any phase.
- **Rate limits.** `retry-after` is capped at 60 s. Negative, past or
  unparseable values are ignored. A cool-down persisted by an earlier uncapped
  build is clamped as well.
- **Provider URL.** A URL with userinfo (`user:pass@host`) is rejected by
  `cleo decide config`, and the password is never echoed.
- **Redaction.** The shared redaction patterns (`@cleocode/utils`) now cover
  GitHub tokens (`ghp_`, `gho_`, `ghu_`, `ghs_`, `ghr_`, `github_pat_`).
- `DuplicateCheckResult.tier` gains `'decision'`. The duplicate-bypass audit
  (`--force-duplicate`) is unchanged.
