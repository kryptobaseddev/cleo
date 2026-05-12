## Phase 3 — Chairman's Verdict

### Gate summary
| Advisor | G1 Rigor | G2 Evidence | G3 Frame | G4 Actionability | Weight |
|---|---|---|---|---|---|
| Contrarian | PASS | PASS | PASS | PASS | full |
| First Principles | PASS | PASS | PASS | PASS | full |
| Expansionist | PASS | PASS | PASS | PASS | full |
| Outsider | PASS | PASS | PASS | PASS | full |
| Executor | PASS | PASS | PASS | PASS | full |

### Recommendation
Do not proceed with a CANT-only `RoutingConfig` refactor as the architecture. Proceed with `RoutingConfig` only as the required routing-policy input after defining a shared provider/model contract that separates catalog facts, routing policy, invocation transport, and agent harness provider identity.

### Why this, not the alternatives
The narrow plan removes two hardcoded matrices, but leaves CLEO able to emit catalog-valid and invocation-invalid model strings. The repo already has multiple provider/model surfaces: CANT tier strings, `ModelConfig`, LLM backends, adapter manifests, CAAMP provider metadata, Ollama probing, and `models.dev` lookup. Treating all of these as one generic "provider" namespace would create new ambiguity instead of removing hardcoding. The durable path is to make CANT the first consumer of a CLEO-wide model catalog/policy layer, while keeping the Rust router pure and config-fed.

### What each advisor got right
- **Contrarian's fatal flaw to mitigate:** A dynamic config can still fail if the selected model is catalog-valid but not invokable by CLEO's current transport, credentials, base URL, and fallback machinery.
- **First Principles' atomic truth worth protecting:** External model facts and local routing policy are different kinds of truth.
- **Expansionist's upside to pursue:** The existing registries and discovery paths are enough to seed a reusable model supply control plane.
- **Outsider's pattern flag:** The codebase already contains several partial provider/model catalogs, so adding a new CANT-local surface would deepen fragmentation.
- **Executor's action:** Produce a provider/model surface map before changing router APIs.

### Conditions on the recommendation
The first implementation PR should be accepted only if it names the package boundary and shared vocabulary first: catalog provider, invocation transport, model reference, routing policy, agent harness provider, credentials, base URL, capabilities, pricing, context window, and freshness timestamp. `RoutingConfig` should reference provider-qualified model refs, not bare strings.

### Next 60-minute action
Use `/tmp/council-router-provider-audit-20260426/provider-model-surface-map.md` as the working checklist and turn it into an implementation design note that assigns each concept to `packages/contracts`, `packages/core`, `crates/cant-router`, `packages/cant`, or `packages/adapters` before any signature refactor starts.

### Confidence
High — all five advisor outputs passed 4/4 gates, the convergence detector did not require reruns, and the cited code surfaces independently support the same architectural boundary.

### Open questions for the owner
- Should Vercel AI Gateway be a first-class catalog/invocation provider, or only an invocation bridge through the existing Vercel AI SDK usage?
- Should OpenRouter be treated as a catalog source only, or as both catalog source and OpenAI-compatible invocation provider?
- Should the first PR include `crates/cant-napi`, or is breaking the NAPI route wrapper acceptable for a staged follow-up?

