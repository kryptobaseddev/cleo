### Advisor: First Principles

**Frame:** Ignore everything that was said. What is actually true here? Break this down to first principles and answer from zero.

**Evidence anchored:**
- `https://openrouter.ai/docs/guides/overview/models` + `https://vercel.com/docs/ai-gateway/models-and-providers` + `https://docs.ollama.com/api/tags` via phase0 item 7 — current model ecosystems expose provider/model metadata as catalog data, which is atomic because routing cannot choose unavailable or mispriced resources.
- `crates/cant-router/src/router.rs:L14-L98` via phase0 item 1 — the Rust router currently embeds concrete model IDs, fallback order, cost caps, and latency budgets in code; overlay evidence for the proposed change.
- `packages/cant/src/composer.ts:L225-L364` via phase0 item 2 — TypeScript spawn composition independently mirrors tier-to-model constants and emits string-only model selections; overlay evidence for duplication.
- `packages/contracts/src/operations/llm.ts:L12-L59` + `packages/core/src/llm/registry.ts:L29-L170` via phase0 item 3 — CLEO already separates invocation configuration from callers, but provider transport identity is narrower than the provider/model universe; overlay evidence for existing constraints.
- `packages/core/src/memory/llm-backend-resolver.ts:L58-L196` + `packages/core/src/metrics/model-provider-registry.ts:L1-L110` via phase0 item 6 — CLEO already has local and remote catalog-adjacent discovery logic; overlay evidence that catalog behavior is not new to the system.

**Atomic truths (independent of the artifact):**
1. Model availability, model IDs, pricing, context windows, and provider capabilities are time-varying facts owned by external providers, not stable facts owned by application source code.
2. A router can only make a correct selection if it has both policy and facts: policy says what the user wants to optimize or cap, while facts say which provider/model candidates exist and what constraints they satisfy.
3. A configuration file is policy input, not a discovery source; it can name preferences and budgets, but it cannot by itself keep model metadata current.
4. Provider invocation and model discovery are separate contracts: one turns a selected model reference into a call, while the other describes the selectable universe.
5. A fallback chain is correct only if each fallback is capability-compatible with the primary request constraints, not merely cheaper, faster, or listed in the same tier.
6. Local/offline providers and hosted aggregators have different freshness and trust boundaries, so a correct design needs a normalized catalog interface plus source-specific adapters rather than one privileged provider API.

**Reconstructed solution (from atoms, before reading the plan):**
The simplest correct design is a shared provider/model catalog contract that yields normalized model facts from one or more sources, plus an explicit routing policy that references models by provider-qualified identity and declares tier budgets, preferences, and fallback rules. Routing should consume a validated policy against a catalog snapshot and return a structured selection containing provider, model, cost/latency constraints, and fallback candidates. Invocation code should receive that structured selection and use the existing provider transport layer or an adapter bridge to execute it. No component should contain default model IDs as source constants; tests should pass fixture catalogs and fixture policies.

**Reconstruction vs. the proposed plan:**
- Convergences: The proposed required `RoutingConfig` removes the false idea that the router owns the tier matrix, and it correctly forces Rust and TypeScript call sites to receive policy explicitly instead of consulting embedded defaults.
- Divergences, each classified:
  - Required `RoutingConfig` as the main abstraction leaves model facts out of the contract; it externalizes hardcoded IDs but does not define how provider/model availability, pricing, context, and capability facts are represented or refreshed — (genuine error).
  - A `RoutingConfig` shape of per-tier `{ provider, primary, fallbacks, cost_cap_usd, latency_budget_ms }` treats fallbacks as static policy strings instead of validated model references against a catalog snapshot — (genuine error).
  - Designing Rust and TypeScript mirrors first, without placing shared provider/model identity in `packages/contracts/src/`, risks creating two more locally typed catalog shapes after removing two local matrices — (path-dependent cruft).
  - Reusing existing invocation and adapter registries is necessary, but treating agent harness adapters, LLM transports, and model catalogs as one "provider" concept would collapse three different contracts into one overloaded name — (genuine error).
  - Loading routing policy from `.cleo/config.json` and allowing `--routing-config <path>` are implementation details that fit the reconstruction once the catalog contract exists — (justified by real constraint).

**Verdict from this lens:** The plan should not proceed as "required `RoutingConfig` only." The correct first move is to define the shared provider/model catalog architecture and normalized model reference contract, then make `RoutingConfig` the required policy layer that is validated against that catalog. The router must be configuration-driven, but configuration alone is not enough to solve the actual problem of time-varying providers and models.

**Single sharpest point:** The real problem is external model facts versus routing policy, not simply moving hardcoded model strings from code into a required config.
