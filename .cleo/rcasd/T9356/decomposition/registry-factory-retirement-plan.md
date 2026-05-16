# T9356 Decomposition Plan — registry.ts Factory Function Retirement

**Epic**: T9354 · **Task**: T9356  
**Date**: 2026-05-16  
**Status**: Decomposed into 3 sequential subtasks

## Problem Analysis

`packages/core/src/llm/registry.ts` still contains legacy factory functions and per-provider client caches that bypass the LlmTransport contract established in T9324.

### Functions to Remove

| Function | Lines | Callers |
|----------|-------|---------|
| `buildAnthropicSdkClient` | 128-138 | None outside `index.ts` re-export |
| `clientForModelConfig` | 159-233 | `runtime.ts:103`, `role-resolver.ts:314` |
| `historyAdapterForProvider` | 245-249 | None outside `index.ts` re-export — relocate to `history-adapters.ts` |

### Helpers to Remove (only used by clientForModelConfig)

- `hashSecret` (line ~47)
- `makeOverrideKey` (line ~62)
- `extractBearerToken` (line ~100)

### Caches to Remove

- `_anthropicCache: Map<string, Anthropic>`
- `_openaiCache: Map<string, OpenAI>`
- `_geminiCache: Map<string, GoogleGenerativeAI>`
- `_moonshotCache: Map<string, OpenAI>`

## Subtask Breakdown

### T9369 — S-B1: Audit + remove buildAnthropicSdkClient callers (small)

- `buildAnthropicSdkClient` has NO callers outside `llm/index.ts` (export-only, never invoked externally)
- Delete `buildAnthropicSdkClient` from `registry.ts`
- Remove from `llm/index.ts` exports
- Relocate `historyAdapterForProvider` to `history-adapters.ts` (already has the adapter classes)
- Remove from `registry.ts`, update `llm/index.ts` export source

### T9370 — S-B2: Remove clientForModelConfig + per-provider client caches (small, depends T9369)

Two callers must be migrated:

1. **`runtime.ts:103`** (`planAttempt` function):
   - Currently calls `clientForModelConfig(provider, selected)` to get `AttemptPlan.client`
   - Migrate: construct transport directly using provider switch
   - `AnthropicTransport` / `OpenAI` / `GoogleGenerativeAI` constructor matching `selected.transport`

2. **`role-resolver.ts:314`** (`resolveLLMForRole` function):
   - Currently calls `clientForModelConfig(provider, modelConfig) as LLMClient`
   - Migrate: inline construction equivalent (same logic as `buildAnthropicSdkClient` but for all providers)
   - Or: delegate to `AnthropicTransport` and equivalent transport constructors

After migration:
- Delete `clientForModelConfig` from `registry.ts`
- Delete `_anthropicCache`, `_openaiCache`, `_geminiCache`, `_moonshotCache`
- Delete `makeOverrideKey`, `hashSecret`, `extractBearerToken` (only used by `clientForModelConfig`)
- Remove from `llm/index.ts` exports

### T9371 — S-B3: Final grep verification + full test suite green (small, depends T9370)

Final verification gate:
```bash
grep 'new Anthropic({' packages --include='*.ts' -r | grep -v '/dist/' | grep -v '/transports/' | grep -v '/__tests__/'
# MUST return zero hits
pnpm run build   # must exit 0
pnpm run test    # must exit 0, zero new failures
```

## Dependencies

```
T9369 → T9370 → T9371
```

Sequential — each step must be complete before the next begins.

## Migration Pattern for clientForModelConfig callers

### runtime.ts planAttempt migration

Instead of `clientForModelConfig(provider, selected)`, build a thin helper
that constructs the correct transport class directly from `selected`:

```ts
import Anthropic from '@anthropic-ai/sdk';
import { OpenAI } from 'openai';
import { GoogleGenerativeAI } from '@google/generative-ai';

function buildProviderClient(provider: ModelTransport, config: ModelConfig): ProviderClient {
  const apiKey = config.apiKey ?? defaultTransportApiKey(provider);
  if (provider === 'anthropic') {
    return new Anthropic({ apiKey: apiKey ?? undefined, baseURL: config.baseUrl ?? undefined, timeout: 600_000 });
  }
  if (provider === 'openai') return new OpenAI({ apiKey: apiKey ?? undefined, baseURL: config.baseUrl ?? undefined });
  if (provider === 'gemini') return new GoogleGenerativeAI(apiKey ?? '');
  if (provider === 'moonshot') return new OpenAI({ apiKey: apiKey ?? undefined, baseURL: config.baseUrl ?? MOONSHOT_BASE_URL });
  throw new Error(`Unknown provider: ${provider as string}`);
}
```

This can live in `runtime.ts` or a small helper file, NOT in `registry.ts`.

### role-resolver.ts migration

Same inline construction — or delegate to a shared helper in `credentials.ts`.
