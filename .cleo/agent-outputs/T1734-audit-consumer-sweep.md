# T1734 Audit — monorepo openai consumer sweep

## Direct value imports (need code review post-migration)

- `packages/core/src/llm/registry.ts:13` — `import { OpenAI } from 'openai'` — constructs `new OpenAI(...)` clients for `CLIENTS['openai']`, `CLIENTS['moonshot']`, and returns `OpenAI` instances from `getOpenAIOverrideClient()` and `getMoonshotOverrideClient()`

## Type-only imports (may need code review if types changed)

- `packages/core/src/llm/types.ts:13` — `import type { OpenAI } from 'openai'` — used in the `ProviderClient` union type (`Anthropic | OpenAI | GoogleGenerativeAI | Record<string, unknown>`) which is exported from the LLM barrel
- `packages/core/src/llm/backends/openai.ts:15` — `import type { OpenAI } from 'openai'` — used as the `client` parameter type throughout `OpenAIBackend` methods
- `packages/core/src/llm/backends/moonshot.ts:20` — `import type { OpenAI } from 'openai'` — used as the constructor parameter type for `MoonshotBackend(client: OpenAI)`

## package.json entries

| Workspace | Version specifier | Dep type |
|---|---|---|
| `packages/core` | `^4.0.0` | `dependencies` |
| `packages/adapters` | (none — does not declare `openai` directly; uses `@ai-sdk/openai ^2.0.53`) | — |

Note: `packages/adapters` declares `@ai-sdk/openai ^2.0.53` (Vercel AI SDK wrapper), not the raw `openai` SDK. These are distinct packages.

## Test mocks

- `packages/adapters/src/providers/openai-sdk/__tests__/openai-sdk-spawn.test.ts:38` — `vi.mock('@ai-sdk/openai', ...)` — mocks `createOpenAI` factory to return a stub model object; tests spawn/canSpawn/OPENAI_API_KEY env var logic
- `packages/adapters/src/__tests__/harness-interop.test.ts:71` — `vi.mock('@ai-sdk/openai', ...)` — mocks `createOpenAI` factory alongside `@ai-sdk/anthropic` and `ai`; tests three-dispatcher harness interop

Note: both mocks target `@ai-sdk/openai` (Vercel wrapper), not the raw `openai` package. If T1734 migrates the raw `openai` SDK the mocks do not need updating. If it also touches `@ai-sdk/openai`, both test files require mock surgery.

## Re-exports / barrel files

- `packages/core/src/llm/index.ts` — re-exports `ProviderClient` (union containing `OpenAI`) from `./types.js`, `OpenAIBackend` and `usesMaxCompletionTokens` from `./backends/openai.js`, `OpenAIHistoryAdapter` from `./history-adapters.js`, and `CLIENTS` / `backendForProvider` / `clientForModelConfig` / `getBackend` from `./registry.js`
- `packages/core/src/index.ts:52` — re-exports the entire LLM barrel as `export * as llm from './llm/index.js'`, making all LLM symbols (including `ProviderClient` which embeds `OpenAI`) accessible via `import { llm } from '@cleocode/core'`

**Dist evidence of public API surface (regenerate on build but confirm public exposure):**

- `packages/core/dist/llm/index.d.ts` — exports `OpenAIBackend`, `OpenAIHistoryAdapter`, `ProviderClient` (type contains `OpenAI`), `CLIENTS`
- `packages/core/dist/llm/types.d.ts:12` — `import type { OpenAI } from 'openai'` appears in the distributed type declaration; `ProviderClient` union is public
- `packages/core/dist/llm/registry.d.ts:22` — `getOpenAIOverrideClient` and `getMoonshotOverrideClient` both declare return type `OpenAI` (these functions are NOT re-exported through the barrel; they are internal to `registry.ts`)
- `packages/adapters/dist/providers/openai-sdk/*.d.ts` — references to openai are string literals (`"openai-sdk"`, `"openai"` provider names), not SDK type imports
- `packages/contracts/dist/adapter.d.ts` and `packages/contracts/dist/config.d.ts` — string-literal references only (`provider: 'openai'`), no SDK type dependency

## Indirect consumers (packages that import the re-exported types)

No package outside `packages/core` was found to import `ProviderClient`, `OpenAIBackend`, `OpenAIHistoryAdapter`, `CLIENTS`, `backendForProvider`, `clientForModelConfig`, or `getBackend` from `@cleocode/core` in source files. However:

- `packages/cleo` — imports many symbols from `@cleocode/core` via the `export * as llm` namespace path; does not import LLM-specific symbols at present but links against `@cleocode/core` which embeds the openai dep
- `packages/core/src/tasks/duplicate-detector.ts:455` — dynamic import of `cleoLlmCall` from `'../llm/api.js'` (within core itself); calls it at runtime with `await import(...)` so it is gated on code path

## CI / scripts / configs touching openai

- `temp/agents/configs/opensource-team-config.yaml:52,57` — references `openrouter/openai/gpt-5.4` and `openrouter/openai/gpt-5.4-mini` as model identifiers in OpenRouter config (string values, no SDK import; not in a shipped package)
- `packages/adapters/src/providers/openai-sdk/manifest.json:42` — `OPENAI_API_KEY` listed as a required env-var check in the adapter manifest (this is a runtime check, not a build artifact)
- No GitHub Actions workflow files (`.github/`) contain `openai`

## pnpm-lock evidence

Two versions of `openai` are installed simultaneously — a version split exists:

```
# Workspace-level specifiers (pnpm-lock.yaml importers section)

packages/core:
  openai:
    specifier: ^4.0.0
    version: 4.104.0(ws@8.20.0)(zod@4.3.6)   # direct dep, declared explicitly

# Resolution snapshot entries
openai@4.104.0:
  resolution: {integrity: sha512-p99EFNsA/...}
  engines: {node: '>=18'}
  peerDependencies: { ws: ^8.18.0, zod: ^3.23.8 }

openai@4.104.0(ws@8.20.0)(zod@4.3.6):
  dependencies:
    '@types/node': 18.19.130
    '@types/node-fetch': 2.6.13
    abort-controller: 3.0.0
    agentkeepalive: 4.6.0
    form-data-encoder: 1.7.2
    formdata-node: 4.4.1
    node-fetch: 2.7.0
  optionalDependencies: { ws: 8.20.0, zod: 4.3.6 }

# openai@6 comes in TRANSITIVELY through cleo-os → @mariozechner/pi-coding-agent → @mariozechner/pi-ai
openai@6.26.0:
  resolution: {integrity: sha512-zd23dbWTjiJ6sSAX6s0HrCZi41JwTA1bQVs0wLQPZ2/5o2gxOJA5wh7yOAUgwYybfhDXyhwlpeQf7Mlgx8EOCA==}
  engines: {node: '>=18'}
  peerDependencies: { ws: ^8.18.0, zod: ^3.25 || ^4.0 }

openai@6.26.0(ws@8.20.0)(zod@4.3.6):
  optionalDependencies: { ws: 8.20.0, zod: 4.3.6 }

# Dependency chain for v6:
# packages/cleo-os → @mariozechner/pi-coding-agent@0.66.0
#   → @mariozechner/pi-agent-core@0.66.0
#     → @mariozechner/pi-ai@0.66.0 → openai@6.26.0
```

**Version split confirmed**: `openai@4.104.0` (direct, `packages/core`) and `openai@6.26.0` (transitive, via `packages/cleo-os` → pi harness). The v6 installation is third-party/transitive and not used by any cleocode source file directly.

`pnpm why openai` confirms:
```
openai@4.104.0
└── @cleocode/core@2026.5.15 (dependencies)

openai@6.26.0
└─┬ @mariozechner/pi-ai@0.66.0
  ├─┬ @mariozechner/pi-agent-core@0.66.0
  │ └─┬ @mariozechner/pi-coding-agent@0.66.0
  │   └── @cleocode/cleo-os@2026.5.15 (dependencies)
  └── @mariozechner/pi-coding-agent@0.66.0 [deduped]
```

## Risk-rank

| Rank | File | Risk | Reason |
|------|------|------|--------|
| 1 | `packages/core/src/llm/registry.ts` | **CRITICAL** | Only file with a runtime value import (`import { OpenAI } from 'openai'`); constructs live SDK clients, exports functions returning `OpenAI` objects. A major version bump will break `new OpenAI(...)` call signatures and the client map `CLIENTS['openai']` |
| 2 | `packages/core/src/llm/backends/openai.ts` | **HIGH** | The entire `OpenAIBackend` class uses `client: OpenAI` as its state. All method call sites (e.g. `client.chat.completions.create(...)`) are version-sensitive API calls. A v4→v6 migration changes response shape, streaming interface, and tool-call format |
| 3 | `packages/core/src/llm/types.ts` | **MEDIUM** | `ProviderClient` union embeds the `OpenAI` type. Any downstream consumer that narrows `ProviderClient` to `OpenAI` with an `instanceof` check or structural access breaks silently if the SDK changes its exported class shape |
| 4 | `packages/core/src/llm/backends/moonshot.ts` | **MEDIUM** | Delegates 100% to `OpenAIBackend`; its constructor takes `OpenAI` directly. No direct API surface calls but tightly coupled to `OpenAIBackend` correctness |
| 5 | `packages/core/dist/llm/types.d.ts` + `packages/core/dist/llm/index.d.ts` | **LOW-MEDIUM** | These regenerate on build, but currently expose `OpenAI` type in the public `ProviderClient` type. If the migrated version removes or renames the `OpenAI` class, any downstream type-checking against published types breaks until a rebuild |

## Things the migration worker MUST also touch (not in T1734's atomic file scope)

- **`packages/core/src/llm/registry.ts`** — the only runtime value import (`import { OpenAI } from 'openai'`) and only place that calls `new OpenAI(...)`. If T1734's declared file scope does not include this file, the migration is incomplete and the package will fail at runtime when the client map is initialized.
- **`packages/core/src/llm/backends/openai.ts`** — all `client.chat.completions.create(...)` call sites, the `choices[0].message` response shape accesses, and any streaming iterator shape assumptions must be validated against the target SDK version.
- **`packages/core/src/llm/backends/moonshot.ts`** — must be re-verified after `openai.ts` changes since it delegates entirely to `OpenAIBackend` and passes a raw `OpenAI` client.
- **`packages/core/src/llm/types.ts`** — `ProviderClient` union should be reviewed: if the new SDK does not export `OpenAI` class with the same name, the type union must be updated and the dist types rebuilt.
- **`packages/core/package.json`** — the version specifier (`"openai": "^4.0.0"`) must be bumped to target the migrated version. The current specifier will continue to resolve v4 even after a source migration.
- **`packages/core/src/llm/__tests__/llm-layer.test.ts`** — uses `OpenAI` as a return type annotation on `makeMockClient()` (line 613) and casts `as unknown as OpenAI` (line 631); these are inferred through the `MoonshotBackend` import chain. If the SDK class shape changes, the cast may compile but be structurally wrong.
- **`packages/core/src/llm/history-adapters.ts`** — not directly audited above but `OpenAIHistoryAdapter` is exported through the barrel; it likely contains message-format logic tied to the SDK's `Chat.Completions.ChatCompletionMessageParam` types. Must be validated.
- **Version split**: The presence of `openai@6.26.0` in the lock (via `packages/cleo-os` / pi harness) means pnpm already has v6 in the store. If T1734 bumps `packages/core` to v6, confirm that the hoisting behavior does not introduce ambiguous resolution for any shared peer.
