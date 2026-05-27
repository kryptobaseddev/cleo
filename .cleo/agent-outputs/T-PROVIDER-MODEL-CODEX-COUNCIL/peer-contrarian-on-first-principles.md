### Contrarian reviewing First Principles

**Gate results:**
- G1 Rigor: PASS — Strongest finding: "Required `RoutingConfig` as the main abstraction leaves model facts out of the contract; it externalizes hardcoded IDs but does not define how provider/model availability, pricing, context, and capability facts are represented or refreshed — (genuine error)." The output lists six atomic truths and classifies concrete divergences rather than vague concerns.
- G2 Evidence grounding: PASS — Cited shared evidence items 1, 2, 3, 6, and 7; each cited item exists in `/tmp/council-router-provider-audit-20260426/phase0.md` and supports the finding about hardcoded routing, string-only TS payloads, existing invocation config, existing catalog-adjacent logic, and external model metadata sources.
- G3 Frame integrity: PASS — First Principles stayed in its lane by separating atomic truths from overlay evidence; the line "A configuration file is policy input, not a discovery source" is a correctness claim against an independent constraint, not a runtime failure mode or artifact-only observation.
- G4 Actionability: PASS — Actionable verdict: "define the shared provider/model catalog architecture and normalized model reference contract, then make `RoutingConfig` the required policy layer that is validated against that catalog."

**Strongest finding (from reviewee):**
The real problem is external model facts versus routing policy, not simply moving hardcoded model strings from code into a required config.

**Gap from Contrarian's frame:**
First Principles names the correctness split, but it underplays the first production break: a catalog-valid `provider/model` in config will still fail when the invocation layer only understands `ModelTransport = 'anthropic' | 'openai' | 'gemini'` and cannot map aggregator/local/provider-specific auth, base URLs, request parameters, or fallback semantics consistently.

**What I would add:**
This fails when a refreshed catalog selects an available OpenRouter, Ollama, or Vercel Gateway model whose provider-qualified identity cannot be executed by the existing transport registry, producing either dispatch errors or silent fallback to the wrong backend.

**Disposition:** Accept — The review cleanly distinguishes model facts from routing policy and gives the implementation owner a concrete architectural prerequisite before changing router APIs.
