### Advisor: Executor

**Frame:** Don't analyze. Don't debate. What is the single most important action to take right now? Give me one step I can start in the next hour.

**Evidence anchored:**
- `crates/cant-router/src/router.rs:L34-L56` — the Rust router still chooses concrete model IDs, fallback chains, cost caps, and latency budgets from a tier match arm.
- `packages/cant/src/composer.ts:L229-L234,L349-L359` — the TypeScript composer mirrors tier-to-model constants and emits string model/fallback fields into the spawn payload.
- `packages/core/src/llm/registry.ts:L117-L170` — CLEO already has a typed runtime backend factory keyed by `ModelConfig`, so routing policy must account for existing invocation wiring before adding another abstraction.
- `packages/core/src/memory/llm-backend-resolver.ts:L158-L196` + `packages/core/src/metrics/model-provider-registry.ts:L1-L110` — dynamic model discovery patterns already exist for Ollama and `models.dev`, proving the catalog problem is not isolated to CANT.

**The action (one):**
Create `/tmp/council-router-provider-audit-20260426/provider-model-surface-map.md` with one table covering these verified surfaces: `crates/cant-router/src/router.rs`, `packages/cant/src/composer.ts`, `packages/contracts/src/operations/llm.ts`, `packages/core/src/llm/registry.ts`, `packages/adapters/src/registry.ts`, `packages/caamp/providers/registry.json`, `packages/adapters/src/providers/openai-sdk/spawn.ts`, `packages/adapters/src/providers/openai-sdk/handoff.ts`, `packages/adapters/src/providers/claude-sdk/spawn.ts`, `packages/core/src/memory/llm-backend-resolver.ts`, and `packages/core/src/metrics/model-provider-registry.ts`; columns must be `surface`, `package`, `current provider/model source`, `hardcoded values`, `dynamic discovery already present`, and `routing/catalog implication`.

**Expected outcome (60 minutes from now):**
`/tmp/council-router-provider-audit-20260426/provider-model-surface-map.md` exists and has one completed row for every named surface, with each row classified as routing policy, invocation transport, agent adapter, provider manifest, or catalog lookup.

**What this unblocks:**
The team can decide the package boundary and shared contract shape for provider/model catalogs before changing `route()` or `composeSpawnPayload()` signatures.

**Verdict from this lens:** Start with the catalog audit artifact, not the signature refactor. The next executable step is to make the existing provider/model surfaces visible enough that the required `RoutingConfig` design cannot duplicate or bypass them.

**Single sharpest point:** Create `/tmp/council-router-provider-audit-20260426/provider-model-surface-map.md` as a one-hour provider/model surface map before touching router APIs.
