---
id: decide-site-registry
tasks: [T12662]
kind: feat
summary: A typed decision-site registry and `cleo decide sites` list every place CLEO makes a judgement, with its rung, ladder, fallback, owner escalation and mode
---

This is phase 1 of the System One integration (spec `system-one-integration`
§3, D11158/D11159). It adds no behaviour change.

The contracts live in `packages/contracts/src/decide-sites.ts`:
`DecisionSiteDefinition`, the rungs `rule`, `system-one`, `generative`,
`agent` and `owner`, the modes, go-live evidence and the listing result.

The registry is `packages/core/src/decide/sites/registry.ts`. Each row gives
a site's primary rung, escalation ladder, fallback, confidence floors,
owner-escalation rule, mode key, default mode, write-path flag, the text
classes it sends, go-live evidence and owning task. It holds:

- the four System One sites: `tasks.duplicate-detection`,
  `memory.decision-contradiction`, `memory.observation-type` and
  `orchestration.owner-decision`;
- the `cli.decide-ask` debug verb;
- the generative and agent-rung callers that predate the ladder.

The four sites now take their id and `decide.*` config keys from the
registry. The old constants (`DUPLICATE_DECISION_SITE` …) are re-exported
with unchanged values. The audit ids and config keys are the same as before.

`cleo decide sites [--rung r] [--mode m] [--id s] [--evidence]` lists each
site with:

- its registry default mode, configured mode and effective mode — `off` for
  a System One site while no provider is configured;
- its go-live evidence;
- its last-seven-day audit activity: asked, provider, cache, fallback,
  escalated and agreement.
