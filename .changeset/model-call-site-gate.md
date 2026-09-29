---
id: model-call-site-gate
tasks: [T12663]
kind: feature
summary: Arch gate 35 fails CI on an unregistered model call site, a System One site running on without go-live evidence, or a new chokepoint bypass
---

This is phase 2 of the System One integration (spec
`system-one-integration` §3.5, D11158). `scripts/lint-model-call-sites.mjs`
reads the decision-site registry from source and checks six rules:

1. `unregistered-decide-site`: a `decide()` or `askSiteDecision` call must
   name a registered site id.
2. `unregistered-model-site`: a file that calls an LLM entry point
   (`resolveLLMForSystem`, `resolveLLMForRole`, `executeForRole`,
   `getLlmExecutor` or the AI-SDK generate/stream calls) must be listed in the
   registry.
3. `registry-file-missing`: every file a registry row lists must exist.
4. `on-without-evidence`: a System One site may run `on` only with go-live
   evidence. The `cli.decide-ask` debug verb is exempt.
5. `rung-mismatch`: a file registered only for System One must not call a
   generative entry point.
6. `chokepoint-bypass`: direct AI-SDK calls, raw `messages.create`, AI-SDK
   provider factories and raw provider endpoints outside the chokepoint are
   reported. The known bypasses are baselined, not allowed: the count may fall
   but never rise.

Counts are baselined per rule and per file, so a new offending file fails even
when another one was fixed. The gate is bundled into `cleo check arch`,
documented as AGENTS.md row 35 and run by the Arch Boundary Check workflow.
The Kimi, Claude and OpenAI harness SDK adapters are registered as agent-rung
sites.
