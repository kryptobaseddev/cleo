---
id: t12164-dup-detector-hoist-and-rename
tasks: [T12164]
kind: fix
summary: embed the incoming blob once per duplicate check instead of once per candidate, and stop calling the Tier-1 score BM25
---

Two changes to `duplicate-detector.ts`, both with no behavioural effect on the decision it reaches.

## 1. The incoming blob was embedded once per candidate

`tryVectorSimilarity` did this, **inside the loop over every active task**:

```ts
const [vecA, vecB] = await Promise.all([embedText(incomingBlob), embedText(candidateBlob)]);
```

So the *same* incoming text was embedded once for each candidate. Against the live store's **1,126** active tasks that is 1,126 embeddings of one string per `cleo add`, where one is needed. This is the O(active-tasks) cost on the write path, and it is why a `cleo add-batch --dry-run` — the operation whose entire contract is to insert nothing — has been measured exceeding 120 seconds on a single-task file.

The incoming vector is now computed once by `embedIncomingOnce` before the loop and passed in; only the candidate is embedded per iteration. Total embeddings per check go from **2N** to **1 + N**.

A test pins it by **call count rather than wall-clock** — a timing test would be flaky and would not say which call was redundant. Against main it fails with `expected [ …(25) ] to have a length of 1 but got 25`.

Candidate-vector caching is deliberately **not** included: it is a separate design with cache-invalidation questions, and it should not hold up a change that is a pure win.

## 2. It is not BM25, and the name cost real work

The Tier-1 score was called `bm25Score`, its threshold `BM25_ESCALATE_LOW`, and the docblock said "BM25 score >= 0.85". **There is no BM25 in this file** — no IDF, no term frequency, no document-length normalisation. Tier 1 is Jaccard over character trigrams of a title-2×-weighted blob (or cosine over embeddings when a provider is loaded).

This is not cosmetic. Two engineers reasoned from the name and reached a false conclusion on the same day: a hypothesis that "BM25 normalisation inflates scores for short titles" sent a full investigation after a mechanism that does not exist in the code. Measurement then showed short titles score *lower*, not higher (`ZZ` → 0.0000, `Zorblax quimbly` → 0.0161, against a 0.5 escalation gate).

Renamed: `bm25Score` → `tier1Score`, `BM25_ESCALATE_LOW` → `TIER1_ESCALATE_LOW`, and every docblock and comment corrected to describe what the code does.

**Deliberately NOT renamed**, because both are contract surface and this change is behaviour-free:

- `DUPLICATE_WARN_THRESHOLD` / `DUPLICATE_REJECT_THRESHOLD` — exported API.
- the `tier: 'bm25'` envelope literal — emitted to consumers. It now carries a docblock stating it is a historical label and that Tier 1 is not BM25.

## Measured context (not changed here)

Sampling 226 real titles against all 1,126 live candidates on the lexical path: **86.3%** never leave Tier 1, 0.4% reach Tier 2, **11.9%** reach the Tier-3 LLM call, 1.3% are rejected at Tier 1. And 11.9% is an upper bound — every sampled title is an existing task on a board of closely-related work, so it has near-siblings by construction. On that path the tiering discriminates as designed and earns its place.

Two defects found in the same investigation are **filed, not fixed here**, because fixing them requires calibration evidence this change does not have: Tier 1 has two implementations selected by an un-awaited `setImmediate` race on whether the embedding provider finished loading, and both share thresholds that can only have been tuned for one of them.
