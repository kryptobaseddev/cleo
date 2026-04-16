# T752 Research: Gemma 4 E4B-it vs E2B + Claude Agent SDK OAuth Audit

> **Task**: T752 — RESEARCH: Gemma 4 E2B vs E4B-it model choice + Claude Agent SDK OAuth audit
> **Date**: 2026-04-15
> **Author**: Research Agent (Lead dispatch)
> **Status**: COMPLETE
> **Sources**: ai.google.dev/gemma/docs/core (fetched 2026-04-15, last updated 2026-04-02 UTC),
>   huggingface.co/google/gemma-4-E4B-it, aiexplorer-blog.vercel.app/post/gemma-4-e4b-enterprise-benchmark,
>   docs.vllm.ai/projects/recipes/en/latest/Google/Gemma4.html, wavespeed.ai/blog/posts/what-is-google-gemma-4/

---

## §1 Gemma 4 E2B vs E4B-it — Recommendation

### §1.1 Authoritative Specs (ai.google.dev/gemma/docs/core, 2026-04-02)

| Property | E2B | E4B / E4B-it |
|----------|-----|--------------|
| Effective parameters | 2.3B active / 5.1B total | 4.5B active / 8B total |
| Architecture | Dense + Per-Layer Embeddings (PLE) | Dense + Per-Layer Embeddings (PLE) |
| Context window | 128K tokens | 128K tokens |
| Modalities | Text, image, audio | Text, image, audio |
| Q4_0 VRAM (inference) | **3.2 GB** | **5 GB** |
| BF16 VRAM | 9.6 GB | 15 GB |
| Release date | 2026-04-02 | 2026-04-02 |
| Instruction-tuned variant | gemma-4-e2b-it | **gemma-4-e4b-it** |
| Thinking mode | Supported (enable_thinking=True) | Supported (enable_thinking=True) |
| Function calling | Native | Native |
| Structured JSON output | Supported | Supported, higher compliance |
| Ollama tag | `gemma4:e2b` | `gemma4:e4b-it` |

The "E" stands for "effective" — both models use Per-Layer Embeddings so the total weights
(5.1B / 8B) are larger than the active compute footprint (2.3B / 4.5B). At Q4_0 the
actual VRAM delta is 1.8 GB (3.2 GB vs 5.0 GB), not 0.4 GB as the Ollama pull sizes suggest.

### §1.2 Structured Output Benchmark (enterprise benchmark, aiexplorer-blog, 2026)

For structured JSON extraction (the primary CLEO use case):

| Metric | E4B-it |
|--------|--------|
| JSON parse success | 100% |
| Schema compliance (overall) | 90% |
| Simple/medium schema compliance | 100% |
| Complex nested schema compliance | 50% |
| Hallucinated fields | Near zero |
| Generation latency (per response) | ~16.8s |

Known E4B-it quirks to handle in implementation:
- Double-comma degeneration at temperature=0: apply `repetition_penalty=1.15`
- vLLM: schema field descriptions are not visible to the model — must put output
  instructions in the system prompt AND use `response_format` for structural enforcement

### §1.3 Instruction-Following Delta

The `-it` suffix marks the post-trained (SFT + RLHF) instruction-tuned variant. Base models
(e.g. `gemma-4-e2b`, without `-it`) are pre-trained only — they require prompt engineering to
follow instructions reliably and produce chat-format output. For a pipeline that passes a
Zod schema description in the system prompt and expects structured JSON back, the base model
will frequently produce free-form completions instead.

**E4B-it vs E2B (base)**: Two independent dimensions are at stake:
1. Parameter count (4.5B vs 2.3B active): more capacity for complex schema reasoning
2. Instruction tuning: `-it` models follow system prompts and output format constraints;
   base models do not

### §1.4 RECOMMENDATION: Use `gemma4:e4b-it`

**Recommended model**: `gemma4:e4b-it` (gemma-4-e4b-it, Q4 ~5 GB VRAM)

**Rationale**:

1. **Instruction following is non-negotiable for the CLEO use case.** The extraction pipeline
   passes a Zod schema description in the system prompt and expects a JSON object back. A base
   model (`e2b`, no `-it`) will not reliably comply with this instruction — it generates
   continuations, not structured responses. The `-it` suffix is a hard requirement, not a
   preference.

2. **E2B-base is what is currently in the OLLAMA_MODEL_PRIORITY list as `gemma4:e2b`.** This
   is almost certainly the wrong tag. The correct warm-tier tag should be `gemma4:e2b-it` at
   minimum, but given the schema compliance numbers above, E4B-it is preferred.

3. **Schema compliance**: E4B-it achieves 90% schema compliance vs the base E2B which has no
   published compliance figure (and is not instruction-tuned). For a Zod-validated extraction
   pipeline that re-prompts on failure (T736 `verifyAndStore` gate), 90% compliance means
   ~1 re-prompt per 10 extractions — acceptable. E2B-base would fail much more frequently.

4. **VRAM cost is manageable**: 5 GB Q4 fits on any system with ≥6 GB VRAM (GTX 1060,
   RTX 2060, M1/M2 Mac). The 1.8 GB delta over E2B is a fair trade for the instruction-
   following and schema compliance gains.

5. **Latency**: 16.8s per structured response is acceptable for a background extraction
   pipeline running at session end (non-interactive). The pipeline is not latency-sensitive.

**If the user's hardware cannot fit 5 GB** (e.g. Raspberry Pi Zero): fall back to
`gemma4:e2b-it` (instruction-tuned 2B). Do NOT use `gemma4:e2b` (base).

**Current spec bug**: `docs/specs/memory-architecture-spec.md` §7.1 and
`llm-backend-resolver.ts` OLLAMA_MODEL_PRIORITY both reference `gemma4:e2b` (base).
These must be updated to `gemma4:e4b-it` as primary (see §4).

---

## §2 Claude Agent SDK OAuth — Current State in Codebase

### §2.1 What T581 Built

`packages/adapters/src/providers/claude-sdk/` — fully implemented `ClaudeSDKSpawnProvider`:

- `spawn.ts` — `ClaudeSDKSpawnProvider` implementing `AdapterSpawnProvider`
- `index.ts` — re-exports the provider
- `__tests__/spawn.test.ts` — unit tests with mocked SDK
- Uses `@anthropic-ai/claude-agent-sdk` with `query()` streaming API
- Session tracking via `SessionStore`, MCP server wiring, CANT enrichment

### §2.2 Critical Gap: canSpawn() Only Checks ANTHROPIC_API_KEY

```ts
// packages/adapters/src/providers/claude-sdk/spawn.ts:56-58
async canSpawn(): Promise<boolean> {
  return !!process.env.ANTHROPIC_API_KEY;
}
```

This misses the OAuth path entirely. The codebase already has a complete 3-tier key resolver
in `packages/core/src/memory/anthropic-key-resolver.ts`:

```
Priority 1: ANTHROPIC_API_KEY env var
Priority 2: ~/.local/share/cleo/anthropic-key (user-stored via cleo config)
Priority 3: ~/.claude/.credentials.json → claudeAiOauth.accessToken (Claude Code OAuth — FREE)
```

`resolveAnthropicApiKey()` is already used by every memory pipeline module:
- `llm-backend-resolver.ts:245` (`tryAnthropic`)
- `llm-extraction.ts:308`
- `observer-reflector.ts:241,575,709`
- `sleep-consolidation.ts:199`

But `ClaudeSDKSpawnProvider.canSpawn()` bypasses it and checks only the raw env var.

### §2.3 OAuth Token Mechanics (from credentials file)

The resolver reads `~/.claude/.credentials.json`:
```json
{
  "claudeAiOauth": {
    "accessToken": "<token>",
    "expiresAt": <unix-ms>
  }
}
```

This token is the same credential used by the Claude Code CLI itself. When a user is logged
in to Claude Code (via `claude login`), this file exists and the token is valid — no
`ANTHROPIC_API_KEY` required. The resolver correctly checks expiry before returning the token.

The Anthropic SDK/Claude Agent SDK accept this token on the `Authorization: Bearer` header
just like an API key, so no code changes are needed in the SDK call path — only in the
`canSpawn()` availability check.

### §2.4 Cold-Tier Transcript Extraction vs SDK Spawn

These are two different code paths:
- **ClaudeSDKSpawnProvider** (`packages/adapters`): spawns full Claude Code subagents
- **cold-tier transcript extraction** (`packages/core/src/memory/llm-backend-resolver.ts`):
  calls Claude Sonnet via `@ai-sdk/anthropic` + `generateObject()` for structured extraction

Both paths should use `resolveAnthropicApiKey()` — and the extraction path already does.
The spawn provider is the only path that currently bypasses it.

For cold-tier transcript extraction, the question is: **should it route through the Claude
Agent SDK instead of direct `@ai-sdk/anthropic`?**

Answer: **No.** The Agent SDK is for spawning full Claude Code agents (subagents that execute
tasks with tool use). Transcript extraction is a simple `generateObject()` call — it needs
only a language model API call, not a full agent with tools. Using the Agent SDK for this
would be over-engineered and would bypass the clean fallback chain in `llm-backend-resolver.ts`.

The correct path for cold-tier extraction is:
`resolveAnthropicApiKey()` (which already picks up OAuth) → `@ai-sdk/anthropic` → `generateObject()`

This path is already wired correctly. The spec wording is the only thing that needs updating.

---

## §3 Recommended Cold-Tier Routing

```
cold-tier extraction routing:
  1. resolveAnthropicApiKey()
     ├── ANTHROPIC_API_KEY env var (explicit)
     ├── ~/.local/share/cleo/anthropic-key (user-stored)
     └── ~/.claude/.credentials.json → claudeAiOauth.accessToken (Claude Code OAuth, FREE)
  2. If token found → @ai-sdk/anthropic + generateObject() with claude-sonnet-4-6
  3. If no token → skip extraction (null backend)
```

This is already implemented in `llm-backend-resolver.ts:tryAnthropic()`. No new code needed.

**The "Claude Agent SDK w/ user OAuth" framing in the original question is a terminology
ambiguity.** The `resolveAnthropicApiKey()` function already returns the OAuth token from
`~/.claude/.credentials.json` when available. The cold-tier extraction path already calls
this function. So the OAuth token IS already used for cold-tier extraction — it just is not
labeled as "Agent SDK" anywhere in the code.

What IS missing: `ClaudeSDKSpawnProvider.canSpawn()` should also use `resolveAnthropicApiKey()`
so that agent spawning works when the user is logged in to Claude Code but has no explicit
`ANTHROPIC_API_KEY` set.

---

## §4 Spec Patches Required

### §4.1 Patch: memory-architecture-spec.md §7.1

**File**: `/mnt/projects/cleocode/docs/specs/memory-architecture-spec.md`

Current §7.1 table:
```
| Warm (local model available) | Ollama + Gemma 4 E2B | Auto-installed via ... |
```

Replace `Gemma 4 E2B` with `Gemma 4 E4B-it`:
```
| Warm (local model available) | Ollama + Gemma 4 E4B-it | Auto-installed via ... |
```

Update the config block:
```json
{
  "brain": {
    "llmExtraction": {
      "warmModel": "ollama:gemma-4-e4b-it",
      "coldModel": "claude-sonnet-4-6",
      "requireApiKey": false
    }
  }
}
```

Add a note under §7.1:
```
> **Key auth note**: `requireApiKey: false` is correct. `tryAnthropic()` calls
> `resolveAnthropicApiKey()` which auto-discovers the Claude Code OAuth token from
> `~/.claude/.credentials.json` — no explicit API key required for users logged in
> to Claude Code. The cold-tier path is zero-config for Claude Code users.
```

### §4.2 Patch: llm-backend-resolver.ts OLLAMA_MODEL_PRIORITY

**File**: `/mnt/projects/cleocode/packages/core/src/memory/llm-backend-resolver.ts`

Current:
```ts
const OLLAMA_MODEL_PRIORITY = [
  'gemma4:e2b',
  'gemma4:e4b',
  ...
] as const;
```

Patch to:
```ts
const OLLAMA_MODEL_PRIORITY = [
  'gemma4:e4b-it',   // PRIMARY: instruction-tuned 4B — 90% schema compliance
  'gemma4:e2b-it',   // FALLBACK: instruction-tuned 2B — fits 3.2GB VRAM
  'gemma4:e2b',      // LAST RESORT base: no instruction tuning, expect re-prompts
  'phi4-mini',
  'llama3.2:3b',
  'llama3.2',
] as const;
```

### §4.3 Patch: ClaudeSDKSpawnProvider.canSpawn()

**File**: `/mnt/projects/cleocode/packages/adapters/src/providers/claude-sdk/spawn.ts`

Current:
```ts
async canSpawn(): Promise<boolean> {
  return !!process.env.ANTHROPIC_API_KEY;
}
```

Patch to use `resolveAnthropicApiKey()` so the SDK spawn provider works with Claude Code
OAuth (free tier) in addition to explicit API keys:
```ts
async canSpawn(): Promise<boolean> {
  const { resolveAnthropicApiKey } = await import('@cleocode/core/memory/anthropic-key-resolver.js');
  return !!resolveAnthropicApiKey();
}
```

> **Note**: verify the exact import path for cross-package import. The `@cleocode/core`
> package must be listed in `packages/adapters/package.json` dependencies — confirm before
> shipping. If circular dependency risk exists, duplicate the 3-tier resolver inline or
> extract it to `@cleocode/contracts`.

---

## §5 No Training — Prompt Engineering Only

**This is not fine-tuning. We do not train the model.**

The extraction pipeline uses prompt engineering + schema enforcement exclusively:

1. **System prompt**: Describes the extraction task, required fields, and output format.
   Field descriptions from the Zod schema MUST be included here — constrained decoding
   does not expose field descriptions to the model.

2. **Zod schema → JSON schema**: Passed to `generateObject()` as the output schema.
   The Vercel AI SDK (and vLLM's guided decoding) enforce structural validity at decode time.

3. **Validation re-prompt**: The `verifyAndStore` gate (T736) validates the generated object
   against the Zod schema. On failure it re-prompts with the validation errors appended to
   the original prompt. Max 2 retries before returning null/skip.

4. **No fine-tuning**: The model weights are never modified. No training loop, no LoRA,
   no adapter layers. CLEO pulls quantized weights from Ollama and runs inference only.

Pipeline summary:
```
JSONL transcript
  → system prompt (schema instructions)
  → generateObject() with JSON schema constraint
  → Zod parse
  → on fail: re-prompt with error (max 2x)  ← T736 verifyAndStore gate
  → on pass: verifyAndStore() dedup + write
```

The re-prompt strategy is the correct approach for E4B-it's known 10% schema non-compliance
rate. For complex nested schemas (50% compliance on E4B-it), simplify the Zod schema by
flattening nested structures before passing to the warm-tier model.

---

## Summary Table

| Decision | Recommendation |
|----------|---------------|
| Warm-tier model (Ollama) | `gemma4:e4b-it` — instruction-tuned, 90% schema compliance, 5GB Q4 VRAM |
| Cold-tier model | `claude-sonnet-4-6` — unchanged, owner-mandated |
| Cold-tier auth | `resolveAnthropicApiKey()` — already wired, picks up Claude Code OAuth automatically |
| Agent SDK for extraction | No — use `@ai-sdk/anthropic` + `generateObject()` directly |
| Agent SDK `canSpawn()` fix | Yes — use `resolveAnthropicApiKey()` instead of raw env var check |
| Training | None — prompt engineering + Zod + verifyAndStore re-prompt only |
| Spec patches needed | §7.1 model name, config block, auth note; llm-backend-resolver.ts priority list; spawn.ts canSpawn() |
