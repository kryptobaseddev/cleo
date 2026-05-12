### Advisor: Outsider

**Frame:** You have no context. Ignore all backstory. Look only at what's in front of you. Tell me what a complete stranger would conclude.

**Evidence anchored:**
- `crates/cant-router/src/router.rs:L1-L20,L34-L56,L75-L98` - The module says the tier matrix is a Rust constant for v1, `route` takes only a `Classification`, and the match arm maps tiers directly to fixed model IDs, fallbacks, cost caps, and latency budgets before downgrade re-enters `route`.
- `packages/cant/src/composer.ts:L225-L234,L267-L271,L349-L359` - The TypeScript composer has its own `TIER_MODELS` constant, `composeSpawnPayload` takes no routing config argument, and the returned payload exposes only string model IDs and fallback strings.
- `packages/contracts/src/operations/llm.ts:L12-L58` + `packages/core/src/llm/registry.ts:L29-L170` - The existing LLM layer already has `ModelConfig` with transport, model, base URL, API key, provider params, and fallback config, plus a backend factory, but the transport type is limited to `anthropic | openai | gemini`.
- `packages/adapters/src/registry.ts:L49-L87` + `packages/adapters/src/index.ts:L4-L13,L33-L102` + `packages/caamp/providers/registry.json:L1-L79,L82-L1669` - The adapter package describes itself as the single entry point for CLEO provider adapters, yet one registry hardcodes four bundled provider IDs while the public index and CAAMP registry expose a much broader provider surface.
- `packages/core/src/memory/llm-backend-resolver.ts:L58-L80,L151-L196` + `packages/core/src/metrics/model-provider-registry.ts:L1-L110` - The repo already contains catalog-adjacent behavior: Ollama `/api/tags` discovery, OpenAI-compatible Ollama model construction, and `models.dev/api.json` provider/model lookup.

**Findings (from a stranger's eyes only):**
1. The artifact does not show one routing problem; it shows several disconnected model/provider vocabularies. CANT has Rust `primary_model` and TS `model` strings, contracts have `ModelConfig.transport` and `fallback`, adapters have provider manifests, CAAMP has provider capability metadata, and metrics/memory code already performs model-provider lookup and local model discovery.
2. The stated "single entry point" language in `packages/adapters/src/index.ts:L4-L13` is visibly narrower than the repository reality. The adapter registry's bundled `PROVIDER_IDS` list is `claude-code`, `opencode`, `cursor`, and `pi`, while the same package index exports Claude SDK, Codex, Gemini CLI, Kimi, and OpenCode, and the CAAMP registry lists many more provider IDs.
3. A required `RoutingConfig` at the CANT router/composer boundary would remove the two CANT hardcoded matrices, but the artifacts still show model defaults elsewhere: OpenAI SDK spawn constants, OpenAI worker archetype models, Claude SDK default model, Ollama priority models, and a cold-tier model constant. From the files alone, "no hardcoded model IDs" is broader than the two CANT files.

**What the artifact claims vs. shows:**
The proposed change claims to externalize CANT routing by requiring config, and the cited CANT files do show exactly the hardcoded matrices that would be externalized. The wider repository shows that provider/model knowledge already exists in multiple places outside CANT, so a CANT-only config boundary would align two files while leaving the larger provider/model story fragmented.

**Verdict from this lens:** A thoughtful stranger would not read this as a choice between "hardcoded matrix" and "required config" only. The visible codebase already has enough provider/model infrastructure that a new CANT-local config type looks like one more surface unless it is reconciled with the existing contracts, adapter registries, and discovery-adjacent lookup code.

**Single sharpest point:** The artifact already contains several partial provider/model catalogs, so the surprising thing is not that CANT hardcodes models, but that CANT is proposing another routing surface without first naming which existing provider/model surface is authoritative.
