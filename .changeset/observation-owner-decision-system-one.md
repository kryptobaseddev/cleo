---
id: observation-owner-decision-system-one
tasks: [T12494]
kind: feat
summary: "System One sites 4-5: observation type chosen by one choice question when no type is given, and a needs-owner-decision noul for the readiness grill gate (300 ms budget each, shadow by default once configured)"
---
Two more call sites ask System One. Both use the shared site plumbing in
`packages/core/src/decide/site.ts`. The new `askSiteDecision` helper there
holds the deadline, audit and shadow-record wiring that site 2 wrote inline.
Neither site sends anything unless a provider is configured with
`cleo decide config`.

**Observation type (`decide.sites.observationType`).** When `observeBrain`
(including `cleo memory observe`) gets no `type`, it asks ONE `choice`
question over `bugfix | refactor | feature | decision | change | discovery`.
It asks before the writer queue, so a decision never holds the single brain
writer.

- The keyword heuristic now matches whole words and common inflections, not
  substrings. `address` no longer counts as `add` (`feature`), and `prefix`
  no longer counts as `fix` (`bugfix`). This change applies in every mode.
- `shadow` (the default once configured) audits the answer next to the
  keyword type and stores the keyword type. `on` stores the decided type when
  its confidence is at least 0.6. A choice outside the six options is rejected
  (`shadow.rejected: "invalid_choice"`), and then the keyword type is stored.
- `ObserveBrainResult` gains optional `typeSource` (`caller | keyword |
  system-one`) and `typeConfidence`. Nothing new is added to the stored row.
  The `.cleo/audit/decisions.jsonl` line for site `memory.observation-type`
  records the source and confidence.
- **Data sent:** the observation title (clipped to 160 characters) and text
  (clipped to 600), redacted before clipping.

**Needs-owner-decision (`decide.sites.ownerDecision`).** `cleo classify` and
the sentient auto-promote scan now call `classifyReadinessWithDecision`. For a
task with a non-blank `blockedBy` and no `owner-decision` label, it asks ONE
`noul` question: does the block need a human owner's decision, approval or
choice?

- `classifyReadiness` stays pure. It accepts the answer as
  `signals.ownerDecision` and uses it in place of the `owner`/`decision`
  substring rule only when the confidence is at least 0.6. The label always
  wins.
- It only flags. A flagged task grills with `OWNER_DECISION_REQUIRED`, and
  the reason says to route the question to the owner through the ask tool.
  System One never answers for the owner.
- `shadow` (the default once configured) audits the answer next to the
  substring rule and leaves the verdict unchanged. `on` acts on the answer.
- **Data sent:** the task title (clipped to 160 characters), `blockedBy`
  (clipped to 300) and description (clipped to 440), redacted before clipping.

Each site is bounded at 300 ms from its own start, module load included. On
timeout, provider error, budget denial or an unconfigured provider, the
heuristic answers. `resolveDecisionSiteSettings` now accepts sites without a
generative tier (`llmTierKey` is optional).
