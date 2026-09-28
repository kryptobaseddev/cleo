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

- `decide.sites.duplicateDetection`: `off | shadow | on`. When a provider is
  configured (`cleo decide config`), the default is `shadow`: ask, then act on
  the heuristic. `on` acts on the decision. With no provider configured, the
  mode is always `off` and no network call is made.
- Shadow audit: each line in `.cleo/audit/decisions.jsonl` now carries `model`
  and a `shadow` record. The record holds the heuristic verdict, the
  heuristic's noul answer per candidate next to the decision answers, which
  answer was acted on, `agree` (null on fallback, so there is nothing to
  compare) and the task id behind each question. The API key is never written.
- The generative-LLM tier (T1681) now runs only when
  `decide.generativeFallback.duplicateDetection: true`. An unconfigured
  `cleo add` returns the same verdicts as before, and it no longer resolves
  LLM credentials or loads the LLM stack.
- `DuplicateCheckResult.tier` gains `'decision'`.
- The duplicate-bypass audit (`--force-duplicate`) is unchanged.
