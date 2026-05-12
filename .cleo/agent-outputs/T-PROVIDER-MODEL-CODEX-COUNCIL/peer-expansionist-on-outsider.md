### Expansionist reviewing Outsider

**Gate results:**
- G1 Rigor: PASS — Strongest finding names the subject and predicate directly: "The artifact does not show one routing problem; it shows several disconnected model/provider vocabularies," then enumerates CANT strings, `ModelConfig.transport`, adapter manifests, CAAMP provider capability metadata, and metrics/memory lookup paths.
- G2 Evidence grounding: PASS — Findings cite shared evidence items 1 (`crates/cant-router/src/router.rs:L14-L98`), 2 (`packages/cant/src/composer.ts:L225-L364`), 3 (`packages/contracts/src/operations/llm.ts:L12-L59` + `packages/core/src/llm/registry.ts:L29-L170`), 4 (`packages/adapters/src/registry.ts:L49-L87` + `packages/adapters/src/index.ts:L33-L101` + `packages/caamp/providers/registry.json:L1-L523`), 5 (`packages/adapters/src/providers/openai-sdk/spawn.ts` + `handoff.ts` + `claude-sdk/spawn.ts`), and 6 (`packages/core/src/memory/llm-backend-resolver.ts:L58-L196` + `packages/core/src/metrics/model-provider-registry.ts:L1-L110`).
- G3 Frame integrity: PASS — Outsider stays in its claim/reality-gap lane: "from the files alone," "the artifacts still show," and "the visible codebase" are artifact-bound observations, with no prescribed fix and no appeal to external provider truths.
- G4 Actionability: PASS — The verdict gives a concrete line of inquiry: "unless it is reconciled with the existing contracts, adapter registries, and discovery-adjacent lookup code" and asks which "existing provider/model surface is authoritative."

**Strongest finding (from reviewee):**
The Outsider's sharpest observation is that the repo already contains multiple partial provider/model catalogs, so the surprising fact is not only CANT's hardcoded matrix, but the absence of an explicitly authoritative provider/model surface.

**Gap from Expansionist's frame:**
Outsider correctly spots fragmentation, but leaves the upside under-named: those partial catalogs are not just inconsistent surfaces; they are latent pieces of a CLEO-wide model supply control plane that could make CANT routing, memory backend selection, SDK spawning, metrics attribution, and local/offline model selection share one asset.

**What I would add:**
Treat CANT as the first consumer of a shared model catalog/policy plane, because the evidence already shows enough scattered metadata to turn a cleanup into reusable routing leverage across the system.

**Disposition:** Accept — The review is artifact-grounded and cleanly within Outsider's frame, with the Expansionist addition being upside amplification rather than a correction.
