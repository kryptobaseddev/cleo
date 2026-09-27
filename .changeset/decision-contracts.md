---
id: decision-contracts
tasks: [T12489]
kind: feat
summary: Add provider-neutral typed-decision contracts (DecisionRequest, DecisionAnswer, DecisionOutcome) with zod schemas
---

`@cleocode/contracts` now exports `decide.ts`: the domain types for typed
decisions (`noul` yes/no, `choice` pick-one, `score` ordered scale), the
request/answer/outcome shapes, `DecisionProviderConfig`, and zod schemas.
`decisionRequestSchema` enforces the request limits: 1–32 questions, a
32,000-character state (serialized size for structured state), at least two
choice options and 2–10 score levels. No vendor names; types, schemas and
const data only (arch gate 10).
