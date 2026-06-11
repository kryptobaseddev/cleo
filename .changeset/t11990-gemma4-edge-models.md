---
id: t11990-gemma4-edge-models
tasks: [T11990]
kind: fix
summary: "fix(T11990): gemma3→gemma4 edge-model family in ollama fallback + fit table (live-verified)"
---

Corrects stale gemma3 model literals to the current gemma4 family (owner-flagged 2026-06-11).

- **`packages/core/src/llm/provider-registry/builtin/ollama.ts`** — `defaultModel` updated `gemma3:4b` → `gemma4:e4b` (≥8 GB RAM tier); `defaultAuxModel` updated `gemma3:1b` → `gemma4:e2b` (≥4 GB RAM tier). Tags live-verified on ollama.com/library/gemma4 2026-06-11.
- **`packages/core/src/llm/local-model-fit.ts`** — `LOCAL_MODEL_CANDIDATES` table updated: three gemma3 entries replaced with `gemma4:e2b` (7.2 GB, 128k ctx), `gemma4:e4b` (9.6 GB, 128k ctx), `gemma4:12b` (7.6 GB QAT, 256k ctx); RAM/VRAM rows recalibrated from live Ollama tag data; `family` union updated `'gemma3'` → `'gemma4'`.
- **`packages/core/src/llm/cross-provider-selector.ts`** — `ollamaDefaultModelForTier` literals updated `gemma3:4b` → `gemma4:e4b`, `gemma3:1b` → `gemma4:e2b`; catalog hint log updated to check gemma4 family; inline fallback literal in `selectBestProvisioned` updated.
- **Tests** — RAM-gate + fit-ranking expectations in `__tests__/cross-provider-selector.test.ts` and `__tests__/local-model-fit.test.ts` updated to gemma4 tags.
- **RECOMMEND-NEVER-KILL semantics preserved**: local models remain recommended only; no auto-pull, no forced selection; <4 GB floor still routes to cloud-only with reason; fit envelope remains agent-readable.
