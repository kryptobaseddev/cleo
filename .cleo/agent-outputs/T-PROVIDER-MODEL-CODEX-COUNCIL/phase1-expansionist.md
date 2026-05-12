### Advisor: Expansionist

**Frame:** Forget the constraints. What's the biggest version of this? What opportunity is sitting right in front of us that nobody is talking about?

**Evidence anchored:**
- `packages/contracts/src/operations/llm.ts:L12-L59` + `packages/core/src/llm/registry.ts:L29-L170` — contains a latent invocation contract: `ModelConfig` already carries transport, model, base URL override, and fallback shape, so routing can become one consumer of a CLEO-wide model identity layer instead of owning model strings locally.
- `packages/adapters/src/registry.ts:L49-L87` + `packages/adapters/src/index.ts:L33-L101` + `packages/caamp/providers/registry.json:L1-L523` — contains a latent provider capability graph: adapter discovery and CAAMP provider metadata already describe who can run agents, hooks, MCP, and spawn flows, which could be joined with model catalogs.
- `packages/core/src/memory/llm-backend-resolver.ts:L58-L196` + `packages/core/src/metrics/model-provider-registry.ts:L1-L110` — contains working catalog seeds: Ollama `/api/tags` discovery, OpenAI-compatible local invocation, and `models.dev/api.json` lookup are already dynamic model/provider knowledge inside CLEO.
- `https://openrouter.ai/docs/guides/overview/models` + `https://vercel.com/docs/ai-gateway/models-and-providers` + `https://docs.ollama.com/api/tags` — external catalogs expose pricing, context, capability, availability, and local installed-model data that can make model choice adaptive rather than static.

**Findings (opportunities, from my frame only):**
1. **Model supply control plane** — captures a CLEO-wide source of truth for model identity, provider capability, pricing, context window, local availability, and invocation compatibility. Asymmetry: one shared catalog shape : every router, composer, adapter, metrics view, and future daemon stops solving provider/model knowledge separately.
2. **Provider capability marketplace** — captures the value already hiding in CAAMP and adapter manifests by making provider choice more than LLM vendor selection: CLEO could match work to providers by spawn, MCP, hooks, local/cloud execution, and model capability in the same registry. Asymmetry: join existing manifest metadata with catalog metadata : routing becomes provider-aware orchestration instead of tier-to-string lookup.
3. **Telemetry-fed routing intelligence** — captures the second-order asset created once routing decisions flow through structured `ModelRef`/catalog records: outcomes, cost, latency, fallback hits, and model availability can train policy without changing caller APIs. Asymmetry: add stable decision metadata now : future policy tuning becomes data updates instead of code edits.

**Verdict from this lens:** A required `RoutingConfig` is useful, but it is too small as the center of gravity. The bigger version is a shared provider/model catalog architecture where CANT routing is the first high-value consumer, not the owner of model truth.

**Single sharpest point:** Treat CANT routing as the first consumer of a CLEO-wide model supply control plane, because the existing LLM registry, adapter manifests, CAAMP provider registry, Ollama discovery, and models.dev lookup are already 80% of a reusable provider/model intelligence layer.
