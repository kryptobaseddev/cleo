---
id: decision-contradiction-system-one
tasks: [T12493]
kind: feat
summary: "Model-validated ADR decision writes ask System One one choice question per prior decision (300 ms budget, shadow by default once configured). Contradictions come from typed answers, not ids scraped from prose"
---
When a caller asks `storeDecision` for model validation (`validateWithLlm: true`
plus an `adrPath`), the contradiction check used to be a generative-LLM call
with no timeout. Its prose "insights" were scanned with `/\bD\d{3,}\b/` for
decision ids. The check is now ONE `decide()` request:

- **Candidates** are the top 3 prior decisions by the validator's existing
  word-overlap (Jaccard) score. A prior decision that shares no word with the
  new one is never sent.
- **One `choice` question per candidate**: `contradicts`, `supersedes`,
  `refines` or `unrelated`. A contradiction is the typed answer `contradicts`
  about a known candidate id. A `contradicts` answer about the decision the
  new one declares in `supersedes` is not counted.
- **Budget**: 300 ms, measured from the start of the decision step, so the
  client's own setup counts against it. On timeout, provider error, budget
  denial or an unconfigured provider, the heuristic answers.
- **Out-of-range choice**: the client checks only the answer type. This site
  also rejects a `choice` value outside the four options, then falls back.
  The audit line marks it `shadow.rejected: "invalid_choice"`.

**Data sent to the provider.** Once a provider is configured with
`cleo decide config`, the default mode is `shadow`. On every model-validated
ADR decision write that has at least one overlapping prior decision, shadow
mode sends the provider:

- the new decision's type, text and rationale;
- the ids, texts and rationales of up to 3 prior decisions.

Each field is redacted for known credential patterns and then clipped
(decision text to 160 characters, rationale to 440). The ADR path is not
sent. Nothing is sent when no provider is configured, or when
`decide.sites.decisionContradiction` is `off`. No `cleo` command requests
model validation today, so only SDK callers that pass `validateWithLlm: true`
reach this path.

- `decide.sites.decisionContradiction` takes `off`, `shadow` or `on`.
  - `shadow` (the default once configured) asks the provider, then acts on the
    heuristic.
  - `on` acts on the answers, but only when every answer has confidence of at
    least 0.6. A contradiction then sets the validator confidence to
    `1 − P(contradicts)`; below `decisions.validatorConfidenceThreshold`
    (default 0.7) the write is rejected with `E_DECISION_VALIDATOR_FAILED`,
    as before.
  - With no provider configured, the mode is always `off` and no network call
    is made.
- **Shadow audit.** Each `.cleo/audit/decisions.jsonl` line for site
  `memory.decision-contradiction` carries a `shadow` record: the heuristic's
  answer (`unrelated`) and per-candidate verdict (`collision` or `none`) with
  its raw Jaccard score, the decision answers, which answer was acted on,
  `agree` (null on fallback), and the decision id behind each question.
- **Generative check (T1828).** It now runs only when the decision did not
  act and `decide.generativeFallback.decisionContradiction` resolves true.
  When the key is unset, it is on while no provider is configured, so an
  unconfigured write behaves as before, and off once one is. It is now
  bounded at 15 s; an aborted call yields the no-signal result.
- Shared call-site plumbing (`resolveDecisionSiteSettings`, `redactThenClip`,
  `isDecisionSiteMode`) moved to `packages/core/src/decide/site.ts`.
  `cleo add` duplicate detection (T12492) uses it with unchanged behaviour.
