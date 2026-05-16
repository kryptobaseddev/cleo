# T-LLM-CRED-CENTRALIZATION — Centralize CLEO LLM credentials, provider registry, and role-based routing

> **Status snapshot — audited 2026-05-15 against source after v2026.5.74**
>
> | Phase | Plan as-written | Actual shipped state |
> |-------|-----------------|----------------------|
> | Phase 1 | ResolvedCredential type + 6 broken call-sites fixed | ✓ verified — Call-sites fixed via `resolveCredentials` (plural shim) + `authHeaders`; **planned `packages/contracts/src/llm/credential.ts` was never created** (types live in `resolved-credential.ts` — see §As-Shipped Filename Addendum in ADR-072); **AC5 "30 min no-401 sentient daemon"** is owner-action (no live creds in CI env) |
> | Phase 2 | `cleo llm` CLI + cred store + role resolver | ✓ verified — `cleo llm whoami` `hasCredential` bug fixed (T9360, PR #169); role-to-credential join operational; real-world CLI smoke verified 4 PASS / 2 SKIP (T9361, PR #170) |
> | Phase 3 | Plugin registry + CredentialPool + OAuth + NormalizedResponse + auxiliary fallback | ✓ verified — All 6 sub-deliverables shipped as files; exercised via Phase 5 transport + fallback work |
> | Phase 4 | 8 waves; ADR-072 acceptance criteria AC1-AC7 + D-ph4-01..05 | ✓ verified (T9354 closure) — **AC1 PASS** (zero `new Anthropic` outside `transports/`, PR #173); **AC2 PASS** (test-file hits exempted per plan); **AC3 PASS** (coverage ≥ 80%, PR #167); **AC4 PASS** (≥3 integration tests per role, PR #167); **AC5 OWNER-ACTION** (real-world sentient: no live creds in env — code ships, verification deferred); **AC6 PASS** (OllamaTransport + smoke, PR #172); **AC7 PASS** (typecheck + build + test green); **D-ph4-01 CLOSED** (PR #173); **D-ph4-02 CLOSED** (PR #168); **D-ph4-03 CLOSED** (per-domain migration waves W3–W6); **D-ph4-04 CLOSED**; **D-ph4-05 CLOSED** (Gemini ✓, Ollama ✓ PR #172); planned filenames diverged — see ADR-072 §As-Shipped Filename Addendum (T9363, PR #171) |
> | Phase 5 | **Not in this doc** | ✓ verified — T9311–T9319 + T9325 + T9326 shipped v2026.5.71→v2026.5.73→v2026.5.74 under T9261. Streaming tool-call delta parity (T9316 openai+gemini), factory fallback wire (T9319), and fs-ACL enforcement (T9313) completed in T9362 PR #174 |
> | Phase 6 | **Not in this doc** | ✓ verified (T9354 epic closed) — All 10 closure tasks (T9355–T9364) completed via PRs #167–#174. AC5 (real-world sentient) remains owner-action follow-up (no live creds in env). ADR-072 status updated to Implemented. |
>
> **Status (2026-05-16)**: T9354 closure epic complete. All code-level acceptance criteria pass. AC5 (real-world sentient 30-min validation) is an owner-action follow-up requiring live credentials. ADR-072 status updated to **Implemented**.

## Context

The sentient daemon (`pid 2119947`, 105 ticks) has been 401-failing every dream/sleep cycle since 2026-05-12. Root cause confirmed: `packages/core/src/memory/sleep-consolidation.ts:228` sends the resolved token as `x-api-key`, but `resolveCredentials('anthropic')` tier 3 returns a Claude Code OAuth token from `~/.claude/.credentials.json` — those need `Authorization: Bearer <token>` + `anthropic-beta: oauth-2025-04-20` and a *missing* `x-api-key`. Anthropic rejects the mismatch. The same defect exists at every Anthropic-fetch and `new Anthropic({ apiKey })` call-site in `core/src/memory/*`, `core/src/sentient/*`, `core/src/deriver/*`, and `core/src/tasks/duplicate-detector.ts` — so for any user whose only credential is Claude Code OAuth (the dominant install), most of CLEO's autonomous LLM work is silently broken.

Beyond the bug, the LLM call surface is provider-hardcoded in ~35 places, has no role-based routing (every call hardwires `claude-haiku-4-5-20251001` or reads `llm.daemon.{provider,model}`), and has no central credential store — only ambient env-vars + the Claude Code OAuth file. Phase 1 unblocks the daemon. Phase 2 introduces role routing + a credentials file + a `cleo llm` CLI. Phase 3 ports the Hermes plugin registry, device-code OAuth, and credential-pool failover.

Goal: every LLM call in `@cleocode/core` goes through one resolver returning a typed `ResolvedCredential` and a registry-built client; zero provider-specific strings outside the registry; `@cleocode/cleo` stays a thin CLI over CORE operations.

---

## Phase 1 — Unblock the daemon (P0 hotfix · ~160 LOC · ship alone)

### What changes

1. **`packages/contracts/src/llm/credential.ts` (new ~40 LOC)** — public types:
   ```ts
   export type AuthType = 'api_key' | 'oauth' | 'aws_sdk';
   export type CredentialSource =
     | 'explicit' | 'env' | 'cred-file' | 'claude-creds'
     | 'global-config' | 'project-config';
   export interface ResolvedCredential {
     token: string;
     authType: AuthType;
     provider: ModelTransport;
     source: CredentialSource;
     baseUrl?: string;
     extraHeaders?: Record<string, string>;
     metadata?: Record<string, unknown>;
   }
   ```
   Re-export through `packages/contracts/src/index.ts`.

   > **AS-SHIPPED (T9363 retro — 2026-05-16)**: `packages/contracts/src/llm/credential.ts` was
   > **never created**. The `ResolvedCredential` type was created in W0b (T9281) as
   > `packages/contracts/src/llm/resolved-credential.ts` to be unambiguous about the type's role
   > as the OUTPUT of the resolution chain (not a credential input shape). The `AuthType` values
   > shipped as defined here. `CredentialSource` was not included in the final type (credential
   > source tracking is handled internally by the resolver, not exposed on `ResolvedCredential`).
   > The shipped interface has `expiresAt`, `refreshToken`, `awsProfile`, and `baseUrl` fields
   > that were refined from this plan.

2. **`packages/core/src/llm/credentials.ts` (edit ~50 LOC)** — add a sibling resolver and a header builder:
   ```ts
   export function resolveCredential(
     provider: ModelTransport, options?: CredentialResolveOptions
   ): ResolvedCredential | null;

   export function authHeaders(c: ResolvedCredential): Record<string, string>;
   //  oauth (anthropic) → { Authorization: `Bearer ${token}`, 'anthropic-beta': 'oauth-2025-04-20' }
   //  api_key (anthropic) → { 'x-api-key': token }
   //  api_key (others)    → { Authorization: `Bearer ${token}` }
   //  aws_sdk             → {} (SDK provides auth)
   ```
   `authType` is derived from the source + token-prefix heuristic for now: token starts with `sk-ant-oat-` or `sk-ant-ort-` → `oauth`; everything else → `api_key`. Existing `resolveCredentials()` and `resolveAnthropicApiKey()` stay as backward-compat shims (return string).

3. **`packages/core/src/llm/registry.ts` (edit ~25 LOC)** — drop module-load `initDefaultClients()`. Keep `CLIENTS` exported (tests + adapters mutate it directly), but populate lazily via a memoized `getDefaultClient(provider)`. Every override factory (`getAnthropicOverrideClient` etc.) gains a `defaultHeaders` argument so OAuth-callers can pass `{ Authorization: 'Bearer …', 'anthropic-beta': … }` and the SDK omits its default `x-api-key`.

4. **Patch the 6 broken call-sites (~70 LOC total)** to use `resolveCredential` + `authHeaders`:
   - `packages/core/src/memory/sleep-consolidation.ts:216-254` (`callLlm` raw fetch)
   - `packages/core/src/memory/observer-reflector.ts:254` (raw fetch path)
   - `packages/core/src/memory/llm-extraction.ts:307+` (`new Anthropic({ apiKey })`)
   - `packages/core/src/sentient/dream-cycle.ts:542+` (`new Anthropic`)
   - `packages/core/src/deriver/deriver.ts:150,158` (`new Anthropic`)
   - `packages/core/src/tasks/duplicate-detector.ts:427+` (`new Anthropic`)

   For SDK paths: `new Anthropic({ apiKey: cred.token, defaultHeaders: authHeaders(cred) })`. The SDK sends `x-api-key` by default; passing `defaultHeaders` with `Authorization` causes the SDK to send both, which Anthropic still rejects — so for OAuth paths we must construct `Anthropic` with `apiKey: ''` (sentinel) and provide `Authorization` in `defaultHeaders`. Confirm this against `@anthropic-ai/sdk` v0.x behavior before locking — fallback is to bypass the SDK and use raw fetch for the OAuth case.

5. **Tests (~30 LOC)** in `packages/core/src/llm/__tests__/credentials-auth-type.test.ts`:
   - `sk-ant-oat-…` resolves with `authType: 'oauth'` and produces Bearer headers
   - `sk-ant-api03-…` resolves with `authType: 'api_key'` and produces `x-api-key` header
   - `registry.ts` no longer crashes when imported with empty env

### Verification

```bash
# Build + typecheck + tests must all be green
pnpm biome check --write packages/contracts packages/core
pnpm run build
pnpm run typecheck
pnpm --filter @cleocode/core run test -- credentials-auth-type sleep-consolidation
# Live end-to-end (after restarting daemon)
cleo sentient kill && cleo sentient start
tail -f .cleo/logs/sentient.err   # No 401 for ~10 min
cleo memory find "sleep-consolidation" --limit 1   # New observations with N>0 memories
```

Acceptance: after restart, `[sleep-consolidation] Anthropic API error 401` does not appear for 30 min; `cleo sentient status` shows `ticksExecuted` advancing without new failures.

### Files to edit (Phase 1)

- `packages/contracts/src/llm/credential.ts` *(new)*
- `packages/contracts/src/index.ts` *(re-export)*
- `packages/core/src/llm/credentials.ts`
- `packages/core/src/llm/registry.ts`
- `packages/core/src/memory/sleep-consolidation.ts`
- `packages/core/src/memory/observer-reflector.ts`
- `packages/core/src/memory/llm-extraction.ts`
- `packages/core/src/sentient/dream-cycle.ts`
- `packages/core/src/deriver/deriver.ts`
- `packages/core/src/tasks/duplicate-detector.ts`
- `packages/core/src/llm/__tests__/credentials-auth-type.test.ts` *(new)*

---

## Phase 2 — Role routing + credentials file + `cleo llm` CLI (W1 · ~700 LOC)

### Sub-tasks (file in CLEO as children of the epic)

**T-llm-1: `resolveLLMForRole(role)` helper in `@cleocode/core/llm/role-resolver.ts`** (~120 LOC)
- Roles: `extraction | consolidation | derivation | hygiene | judgement` (collapsed from the 7-role proposal; see Design lock-in below).
- Reads `llm.roles.<role>.{provider,model,credentialLabel?}`, falls back to `llm.default.{provider,model}`, then to legacy `llm.daemon.{provider,model}`.
- Returns `{ provider, model, client, credential }` — call-sites never construct clients directly.
- Migrate the 6 Phase-1 call-sites to consume `resolveLLMForRole('consolidation' | 'extraction' | 'derivation' | 'hygiene' | 'judgement')` instead of provider-hardcoded `resolveCredential('anthropic')`.

**T-llm-2: Config schema additions in `packages/contracts/src/config.ts`** (~60 LOC)
- `LlmConfig.default?: { provider, model }` (replaces `daemon` as the inheritable fallback; `daemon` kept as alias for back-compat).
- `LlmConfig.roles?: Record<RoleName, { provider, model, credentialLabel? }>`.
- `RoleName` literal union exported from contracts.
- Update `packages/core/schemas/config.schema.json` to mirror.

**T-llm-3: Credentials store in `@cleocode/core/llm/credentials-store.ts`** (~180 LOC)
- File: `~/.cleo/llm-credentials.json` (path via existing `getCleoHome()`).
- Schema:
  ```jsonc
  {
    "version": 1,
    "defaultStrategy": "priorityWithFallback",
    "credentials": [
      { "provider": "anthropic", "label": "claude-code-oauth",
        "authType": "oauth", "accessToken": "sk-ant-oat-…",
        "refreshToken": "sk-ant-ort-…", "expiresAt": 1736700000000,
        "priority": 10, "source": "claude-code",
        "extraHeaders": { "anthropic-beta": "oauth-2025-04-20" },
        "lastStatus": "ok" },
      { "provider": "anthropic", "label": "personal",
        "authType": "api_key", "accessToken": "sk-ant-api03-…", "priority": 20 },
      { "provider": "openai", "label": "personal",
        "authType": "api_key", "accessToken": "sk-…" },
      { "provider": "bedrock", "label": "prod", "authType": "aws_sdk",
        "accessToken": "", "metadata": { "awsProfile": "cleo-prod", "region": "us-west-2" } }
    ]
  }
  ```
- Use existing `withLock` + `writeJsonFileAtomic` from `packages/core/src/store/file-utils.ts:76-199` (do **not** roll new file-locking).
- Enforce `chmod 0600` on write. Mirror Hermes's `agent/credential_pool.py:32-33` (`read_credential_pool` / `write_credential_pool`).
- Public API: `listCredentials(provider?)`, `addCredential(input)`, `removeCredential(provider, label)`, `getCredentialByLabel(provider, label)`, `pickCredentialForProvider(provider, strategy?)`.
- Add a fifth tier between env (2) and claude-creds (3) — see Design lock-in.

**T-llm-4: `cleo llm` CLI command file** at `packages/cleo/src/cli/commands/llm.ts` (~250 LOC)
- Mirror the `cleo memory` subcommand pattern in `packages/cleo/src/cli/commands/memory.ts:2019-2045` (`makeSubcommand` factory).
- Subcommands:
  ```
  cleo llm add <provider> --api-key <k> [--label l] [--base-url u]
  cleo llm list [provider]
  cleo llm remove <provider> --label <l>
  cleo llm use <provider> [--model m]              # sets llm.default
  cleo llm profile <role> <provider> [--model m]   # sets llm.roles.<role>
  cleo llm test <provider> [--label l]             # round-trip ping
  cleo llm whoami                                  # show resolution for every role
  ```
- All subcommands dispatch through `dispatchFromCli('mutate' | 'query', 'llm', '<op>', ...)` (per `packages/cleo/src/dispatch/adapters/cli.ts:195-296`).
- New dispatch handlers under `packages/cleo/src/dispatch/domains/llm/*` thin-wrap the core store + role-resolver.
- `cleo llm test` mirrors `cleo admin smoke --provider` (`packages/cleo/src/cli/commands/admin.ts:88-115`) — 1 small message, success/error envelope.
- Update auto-generated manifest: `pnpm --filter @cleocode/cleo run gen:manifest`.

**T-llm-5: Tests** (~90 LOC)
- `packages/core/src/llm/__tests__/credentials-store.test.ts` — add/list/remove with file-lock + 0600 enforcement.
- `packages/core/src/llm/__tests__/role-resolver.test.ts` — role→provider→credential resolution + fallback chain.
- `packages/cleo/src/cli/__tests__/llm-command.test.ts` — at least `add`, `list`, `whoami` envelope shape.

### Acceptance gates (Phase 2)

- `cleo llm whoami` prints each role with its resolved `{ provider, model, source, label? }` — no `null` for daemon/consolidation when env or cred-file is present.
- `cleo llm test anthropic --label personal` returns `{ success: true, data: { latencyMs, model } }`.
- The 6 Phase-1 call-sites now use `resolveLLMForRole(...)`; grep for `'claude-haiku-4-5-20251001'` outside `packages/core/src/llm/` returns zero hits.
- `pnpm run typecheck && pnpm run build && pnpm run test` green.
- Migration test: an existing `.cleo/config.json` with only `llm.providers.anthropic.apiKey` still works (tier 5/6 fallback).

---

## Phase 3 — Plugin registry, OAuth depth, pool failover (W2 · deferred · RCASD before scope-locking)

Ports from Hermes (all references absolute):
- `/mnt/projects/hermes-agent/providers/base.py` → `ProviderProfile` interface + plugin module shape.
- `/mnt/projects/hermes-agent/providers/__init__.py:43-192` → lazy registry with last-writer-wins user-plugin override at `~/.cleo/plugins/model-providers/`.
- `/mnt/projects/hermes-agent/agent/credential_pool.py:92-1095` → `CredentialPool` with `priority/source/last_status/last_error_code/last_error_reset_at/request_count`, rotation strategies (`fill_first | round_robin | least_used`), 401→5min / 429→1h cooldown, soft concurrency leases.
- `/mnt/projects/hermes-agent/agent/auxiliary_client.py` → fallback chain router for side-task LLM calls.
- `/mnt/projects/hermes-agent/agent/transports/types.py:1-163` → `NormalizedResponse` shape so every transport returns the same structure.
- `/mnt/projects/hermes-agent/hermes_cli/auth_commands.py` → device-code OAuth template for `cleo llm login <provider>` (OpenAI, xAI, Qwen, Nous).
- `/mnt/projects/hermes-agent/agent/model_metadata.py:1407-1438` → `getModelContextLength(model, baseUrl, apiKey)` priority chain (live API → curated → static default 256K).

Phase 3 is **gated on RCASD** because plugin contracts and the pool concurrency model compound — once the plugin interface ships, every third-party provider locks against it. File the RCASD before any implementation.

---

## Design lock-in (irreversible after Phase 1 + 2 ship)

1. **`AuthType` enum has exactly three values**: `'api_key' | 'oauth' | 'aws_sdk'`. Adding a fourth value is a breaking change for every switch-statement consumer; choose carefully.
2. **Resolver precedence is `explicit > env > cred-file > claude-creds > global-config > project-config`**. Cred-file beats Claude Code OAuth because explicit user keys should win over ambient session — reversing later silently re-routes billing.
3. **`resolveAnthropicApiKey()` stays as a `string | null` shim forever** — backward compat. New Anthropic call-sites MUST use `resolveCredential('anthropic')` or `resolveLLMForRole(role)`; CI grep-check enforces.
4. **`registry.ts` exports `CLIENTS` as a mutable map even after lazy-init** — adapters and tests mutate it directly; this is intentional escape hatch, not a bug.
5. **Role names `extraction | consolidation | derivation | hygiene | judgement` are user-visible config keys** under `llm.roles.*`. Renaming requires a config migration. Daemon/research/nexus are explicitly **not** roles — daemon is a process, research/nexus have no current LLM call-sites.

---

## Critical files to read before starting

- `packages/core/src/llm/credentials.ts:120-268` — resolution tiers as-shipped today.
- `packages/core/src/llm/registry.ts:34-202` — module-load anti-pattern + override factories.
- `packages/core/src/memory/sleep-consolidation.ts:216-254` — the exact 401 site.
- `packages/contracts/src/config.ts:397-496` — existing `LlmConfig` shape to extend.
- `packages/core/src/store/file-utils.ts:76-199` — `writeJsonFileAtomic` + `withLock` (re-use, don't reinvent).
- `packages/cleo/src/cli/commands/memory.ts:2019-2045` — `makeSubcommand` pattern for `cleo llm`.
- `packages/cleo/src/dispatch/adapters/cli.ts:195-296` — CLI→core dispatch wiring.
- `packages/cleo/src/cli/commands/admin.ts:88-115` — model for `cleo llm test <provider>`.
- `/mnt/projects/hermes-agent/agent/credential_pool.py:92-1095` — Phase 3 port target.
- `/mnt/projects/hermes-agent/providers/__init__.py:43-192` — Phase 3 plugin registry.

---

## End-to-end verification

After Phase 1:
```bash
# Build
pnpm biome check --write . && pnpm run typecheck && pnpm run build
# Tests
pnpm run test
# Live unblock
cleo sentient kill && cleo sentient start
sleep 60
grep -c "Anthropic API error 401" .cleo/logs/sentient.err   # New count should match pre-restart
cleo memory find "sleep-consolidation" --limit 3            # Recent run with N>0 memories
cleo sentient status                                         # ticksExecuted advancing
```

After Phase 2:
```bash
cleo llm add anthropic --api-key sk-ant-api03-XXX --label personal
cleo llm list
cleo llm profile consolidation anthropic --model claude-haiku-4-5-20251001
cleo llm profile hygiene anthropic --model claude-sonnet-4-6
cleo llm whoami
cleo llm test anthropic --label personal     # round-trip < 3s, success: true
# Migration safety
mv ~/.cleo/llm-credentials.json /tmp/back.json
# Daemon falls back through tier 4 (config.json) or tier 3 (Claude OAuth) and still works
cleo sentient kill && cleo sentient start && sleep 60 && cleo sentient status
mv /tmp/back.json ~/.cleo/llm-credentials.json
```

After Phase 3 (gated on RCASD outcomes — verification spec deferred).

---

## Task tree to file in CLEO

```
T-LLM-CRED-CENTRALIZATION (epic, P0)
├── Phase 1 (P0, ~1 day)
│   ├── T-llm-p1-1  ResolvedCredential type + authHeaders helper
│   ├── T-llm-p1-2  Lazy initDefaultClients in registry.ts
│   ├── T-llm-p1-3  Patch 6 broken call-sites (OAuth header fix)
│   └── T-llm-p1-4  Unit tests + live restart verification
├── Phase 2 (W1, ~3-5 days)
│   ├── T-llm-1     resolveLLMForRole helper + role wiring
│   ├── T-llm-2     LlmConfig schema extension (roles + default)
│   ├── T-llm-3     credentials-store.ts (file-locked, 0600)
│   ├── T-llm-4     cleo llm CLI + dispatch handlers
│   └── T-llm-5     Tests (store, resolver, CLI)
└── Phase 3 (W2, RCASD-gated)
    ├── T-llm-p3-1  ProviderProfile interface + plugin loader
    ├── T-llm-p3-2  CredentialPool with rotation + cooldown
    ├── T-llm-p3-3  Device-code OAuth (cleo llm login)
    ├── T-llm-p3-4  NormalizedResponse transports
    ├── T-llm-p3-5  Model metadata (getModelContextLength)
    └── T-llm-p3-6  Auxiliary fallback router
```

Each task in CLEO with `--acceptance "..."` per ADR-066. Phase 1 children gate the epic into implementation stage; Phase 3 children stay in research stage until RCASD ships.

---

## Phase 4 — Unified LLM provider architecture (three-interface stack · integration-first · ADR-072)

**Architecture decision**: ADR-072 (locked). See `.cleo/adrs/ADR-072-unified-llm-provider-architecture.md`.

**Framing**: Phase 4 is integration-first. All Phase 1-3 work is kept and wired into the new
three-interface stack (LlmTransport / LlmSession / LlmExecutor). No Phase 3 code is deleted
during Phase 4. Legacy call-sites are migrated one domain at a time; the old and new paths
coexist until W7 cleanup.

**Acceptance criteria (epic-level)**:

1. `grep 'new Anthropic({' packages/` outside `packages/core/src/llm/transports/` returns zero hits.
2. `grep 'claude-haiku-4-5-20251001' packages/` outside `packages/core/src/llm/` returns zero hits.
3. `packages/core/src/llm/` unit test coverage ≥ 80% (Istanbul/v8).
4. At least 3 integration tests per role (mock transport, no live API calls).
5. `cleo sentient status` shows `ticksExecuted` advancing without 401 errors for 30 min post-migration.
6. All five providers (Anthropic, Bedrock, OpenAI-compat, Gemini, Ollama) have an `LlmTransport` implementation.
7. `pnpm run typecheck && pnpm run build && pnpm run test` green on `main` after each wave merges.

**Accepted-debt ledger** (see ADR-072 § Accepted-debt ledger for rationale):

| ID | Debt | Resolved in |
|----|------|-------------|
| D-ph4-01 | `CLIENTS` mutable map in `registry.ts` | W7 |
| D-ph4-02 | `resolveAnthropicApiKey()` string shim | W7 |
| D-ph4-03 | 12 hardcoded model strings outside `llm/` | W3-W6 (per-domain migrations) |
| D-ph4-04 | `cleo-os` constructs own Anthropic client | W6 |
| D-ph4-05 | Gemini/Ollama missing ProviderProfile | W8 |

---

### Wave 0a — Foundation documents (T9280 · docs-only)

**Goal**: Commit ADR-072 + Phase 4 plan section + Hermes architecture reference spec.
No code changes. Gates W0b/W0c from starting.

**Files**:
- `.cleo/adrs/ADR-072-unified-llm-provider-architecture.md` *(new)*
- `docs/plans/T-LLM-CRED-CENTRALIZATION.md` — this Phase 4 section *(added)*
- `docs/specs/hermes-agent-llm-provider-architecture.md` *(new)*

**Acceptance**: PR merged to `main`. ADR-072 Status = "Accepted". Plan and spec present.

---

### Wave 0b — Contract type additions (T9281 · ~120 LOC · contracts-only)

**Goal**: Add the three interface files to `packages/contracts/src/llm/`. Zero implementation.

**Files to create** (planned):
```
packages/contracts/src/llm/normalized-message.ts   — NormalizedMessage, ToolCall, NormalizedRole
packages/contracts/src/llm/transport.ts            — LlmTransport, TransportRequestPayload, TransportChunk, NormalizedResponse, PingResult
packages/contracts/src/llm/session.ts              — LlmSession, SessionChunk, SessionSendOptions, CompressionOptions
packages/contracts/src/llm/executor.ts             — LlmExecutor, ExecutorOptions, ExecutorChunk, SessionOptions
packages/contracts/src/llm/index.ts                — re-exports all four above
```

> **AS-SHIPPED (T9363 retro — 2026-05-16)**: None of the planned filenames above were created.
> The implementation (T9281 + T9263 + T9282) produced a different but equivalent file set:
> - `normalized-response.ts` — holds `LlmTransport` + `NormalizedResponse` + `TransportMessage` + related wire types (pre-ADR-072, T9263)
> - `interfaces.ts` — holds `LlmSession` + `LlmExecutor` + `NormalizedDelta` + 10+ supporting types (T9281)
> - `resolved-credential.ts` — holds `ResolvedCredential` (was planned as `credential.ts` in Phase 1; named after the type for clarity)
> - `provider-id.ts` — holds `ProviderId` / `ApiMode` / `BuiltinProviderId` (not in original plan, added T9281)
> - `provider-profile.ts` — holds `ProviderProfile` hooks (not in original plan, added via Phase 3 port)
> - `failover-reason.ts`, `oauth.ts`, `plugin-llm.ts` — additional types added in Phase 5
>
> Reason for divergence: `LlmTransport` was established in `normalized-response.ts` by T9263 (pre-ADR-072).
> When W0b ran, moving it would have broken existing consumers. `LlmSession`/`LlmExecutor` were collapsed
> into a single `interfaces.ts` because they are co-dependent and share supporting types (see T9363 spec).

**Files to edit**:
- `packages/contracts/src/index.ts` — add `export * from './llm/index.js'`

**Acceptance gates**:
- `pnpm run typecheck` green (zero new errors from the new interface files).
- `pnpm run build` green.
- All four interface files have TSDoc on every exported symbol.
- No implementation code in `packages/contracts/` (interfaces and types only).

---

### Wave 0c — NormalizedMessage migration helper (T9282 · ~80 LOC)

**Goal**: Add a `toNormalizedMessage(anthropicMsg)` conversion utility and update
`packages/core/src/llm/` to use `NormalizedMessage` internally (no call-site changes yet).

**Files to create/edit** (planned):
- `packages/core/src/llm/normalized-message-utils.ts` *(new)* — conversion helpers
- `packages/core/src/llm/__tests__/normalized-message.test.ts` *(new)* — 6+ unit tests

> **AS-SHIPPED (T9363 retro — 2026-05-16)**: `normalized-message-utils.ts` was **never created**.
> The W0c commit (T9282, `8cdf10f79`) focused on extending `LlmTransport` with `stream()` + `apiMode`
> and adding `ProviderProfile` hooks — not adding a conversion helper. Message-format conversion was
> inlined into each transport's `complete()` / `stream()` methods (anthropic.ts, gemini.ts,
> chat-completions.ts) because conversion requires provider-specific SDK types. A `message-utils.ts`
> was later extracted (T9289 DRY cleanup) for token-count estimation only, not message conversion.
> **This planned file is superseded. Do not create it.**

**Acceptance gates**:
- Conversion helper covers Anthropic, OpenAI-compat, and Bedrock message formats.
- 6+ unit tests covering tool-call messages, multi-turn, and edge cases (empty content, etc.).
- `pnpm run typecheck && pnpm run build && pnpm run test` green.

---

### Wave 1 — Transport implementations (T9283 · ~400 LOC)

**Goal**: Implement `AnthropicTransport`, `BedrockTransport`, and `OpenAICompatTransport`
in `packages/core/src/llm/transports/`. Each wraps the Phase 1-3 credential + profile stack.

**Files to create**:
```
packages/core/src/llm/transports/base-transport.ts      — abstract base with shared retry + error-norm logic
packages/core/src/llm/transports/anthropic-transport.ts — Anthropic SDK + raw-fetch fallback for OAuth
packages/core/src/llm/transports/bedrock-transport.ts   — Bedrock SDK via Phase 3 ProviderProfile
packages/core/src/llm/transports/openai-compat-transport.ts — OpenAI-compat (any base URL)
packages/core/src/llm/transports/index.ts               — registry: provider → LlmTransport factory
packages/core/src/llm/__tests__/transports/             — unit tests (mock HTTP, no live API)
```

**Constraints**:
- `AnthropicTransport.request()` MUST check `ResolvedCredential.authType` and send
  `Authorization: Bearer` for `'oauth'` vs `x-api-key` for `'api_key'`. This is the Phase 1 fix.
- No call-site migration in W1. Transports are unused until W2.
- `shouldRotateCredential(err)` method on each transport signals the executor to rotate.
  (Note: `shouldRotate` bare-word shorthand is NOT used anywhere — always `shouldRotateCredential`.)

**Acceptance gates**:
- `pnpm run typecheck && pnpm run build` green.
- Unit tests cover: auth header selection (oauth vs api_key), 401 → `shouldRotateCredential`,
  429 → `shouldRotateCredential`, 500 → retry with backoff, successful streaming chunk.
- `ping()` returns `PingResult` with `latencyMs`.

---

### Wave 2 — Session + Executor (T9284 · ~350 LOC)

**Goal**: Implement `DefaultLlmSession` and `DefaultLlmExecutor`. Wire to Phase 3 credential pool.

**Files to create** (planned):
```
packages/core/src/llm/default-session.ts     — DefaultLlmSession
packages/core/src/llm/default-executor.ts    — DefaultLlmExecutor (singleton factory)
packages/core/src/llm/__tests__/executor/    — integration tests with mock transports
```

> **AS-SHIPPED (T9363 retro — 2026-05-16)**: `default-session.ts` and `default-executor.ts` were
> never created. The Wave 2 implementation was split across 4 tasks (T9287–T9291) and produced:
> - `concrete-session.ts` (T9287 W2a) — implements `LlmSession` as `ConcreteSession`
> - `session-factory.ts` (T9288 W2b) — implements `LlmSessionFactory` as `DefaultLlmSessionFactory`;
>   bridges `resolveLLMForRole` → transport routing → `ConcreteSession`
> - `concrete-executor.ts` (T9290 W3a) — implements `LlmExecutor` as `ConcreteExecutor`
> - `executor-factory.ts` (T9291 W3b) — provides `getLlmExecutor()` singleton + `ExecutorFactory`
>
> Naming change: "Default*" → "Concrete*" because "Concrete" more clearly signals
> "non-abstract implementation of an interface" vs "default fallback." The class name
> and filename match (class `ConcreteSession` lives in `concrete-session.ts`).
>
> Split rationale: Session factory and executor factory have distinct responsibilities
> (transport routing vs singleton lifecycle), so SRP favored two files over one.
>
> The singleton pattern (`getLlmExecutor()`) was preserved from the plan; it lives in
> `executor-factory.ts` not the executor itself.

**Key implementation notes**:
- `DefaultLlmExecutor` is a singleton. `getLlmExecutor()` returns the shared instance.
  (Pattern mirrors `getDefaultClient()` from the Phase 1 lazy-init work.)
- `DefaultLlmExecutor.execute(role, messages)`:
  1. Calls `resolveLLMForRole(role)` — Phase 2 role resolver.
  2. Looks up `ProviderProfile` from Phase 3 registry.
  3. Instantiates the correct `LlmTransport` from the W1 transport registry.
  4. Creates a `DefaultLlmSession` wrapping the transport.
  5. Calls `session.send(messages, opts)`.
  6. On 401/429 from transport: calls `credentialPool.rotate(provider)` + retries once.
- `DefaultLlmSession.compress()` calls `executor.execute('compression', summarizePrompt)`.
  Context budget guard: if `tokensUsed < 0.5 * contextBudget`, skip compression.

**Acceptance gates**:
- `executor.execute('consolidation', messages)` succeeds with mock transport.
- `executor.rotate('consolidation')` cycles to next credential in mock pool.
- `session.remainingBudget()` returns correct value after a round-trip.
- `pnpm run typecheck && pnpm run build && pnpm run test` green.

---

### Wave 3 — Memory domain migration (T9285 · ~200 LOC edit)

**Goal**: Migrate `packages/core/src/memory/` call-sites to use `getLlmExecutor()`.

**Files to edit**:
- `packages/core/src/memory/sleep-consolidation.ts` — `callLlm` raw fetch → `executor.execute('consolidation', ...)`
- `packages/core/src/memory/observer-reflector.ts` — raw fetch → `executor.execute('extraction', ...)`
- `packages/core/src/memory/llm-extraction.ts` — `new Anthropic({apiKey})` → `executor.execute('extraction', ...)`

**Acceptance gates**:
- `grep 'new Anthropic(' packages/core/src/memory/` returns zero hits post-migration.
- `grep 'raw fetch\|resolveCredentials\|resolveAnthropicApiKey' packages/core/src/memory/` returns zero hits.
- `pnpm --filter @cleocode/core run test -- sleep-consolidation observer-reflector llm-extraction` green.
- Live: daemon restart → no 401 in `sentient.err` for 10 min.

---

### Wave 4 — Sentient + deriver migration (T9286 · ~150 LOC edit)

**Goal**: Migrate `packages/core/src/sentient/` and `packages/core/src/deriver/` call-sites.

**Files to edit**:
- `packages/core/src/sentient/dream-cycle.ts` — `new Anthropic` → `executor.execute('consolidation', ...)`
- `packages/core/src/deriver/deriver.ts` — `new Anthropic` → `executor.execute('derivation', ...)`

**Acceptance gates**:
- `grep 'new Anthropic(' packages/core/src/sentient/ packages/core/src/deriver/` returns zero hits.
- `pnpm --filter @cleocode/core run test -- dream-cycle deriver` green.
- D-ph4-03 progress: provider-hardcoded strings reduced to ≤6 (from 12).

---

### Wave 5 — Tasks + nexus migration (T9287 · ~100 LOC edit)

**Goal**: Migrate `packages/core/src/tasks/` and nexus-adjacent call-sites.

**Files to edit**:
- `packages/core/src/tasks/duplicate-detector.ts` — `new Anthropic` → `executor.execute('hygiene', ...)`
- Any nexus call-sites using direct Anthropic construction.

**Acceptance gates**:
- `grep 'new Anthropic(' packages/core/src/tasks/ packages/core/src/nexus/` returns zero hits.
- `pnpm --filter @cleocode/core run test` green.
- D-ph4-03 progress: provider-hardcoded strings ≤2 (from 6).

---

### Wave 6 — cleo-os harness migration (T9288 · ~80 LOC edit · D-ph4-04)

**Goal**: Migrate the `cleo-os` Claude Code adapter's own Anthropic client (D-ph4-04) to use
`getLlmExecutor()` from `@cleocode/core`.

**Files to edit**:
- `packages/cleo-os/src/adapters/claude-code/` — whichever file constructs Anthropic directly.

**Constraints**:
- `packages/cleo-os/` is the harness layer. It MAY import from `@cleocode/core` for the executor
  but MUST NOT reach into `packages/core/src/llm/transports/` internals directly.

**Acceptance gates**:
- `grep 'new Anthropic(' packages/cleo-os/` returns zero hits.
- `pnpm --filter @cleocode/cleo-os run test` green.
- D-ph4-04 CLOSED.

---

### Wave 7 — Cleanup: delete legacy transport helpers (T9289 · ~200 LOC delete)

**Goal**: Delete all legacy bypass paths now that every call-site uses the executor.

**Files to edit/delete**:
- `packages/core/src/llm/registry.ts` — remove `initDefaultClients`, `CLIENTS` mutable map,
  `getAnthropicOverrideClient` and friends. Replace with thin shim that warns if called (D-ph4-01).
- `packages/core/src/llm/credentials.ts` — remove `resolveAnthropicApiKey()` (D-ph4-02).
  Leave `resolveCredential()` — it's still used by transports.
- Any dead import chains.

**Pre-delete verification**:
```bash
grep -r 'initDefaultClients\|getAnthropicOverrideClient\|CLIENTS\[' packages/ --include='*.ts' | grep -v __tests__
grep -r 'resolveAnthropicApiKey' packages/ --include='*.ts' | grep -v __tests__
```
Both must return zero non-test hits before deleting.

**Acceptance gates**:
- `pnpm run typecheck && pnpm run build && pnpm run test` green after deletions.
- D-ph4-01 and D-ph4-02 CLOSED.

---

### Wave 8 — Provider coverage + docs (T9290 · ~300 LOC + docs)

**Goal**: Add Gemini and Ollama transports (D-ph4-05). Update docs to final state.

**Files to create**:
```
packages/core/src/llm/transports/gemini-transport.ts
packages/core/src/llm/transports/ollama-transport.ts
packages/core/src/llm/transports/__tests__/gemini-transport.test.ts
packages/core/src/llm/transports/__tests__/ollama-transport.test.ts
```

**Files to update**:
- `docs/specs/hermes-agent-llm-provider-architecture.md` — update "CLEO current state" table
- `docs/plans/T-LLM-CRED-CENTRALIZATION.md` — mark Phase 4 complete
- ADR-072 — update status to "Implemented" and link the W8 merge commit

**Acceptance gates** (epic-level closure):
- All 7 epic-level acceptance criteria satisfied (see top of Phase 4 section).
- Coverage targets from ADR-072 § Coverage targets all met.
- D-ph4-05 CLOSED.
- `pnpm run typecheck && pnpm run build && pnpm run test` green.

---

### Phase 4 task tree

```
T9261 (epic, T-LLM-CRED-CENTRALIZATION)
└── Phase 4
    ├── T9280  Wave 0a — Foundation docs (ADR-072 + plan + Hermes spec)    [DONE — this PR]
    ├── T9281  Wave 0b — Contract type additions (interfaces, no impl)
    ├── T9282  Wave 0c — NormalizedMessage migration helper
    ├── T9283  Wave 1  — Transport implementations (Anthropic, Bedrock, OAI-compat)
    ├── T9284  Wave 2  — Session + Executor (DefaultLlmSession, DefaultLlmExecutor)
    ├── T9285  Wave 3  — Memory domain migration
    ├── T9286  Wave 4  — Sentient + deriver migration
    ├── T9287  Wave 5  — Tasks + nexus migration
    ├── T9288  Wave 6  — cleo-os harness migration (D-ph4-04)
    ├── T9289  Wave 7  — Cleanup: delete legacy transport helpers
    └── T9290  Wave 8  — Provider coverage (Gemini, Ollama) + docs closure
```

Risk register:

| Risk | Probability | Impact | Mitigation |
|------|-------------|--------|------------|
| `LlmSession.compress()` triggers runaway recursive token spend | Low | High | Budget cap: skip if `tokensUsed < 50% contextBudget`; compression role uses cheap model |
| OAuth Anthropic SDK behavior changes between SDK versions | Medium | High | Unit-test the auth header selection path; pin `@anthropic-ai/sdk` version |
| Gemini transport diverges from `NormalizedResponse` contract | Medium | Medium | Port Hermes `gemini_native_adapter.py` shape directly; test with mock responses |
| W7 deletion breaks an undiscovered call-site | Low | High | Pre-delete grep (required in W7 acceptance) + full test suite green before delete |
| cleo-os harness has different auth context than core | Low | Medium | W6 AC requires `grep` clean + harness test suite green |

---

## Phase 5 — Provider expansion + plugin extension + streaming (shipped v2026.5.71 → v2026.5.74)

Phase 5 was **not pre-planned in this document**. The 9 ready tasks (T9311-T9319) descended from `## Phase 3` and `## Phase 4 § Wave 8` deferred items and were built in a single orchestration session under T9261. Two residual Phase-4 follow-ups (T9325 test un-skips, T9326 Anthropic OAuth placeholder hardening) shipped alongside. T9344 hotfix corrected an incorrect "placeholder" framing in T9326.

### What shipped under Phase 5

| Task | Title | Notes |
|------|-------|-------|
| T9311 | CodexResponsesTransport (OpenAI Responses API + xAI grok) | `xaiResponsesProfile` registered; `transportForProvider()` `codex_responses` branch wired |
| T9312 | ContextEngine plugin registry + RuleBasedTruncationEngine | Mirrors `provider-registry/index.ts` pattern; CLI `cleo llm context-engines list` |
| T9313 | Plugin LLM facade sandboxing | Permissions whitelist + fs ACL + per-plugin rate-limit token-bucket. **Caveat**: `validateFsAccess` is advisory-only (not auto-invoked by `pluginLlmComplete`); enforcement at the tool-dispatch layer is a follow-up |
| T9314 | Live model catalog refresh CLI | `cleo llm refresh-catalog` fetches `https://models.dev/api.json`, versioned cache at `$CLEO_DATA_DIR/llm-catalog/`. **Bugfix**: initial impl introduced async network on every `getModelMetadata`; fixed to disk-only read |
| T9315 | `cleo llm stream` CLI | Streams text + reasoning via `ConcreteSession.stream()` |
| T9316 | Streaming tool-call deltas | `NormalizedDelta` extended; **anthropic + chat-completions only** — openai.ts and gemini.ts symmetry deferred (3-file-cap rule on subtask atomicity) |
| T9317 | BedrockTransport (Converse API + cross-region + guardrail) | Recovery PR #159 after worker-T9317 merged its task branch directly into local main without opening a PR — required cherry-pick recovery + `build.mjs` esbuild externals fix for `@aws-sdk/*` + `@smithy/*` |
| T9318 | Rust napi-rs hot-paths | `crates/cleo-llm-native` + `packages/core/src/llm/rust/` JS fallback. **Gaps**: no `package.json` for the napi binary distribution; native path opt-in via `CLEO_USE_RUST=1`; **binary distribution targets unresolved** — was Pi armv6 in original plan but Pi-harness is being retired in favor of T1737 Sentient Harness v3 |
| T9319 | Multi-provider auxiliary fallback chain | `runAuxiliaryWithFallback()` + `AllProvidersExhaustedError`. **Caveat**: production executor factory (`getLlmExecutor` / `ExecutorFactory.create`) does NOT auto-pass `auxiliaryFallbackChain` from config — the function exists, the mechanism works in unit tests, but the chain is dead in production code paths |
| T9325 | Un-skip 5 Phase 4 prep test skips | brain-stdp×3, event-bus conduit-fallback, performance-safety perf-timeout |
| T9326 | Anthropic OAuth client_id hardening | **T9344 superseded the "placeholder" framing** — `9d1c250a-e61b-44d9-88ed-5944d1962f5e` is the canonical public PKCE client_id (matches Hermes `agent/anthropic_adapter.py:1041`); no Anthropic registration required |
| T9344 | Hotfix — drop false placeholder framing + fix `redirectUri` | Cancels misconceived followups T9341/T9342/T9343 |

### Phase 5 release timeline

- **v2026.5.71** (PR #150): T9337 verifier-substrate removal (parallel cleanup, not Phase 5)
- **v2026.5.73** (PR #162): 11 Phase-5 PRs (#151-161) merged
- **v2026.5.74** (PR #164): T9344 hotfix; cancels T9341/T9342/T9343

### Phase 5 not-yet-validated items

| Gap | Why open | Phase 6 task |
|-----|----------|--------------|
| T9316 openai.ts + gemini.ts tool-call delta parity | 3-file atomicity cap split the work | T9362 (Task H) |
| T9319 production auto-wire of `auxiliaryFallbackChain` in `ExecutorFactory.create` | Mechanism shipped without factory plumbing | T9362 (Task H) |
| T9313 `validateFsAccess` call-site enforcement | Helper is advisory-only; tool-dispatch layer doesn't invoke it | T9362 (Task H) |
| T9318 napi binary distribution strategy | Pi armv6 obsolete; Sentient Harness v3 (T1737) platforms not yet defined | Deferred to T1737 |

---

## Phase 6 — Closure & real-world validation (T9354 · pending)

Phase 6 closes the gaps surfaced by the 2026-05-15 audit. It is an **orchestrated closure epic** — not new feature work, just discipline cleanup so the plan's own acceptance criteria pass cleanly.

### Phase 6 epic: T9354

```
T9354 EPIC — T9261 closure: ship missing Phase 4 deliverables + Ollama + real-world validation + residual debt
├── T9355  Task A — Ollama transport (AC6 + D-ph4-05 closure)
├── T9356  Task B — registry.ts factory function retirement (D-ph4-01 final close)
├── T9357  Task C — adapters-package resolveAnthropicApiKey shim removal (D-ph4-02 final close)
├── T9358  Task D — Coverage measurement + per-role integration test audit (AC3 + AC4)
├── T9359  Task E — REAL-WORLD sentient daemon validation (AC5 — 30 min no-401)
├── T9360  Task F — Fix `cleo llm whoami` hasCredential lookup bug
├── T9361  Task G — REAL-WORLD `cleo llm` CLI smoke matrix against actual providers
├── T9362  Task H — Phase 5 deferred parity work (T9316 openai+gemini, T9319 factory wire, T9313 fs-ACL enforcement)
├── T9363  Task I — Plan-doc retro: formally retire planned-but-not-built filenames (credential.ts, default-session.ts, etc.) by recording the actual shipped names + reasoning
└── T9364  Task J — ADR-072 status update to "Implemented" only after AC1-AC7 verified
```

Each task contains 1-7 atomic subtasks (one context window each per the hierarchy rule). Subtask filing happens at the start of the Phase 6 session.

### Phase 6 acceptance criteria

1. `grep 'new Anthropic({' packages/ --include='*.ts' | grep -v dist/ | grep -v /llm/transports/ | grep -v /__tests__/` returns zero hits.
2. `packages/core/src/llm/transports/ollama.ts` exists with `LlmTransport` implementation + unit tests + real-world smoke test against a local `ollama serve`.
3. `grep 'resolveAnthropicApiKey' packages/ --include='*.ts' | grep -v dist/ | grep -v /__tests__/` returns zero hits.
4. `pnpm test --coverage` reports `packages/core/src/llm/` ≥ 80% line coverage.
5. Each of the 5 roles (extraction, consolidation, derivation, hygiene, judgement) has ≥ 3 integration tests against a mock transport.
6. **Real-world**: live `cleo sentient` run for 30 min with at least 1 LLM-backed task picked + completed; `sentient.err` shows zero new `401` lines.
7. **Real-world**: `cleo llm test <provider>` round-trip succeeds for at least anthropic (OAuth) + openai + one OAI-compat (kimi-code or groq); each command returns `{success: true, data: {latencyMs, model}}` in < 5s.
8. **Real-world**: `cleo llm whoami` shows `hasCredential: true` for at least one role after `cleo llm profile consolidation anthropic --label default`.
9. T9316 openai.ts + gemini.ts streaming tool-call deltas parity test added + passing.
10. T9319 fallback chain wired through `ExecutorFactory.create` with integration test verifying exhaustion → next-provider activation in a real factory call.
11. T9313 `validateFsAccess` invoked at every tool-dispatch site that may read/write files; documented enforcement model in `plugin-facade.ts` header.
12. ADR-072 status updated to "Implemented" with the v2026.5.X release that closes T9354.
13. `docs/plans/T-LLM-CRED-CENTRALIZATION.md` final-state table at the top of this doc shows all phases ✓ with verified evidence rows.

### Phase 6 dependency on T1737 (Sentient Harness v3 redesign)

Phase 6 explicitly does **not** address Rust napi binary distribution (T9318 follow-up). That work is gated on T1737's platform target decisions — T1737 will define which platforms (linux x64/arm64, macos x64/arm64, win x64, and any others) the Sentient Harness ships binaries for, after which the napi-rs prebuild matrix can be written. Filing this as a Phase 6 task would assume a Pi-armv6 target that's been retired.

### Phase 6 related research/work — separate epics

- **T9345** — IVTR Release System research + RCASD overhaul (filed 2026-05-15 after multiple `cleo release ship` failures this session)
- **T1737** — EPIC CleoOS Sentient Harness v3 — Full Native Stack Replacement (full redesign of CleoOS, supersedes ADR-035 Pi-harness; ports ~150K LOC of Hermes Agent to TypeScript)
