# Phase 3 RCASD Synthesis — T9261 (T-LLM-CRED-CENTRALIZATION)

**Date**: 2026-05-13  
**Author**: cleo-prime (lead, single-voice — time-bounded, orchestrator override)  
**Hermes ref root**: `/mnt/projects/hermes-agent/`  
**Phase 2 baseline**: v2026.5.63, all 5 T9255–T9259 tasks complete

---

## Phase 3 goal

Port the Hermes Agent provider architecture into `@cleocode/core` and `@cleocode/cleo` as a buildable, shippable unit. The deliverables are: a typed `ProviderProfile` plugin registry (extensible without repo changes), a `CredentialPool` with rotation and 401/429 cooldown, a device-code OAuth login flow for Anthropic, a `NormalizedResponse` transport interface (Anthropic real, OpenAI/Gemini stubs to lock the contract), a `getModelContextLength` helper with a curated table, and an `auxiliary-router` that wires pool failover to role-resolved transports. Phase 3 makes multi-credential setups operationally viable and lays the plugin contract that third-party providers will depend on — so the interface must be correct before anyone adopts it.

---

## Wave plan

**W1 — Parallel (no deps on each other, only on Phase 2 closeout T9259)**
- T-llm-p3-1: ProviderProfile + plugin loader
- T-llm-p3-4: NormalizedResponse transports
- T-llm-p3-5: Model metadata

**W2 — Parallel after W1 lands (dep on T-llm-p3-1)**
- T-llm-p3-2: CredentialPool rotation + cooldown
- T-llm-p3-3: Device-code OAuth (`cleo llm login`)

**W3 — Sequential after W2 (deps on T-llm-p3-2 AND T-llm-p3-4)**
- T-llm-p3-6: Auxiliary fallback router

Total estimated LOC: ~910 across contracts + core + cleo (see `research/hermes-port-targets.md`).

---

## Owner-decision queue

These 8 decisions lock in once the tasks ship. Each has a recommendation + 1-line rationale. Rubber-stamp or flip before spawning workers.

### D1 — ProviderProfile plugin file shape
**Decision**: flat files `~/.cleo/plugins/model-providers/*.{mjs,js}` export `register(registry)`.  
**Rec**: ✓ Use flat-file over Hermes dir-per-plugin. Dir layout is needed when plugins ship multiple files (Python `__init__.py` + siblings); our plugins are single-module TS/ESM files.  
**Locks in**: the plugin API forever. Any future change requires a breaking semver bump on contracts.

### D2 — Pool rotation strategy default
**Decision**: `fill_first` (priority-sorted, pick top eligible entry).  
**Rec**: ✓ Matches Phase 2 `priorityWithFallback`. Round-robin is strictly opt-in via config. Users with a single key experience no change. Multi-key users who want distribution set `llm.pool.strategy: round_robin` in config.

### D3 — OAuth provider order for `cleo llm login`
**Decision**: Anthropic only for MVP; others return `E_NOT_IMPLEMENTED`.  
**Rec**: ✓ The Anthropic flow is the only one we have verified device-code docs for. OpenAI device-code is documented but requires testing against their auth server. Ship anthropic, stub the rest.

### D4 — NormalizedResponse field names
**Decision**: camelCase TS (`inputTokens`, `outputTokens`, `stopReason`, `toolCalls`, `providerData`, `raw`).  
**Rec**: ✓ Consistent with existing contracts (`LlmCallResult.inputTokens`/`outputTokens` etc.). Hermes uses snake_case because Python; TS land uses camelCase throughout.  
**Locks in**: `NormalizedResponse` is the cross-transport wire type. Renaming later breaks every transport adapter.

### D5 — Model-metadata live-API fallback
**Decision**: defer live Anthropic `/v1/models` probe to a follow-up task.  
**Rec**: ✓ Curated table + 256K default covers all models CLEO currently uses. Live probe requires credential threading + error handling that doubles the task scope. Leave a `// TODO: T-llm-p3-5-live` comment so it's findable.

### D6 — Auxiliary-router scope
**Decision**: side-task calls only (not the main daemon path).  
**Rec**: ✓ Main daemon path uses `resolveLLMForRole` directly (Phase 2). The router adds pool failover on top for side-task calls (compression, hygiene, deriver). Merging both paths would require refactoring Phase 2 call-sites — defer.

### D7 — `refreshToken` on `StoredCredential`
**Decision**: T-llm-p3-3 adds `refreshToken?: string` back to `StoredCredential` (Phase 2 removed it per S-07 — "deferred until refresh implementation"). T-llm-p3-3 IS that implementation.  
**Rec**: ✓ The field must be re-added in the same PR as the refresh-token consumption code, or we ship a broken flow. Implementer of T-llm-p3-3 owns the field re-addition + the credential-store schema note update.

### D8 — CredentialPool concurrency leases
**Decision**: skip soft concurrency leases for MVP.  
**Rec**: ✓ Hermes `_active_leases` protects against N concurrent calls all picking the same entry and exhausting it simultaneously. CLEO's orchestrator is single-process today; real concurrency comes if multiple sentient workers run in parallel, which is a future change. A counter-based lease can be added later without breaking the pick() API.

---

## Risk register

**R1 — Plugin loader path resolution fails on XDG non-standard setups**  
`cleoHomeDir()` resolves via `$XDG_DATA_HOME`. Plugin discovery hard-codes `cleoHomeDir()/plugins/model-providers/`. On non-standard XDG installs, the directory may not exist or may be in an unexpected location. Mitigation: log a debug message when the plugin dir is missing (not an error); document in plugin README.

**R2 — OAuth device-code endpoint changes break the anthropic flow**  
The Anthropic device-code client_id and endpoint are not versioned in the public API. If Anthropic rotates them, `cleo llm login anthropic` breaks silently (403 or 404). Mitigation: make `ANTHROPIC_OAUTH_CLIENT_ID` and `ANTHROPIC_DEVICE_CODE_URL` overridable via env vars from day 1.

**R3 — NormalizedResponse `raw` field causes credential leakage in logs**  
`raw: unknown` carries the full SDK response. If the SDK includes auth headers in error objects (some SDKs do), logging the raw response leaks credentials. Mitigation: T-llm-p3-4 implementer must verify that `@anthropic-ai/sdk` error objects do not include request headers; strip `raw` before any `logger.*` call.

**R4 — CredentialPool writes race with credentials-store writes**  
`CredentialPool.markExhausted()` calls `addCredential()` (upsert), which acquires `withLock`. If two pool instances for the same provider run concurrently (e.g. daemon + auxiliary router), their `addCredential` calls serialize correctly — `withLock` is process-global. Durable across concurrent workers requires cross-process locking which `proper-lockfile` already provides. No action needed; documenting for awareness.

**R5 — Importing plugin files via `await import('file://...')` on Windows**  
`file://` URL construction differs on Windows (forward vs backward slashes in paths). Mitigation: use `pathToFileURL(absPath).href` from `node:url` — available in Node 18+. Implementer of T-llm-p3-1 must use this, not manual string construction.
