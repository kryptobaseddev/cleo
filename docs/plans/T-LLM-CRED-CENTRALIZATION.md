# T-LLM-CRED-CENTRALIZATION — Centralize CLEO LLM credentials, provider registry, and role-based routing

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
