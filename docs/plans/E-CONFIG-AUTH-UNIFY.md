# E-CONFIG-AUTH-UNIFY — Paths SSoT, Credential Pool, and Setup Wizard

**Status**: DRAFT — pending owner review before task filing  
**Date**: 2026-05-16  
**Epics**: E1 (Path SSoT enforcement), E2 (Unified credential pool + multi-source seeders), E3 (Setup wizard + status surface + Studio Keys UI)  
**Design reference**: Hermes Agent at `/mnt/projects/hermes-agent/`  
**CLEO codebase**: `/mnt/projects/cleocode/`

---

## Table of Contents

1. [Research](#1-research)
2. [Consensus](#2-consensus)
3. [Architecture](#3-architecture)
4. [Specification](#4-specification)
5. [Decomposition](#5-decomposition)

---

## 1. Research

### 1.1 Hermes Agent — The Design Reference

Hermes Agent (`/mnt/projects/hermes-agent/`) is a Python-based agentic tool that solved the same three problems CLEO faces now: XDG-compliant path layout, credential pool with multi-source seeding, and a modular setup wizard. This section documents what Hermes does and how, so that CLEO's design can deliberately adopt, adapt, or consciously reject each pattern.

#### 1.1.1 Directory Layout — Hermes

Hermes stores everything under `~/.hermes/` with a clean secret/non-secret split:

```
~/.hermes/
├── config.yaml     # Non-secret settings (model, terminal, TTS, compression, etc.)
├── .env            # API keys and secrets — NEVER in config.yaml
├── auth.json       # OAuth provider credentials (Nous Portal, device-code flows, etc.)
├── SOUL.md         # Agent identity prompt
├── memories/       # Persistent memory
├── skills/         # Agent-created skills
├── cron/           # Scheduled jobs
├── sessions/       # Gateway sessions
└── logs/           # Logs (errors.log, gateway.log — auto-redacted)
```

Source: `/mnt/projects/hermes-agent/website/docs/user-guide/configuration.md:9-24`

The critical design rule: **secrets go in `.env`, non-secrets go in `config.yaml`**. The `hermes config set KEY VAL` command auto-routes the value to the correct file — a provider API key is written to `.env`, a `model` preference is written to `config.yaml`. This eliminates the footgun of API keys landing in config files that get committed or shared.

Hermes does not follow XDG strictly — it uses `~/.hermes/` as a flat directory, not `~/.config/hermes/` vs `~/.local/share/hermes/`. The secret/non-secret split is the essential pattern CLEO should adopt, not the specific directory structure.

#### 1.1.2 Hermes Configuration Precedence

From `/mnt/projects/hermes-agent/website/docs/user-guide/configuration.md:47-56`:

1. CLI arguments (`hermes chat --model ...`) — per-invocation override  
2. `~/.hermes/config.yaml` — primary non-secret config  
3. `~/.hermes/.env` — secret env vars  
4. Built-in defaults  

This is a 4-tier chain. CLEO currently has a 6-tier chain (see §1.2.2) that includes a project-level config tier that allows secrets to be stored in project-scoped files — the footgun Hermes eliminates at design time.

#### 1.1.3 Hermes Credential Pool — Architecture

The core of Hermes's credential system is `agent/credential_pool.py`. The pool is a typed, multi-entry in-memory store seeded from external sources at startup. Each entry is tagged with a `source` field identifying where it came from.

**Priority order for anthropic** (source: `/mnt/projects/hermes-agent/agent/credential_pool.py:1139-1144`):

```python
source_rank = {
    "env:ANTHROPIC_TOKEN": 0,
    "env:CLAUDE_CODE_OAUTH_TOKEN": 1,
    "hermes_pkce": 2,
    "claude_code": 3,
    "env:ANTHROPIC_API_KEY": 4,
}
```

Lower number = higher priority. Manually-added credentials rank above auto-seeded ones.

#### 1.1.4 Hermes `_seed_from_singletons()` — External Credential Discovery

Source: `/mnt/projects/hermes-agent/agent/credential_pool.py:1169-1250`

The seeder function is called at pool load time for each provider. For `anthropic`, it reads two external files and upserts their tokens into the pool:

1. `hermes_pkce` — Hermes's own PKCE OAuth file (`~/.hermes/.anthropic_oauth.json`)  
2. `claude_code` — Claude Code's credentials file (`~/.claude/.credentials.json`)  

**Critical guard** (`credential_pool.py:1186-1193`): Hermes only reads `~/.claude/.credentials.json` when the user has explicitly configured `anthropic` as their provider via `is_provider_explicitly_configured("anthropic")`. This was added in PR #4210 to prevent auxiliary client fallback chains from silently reading Claude Code credentials without user consent.

Each upsert carries:
- `source`: the seeder name  
- `auth_type`: `AUTH_TYPE_OAUTH` for Claude Code tokens  
- `access_token`: the bearer token  
- `refresh_token`: for refresh flow  
- `expires_at_ms`: for expiry checks  
- `label`: a fingerprint-derived display name  

For `openai-codex`, `qwen-oauth`, `google-gemini-cli` providers, Hermes reads those CLIs' OAuth files directly rather than performing its own OAuth. Source: `credential_pool.py:1292-1395` (qwen), and `hermes_cli/auth.py:159-175` (PROVIDER_REGISTRY declarations for `openai-codex`, `qwen-oauth`, `google-gemini-cli` with `auth_type="oauth_external"`). This is the **delegate-to-partner-CLI** pattern: Hermes does not try to do device-code OAuth for OpenAI/Gemini directly — it reads the token files already written by the user's installed CLIs.

#### 1.1.5 Hermes `_seed_from_env()` — Environment Variable Seeding

Source: `/mnt/projects/hermes-agent/agent/credential_pool.py:1400-1476`

The env seeder has a key design decision: `~/.hermes/.env` is preferred over `os.environ` for the same variable name. This means a deliberate change to Hermes's own config file beats whatever the user's shell exported. Env-seeded entries are tagged `source: "env:ANTHROPIC_API_KEY"` and suppressed via the same mechanism as singleton-seeded entries.

#### 1.1.6 Hermes Write-Back to `~/.claude/.credentials.json`

Source: `/mnt/projects/hermes-agent/agent/anthropic_adapter.py:871-913`

When Hermes refreshes an Anthropic OAuth token, it writes the new tokens back to `~/.claude/.credentials.json`, not just to its own pool. The function `_write_claude_code_credentials()` uses atomic temp-rename + 0600 permissions and deliberately preserves the `claudeAiOauth.scopes` field so Claude Code recognizes the refreshed token. Claude Code >= 2.1.81 gates on `user:inference` being present in `scopes`.

This is **cooperative co-ownership**: both tools treat `~/.claude/.credentials.json` as a shared file. The user logs in once (via either tool), and both tools stay current with the refreshed token. This is the most important behavioral gap between Hermes and CLEO: CLEO reads the file but never writes back.

#### 1.1.7 Hermes `RemovalStep` Registry

Source: `/mnt/projects/hermes-agent/agent/credential_sources.py:1-132`

Every credential source Hermes reads from registers a `RemovalStep` dataclass. When `hermes auth remove <provider> <N>` runs, the unified dispatcher calls the matching step, which does exactly three things:

1. Cleans up external state (removes the `.env` line, clears the auth.json block, etc.)  
2. Suppresses the `(provider, source_id)` pair in `auth.json` so re-seeding skips it  
3. Returns `RemovalResult` with `cleaned` (what changed) and `hints` (what the user may need to do manually)  

Without this, removal of env-seeded credentials was silently undone on the next `load_pool()` call whenever the variable was still exported by the user's shell. Adding a new source requires: (a) a reader branch in `_seed_from_*`, (b) a suppression gate, (c) one new `RemovalStep` registration.

#### 1.1.8 Hermes `auth list` — Unified Credential View

Source: `/mnt/projects/hermes-agent/hermes_cli/auth_commands.py:404-428`

`hermes auth list` enumerates ALL pool entries across all sources in a tagged view — showing provider, entry count, label, auth type, source, and current marker. Every entry regardless of how it was seeded (PKCE, claude_code, env, manual) appears in the same list with its source label.

CLEO's `cleo llm list` shows only entries from `~/.cleo/llm-credentials.json` (the manually-added pool). Active Anthropic OAuth from `~/.claude/.credentials.json` does NOT appear. Verified empirically on this system: `cleo llm list` returns the pool file contents only; the Claude Code tier-4 entry is invisible to the user.

#### 1.1.9 Hermes Provider Registry

Source: `/mnt/projects/hermes-agent/hermes_cli/auth.py:149-227`

Hermes maintains a typed `PROVIDER_REGISTRY: Dict[str, ProviderConfig]` with entries for:
- `nous` — `oauth_device_code` (Hermes's own IdP)  
- `openai-codex` — `oauth_external` (reads Codex CLI's OAuth file)  
- `qwen-oauth` — `oauth_external` (reads qwen-cli's file)  
- `google-gemini-cli` — `oauth_external` (reads gemini-cli's Cloud Code login)  
- `lmstudio` — `api_key`, local  
- `copilot` — `api_key`, reads `gh auth token`  
- `gemini` — `api_key` (Google AI Studio key)  

The `oauth_external` pattern is what makes Hermes non-invasive: it does not compete with OpenAI or Gemini's own OAuth flows, it just reads their output files.

#### 1.1.10 Hermes Setup Wizard

Source: `/mnt/projects/hermes-agent/hermes_cli/setup.py`

The setup wizard is modular: 5 independently-runnable sections:
1. **Model & Provider** — choose AI provider and model  
2. **Terminal Backend** — where the agent runs commands  
3. **Agent Settings** — iterations, compression, session reset  
4. **Messaging Platforms** — Telegram, Discord, etc.  
5. **Tools** — TTS, web search, image generation, etc.  

Auto-routes: API keys go to `.env`, settings go to `config.yaml`. Each section is independently runnable, which matters for re-configuration (user changes just their model without re-running the full wizard).

CLEO has no equivalent. `cleo config set` is a raw key-value setter with no wizard interaction and no auto-routing of secrets.

#### 1.1.11 Hermes Model Slots

Source: `/mnt/projects/hermes-agent/website/docs/user-guide/configuring-models.md`

Hermes has 1 main model + 8 auxiliary slots (vision, compression, title, search, approval, web extract, skills hub, MCP). These are functional task slots for side-jobs.

CLEO has 5 **roles** (extraction, consolidation, derivation, hygiene, judgement) that route LLM calls for BRAIN/memory work. The two concepts are orthogonal and serve different use-cases. CLEO's roles were deliberately designed for agentic memory workflows. This spec does NOT propose changing CLEO's roles to match Hermes's auxiliary slot abstraction. The divergence is intentional.

---

### 1.2 CLEO Current State — The Problems

#### 1.2.1 `@cleocode/paths` — The SSoT That Is Not Used

`@cleocode/paths` (`packages/paths/src/`) is the canonical XDG path resolver for CLEO. It uses `env-paths` and provides:

- `getCleoPlatformPaths()` → `{ data, config, cache, log, temp }` — per-platform paths  
- `getCleoHome()` → alias for `.data` (the data dir)  
- `CLEO_HOME` env var overrides `.data`  

Source: `packages/paths/src/platform-paths.ts:32-43` (PlatformPaths interface), `packages/paths/src/cleo-paths.ts:22-36` (resolver binding).

On Linux:
- **data** → `~/.local/share/cleo`  
- **config** → `~/.config/cleo`  
- **cache** → `~/.cache/cleo`  
- **log** → `~/.local/state/cleo`  

The package is imported by `packages/core/src/paths.ts:27` (via `@cleocode/paths`) and by `packages/core/src/system/platform-paths.ts`. The `getCleoHome()` re-export in `core/src/paths.ts:181-183` delegates to `getPlatformPaths().data`.

**The problem**: the LLM layer ignores `@cleocode/paths` entirely. It has its own parallel implementation:

```typescript
// packages/core/src/llm/credentials.ts:160-163
export function cleoHomeDir(): string {
  const xdg = process.env['XDG_DATA_HOME'] ?? join(homedir(), '.local', 'share');
  return join(xdg, 'cleo');
}
```

This duplicates the same XDG logic that `env-paths` already implements in `@cleocode/paths`, but with a subtle difference: it reads `XDG_DATA_HOME` directly instead of going through `env-paths`. It also ignores `CLEO_HOME`. Result: `CLEO_HOME` overrides apply to `getCleoHome()` (used by core paths) but do NOT apply to `cleoHomeDir()` (used by credentials, credentials-store, stable-device-id, rate-limit-guard).

**Users who set `CLEO_HOME`** get split behavior: database and config files resolve to the override, while credentials resolve to the XDG default. This is a silent correctness bug.

The `cleoHomeDir()` function is used at:
- `packages/core/src/llm/credentials.ts:160` (definition), `:167` (globalConfigPath), `:210` (readFlatAnthropicKey), `:483` (storeAnthropicApiKey)  
- `packages/core/src/llm/credentials-store.ts:48` (import), `:216` (credentialsStorePath)  
- `packages/core/src/llm/stable-device-id.ts:22` (import), `:47` (device ID path)  
- `packages/core/src/llm/rate-limit-guard.ts:24` (import), `:74`, `:184`, `:262` (rate-limit state paths)  

All four of these modules should use `getCleoHome()` from `@cleocode/paths` instead.

#### 1.2.2 The 6-Tier Credential Resolver — Current Tiers

Source: `packages/core/src/llm/credentials.ts:1-27` (module docstring) and `:268-358` (implementation).

The current resolver walks these tiers on every call:

| Tier | Source | Code location |
|------|--------|---------------|
| 1 | `options.apiKey` — explicit caller override | `:272-281` |
| 2 | `ENV_VARS[provider]` env var | `:284-288` |
| 3 | `~/.cleo/llm-credentials.json` (cred-file pool) | `:291-309` |
| 4 | `~/.claude/.credentials.json` OAuth (anthropic only) | `:311-316` |
| 4a | `~/.cleo/config.json` → `llm.providers[p].apiKey` | `:319-329` |
| 4b | `~/.local/share/cleo/anthropic-key` legacy flat file | `:330-343` |
| 5 | `.cleo/config.json` → `llm.providers[p].apiKey` | `:345-356` |

Problems with this chain:

1. **No pool seeding**: Tier 3 (`llm-credentials.json`) is a manually-populated pool. Auto-seeding from tier 4 (Claude Code OAuth) into tier 3 does not happen. The two sources are separate, siloed, and invisible to each other. `cleo llm list` shows tier 3 only.

2. **No write-back**: When tier 4 provides an OAuth token and CLEO refreshes it via `/mnt/projects/cleocode/packages/core/src/llm/oauth/pkce.ts`, the refreshed token is NOT written back to `~/.claude/.credentials.json`. CLEO keeps it in memory only. Claude Code sees a stale token.

3. **Tier 5 is a security footgun**: `.cleo/config.json` (project-scoped) can store provider API keys. These files are typically committed to git. Any developer who runs `cleo config set llm.providers.anthropic.apiKey sk-ant-...` in a project directory has just written their API key to a file that may be committed. This tier should be removed.

4. **Tier 4a reads config from the data dir**: `globalConfigPath()` at `:166-168` resolves to `join(cleoHomeDir(), 'config.json')` which is `~/.local/share/cleo/config.json` — the **data** directory, not the **config** directory (`~/.config/cleo/config.json`). XDG says user config belongs in `XDG_CONFIG_HOME`. This is a pre-existing drift that means config and data files are co-mingled in the data dir.

5. **No `is_provider_explicitly_configured` guard**: Unlike Hermes PR #4210, CLEO has no gate before reading `~/.claude/.credentials.json`. Any call to `resolveCredentials('anthropic')` without an explicit key will fall through to tier 4 and use the Claude Code token — even in contexts where this isn't what the user wants.

#### 1.2.3 `credentials-store.ts` — Manual Pool Only

Source: `packages/core/src/llm/credentials-store.ts:1-36`

The module docstring says: "Reference: Hermes `credential_pool.py:32-33` defined the on-disk schema we mirror here." The schema was mirrored but the seeding behavior was not.

`credentials-store.ts` manages `~/.cleo/llm-credentials.json`. It provides:
- `addCredential()` — upsert with file lock + 0600 permissions  
- `removeCredential()` — remove by `(provider, label)`  
- `pickCredentialForProviderSync()` — priority-sorted or round-robin picker  
- `listCredentials()` — list all entries  

What it does NOT have:
- Any seeder that reads `~/.claude/.credentials.json` on load  
- Any seeder that reads `ANTHROPIC_API_KEY` from env into the pool  
- Any write-back mechanism for refreshed tokens  
- Any suppression registry to prevent re-seeding after removal  

The `StoredCredential` type at `:91-171` has a `source?: string` field that is intended for provenance tracking (e.g., `'claude-code'`, `'cli-input'`) but nothing populates it from external sources today.

#### 1.2.4 XDG Drift — Config in the Data Dir

On this system (verified):

```
~/.cleo              → symlink → ~/.local/share/cleo   (data dir)
~/.local/share/cleo/config.json   ← EXISTS (config in data dir)
~/.config/cleo/                   ← EXISTS but EMPTY (only has auth/ subdir)
```

The `config.json` file lives in the data directory (`~/.local/share/cleo/`) instead of the config directory (`~/.config/cleo/`). This is because `globalConfigPath()` in `credentials.ts:166-168` uses `cleoHomeDir()` (data dir) rather than the config dir.

Migration of existing installs is mandatory: any E1 implementation that moves `config.json` to `~/.config/cleo/config.json` without migrating existing files will silently break all users who have global config set.

#### 1.2.5 No `cleo status` — Missing Diagnostic Surface

Hermes has no direct equivalent either, but the credential pool's `hermes auth list` plus `hermes config` give operators a clear picture of what is configured and where. CLEO has:

- `cleo config list` — shows project + global config values  
- `cleo llm list` — shows entries in `~/.cleo/llm-credentials.json` only  
- `cleo memory llm-status` — shows per-provider credential status (added in T9323)  

What CLEO lacks is a unified `cleo status` that shows: identity (who am I logged in as), credential state per provider (sourced from where, expiry, last-used), config summary (which config file is active, which tier overrides which), and harness/project health. This is the `hermes status` / `hermes config` equivalent and is currently absent.

#### 1.2.6 No `cleo setup` Wizard

`cleo config` provides only raw key-value manipulation (`get/set/list/presets/set-preset`). There is no interactive wizard. Users who install CLEO must discover configuration through documentation or trial-and-error. The `cleo llm login anthropic` command exists (`llm-login.ts`) but is isolated to Anthropic; there is no holistic "configure everything" flow.

Verified at `packages/cleo/src/cli/commands/config.ts:1-80` (config command) and `packages/cleo/src/cli/commands/llm-login.ts:1-60` (login command).

#### 1.2.7 No Write-Back for OAuth Token Refresh

Verified by grep: `grep "writeFileSync.*\.credentials\.json" packages/core/src/llm/ -r` returns zero hits.

When CLEO refreshes an Anthropic OAuth token (via `packages/core/src/llm/oauth/pkce.ts`), the new token is stored in the pool (tier 3) but NOT written back to `~/.claude/.credentials.json`. This means:
- Claude Code sees a stale token after CLEO refreshes  
- If the user restarts CLEO, it re-reads the stale Claude Code file and gets a token that may be revoked  

This is the inverse of Hermes's cooperative co-ownership. Hermes writes back to `~/.claude/.credentials.json` on every refresh (source: `anthropic_adapter.py:871-913`).

#### 1.2.8 Studio — No Credential UI

`packages/studio/` (SvelteKit dashboard) has routes: `api/`, `brain/`, `code/`, `+layout.server.ts`, `+layout.svelte`, `+page.server.ts`, `+page.svelte`, `projects/`, `tasks/`.

There is no `keys/` route, no `setup/` route, no credential management UI. The Studio does not expose credential configuration to the user in any form.

#### 1.2.9 `cleo llm login` — Anthropic-Only MVP

Source: `packages/cleo/src/cli/commands/llm-login.ts:38-57`

`cleo llm login` supports only `anthropic` (PKCE) and `kimi-code` (device-code). There is no mechanism to:
- Import credentials from Codex CLI  
- Import credentials from gemini-cli  
- Configure env-seeded providers  
- View or remove auto-seeded credentials  

---

### 1.3 Gap Summary

| Dimension | Hermes | CLEO today | Required state |
|-----------|--------|-----------|----------------|
| Path SSoT | `~/.hermes/` flat dir | `@cleocode/paths` exists but LLM layer uses `cleoHomeDir()` bypass | All path resolution through `@cleocode/paths` |
| Config location | `~/.hermes/config.yaml` | `config.json` in data dir (XDG drift) | `config.json` in config dir per XDG |
| Secret segregation | `.env` for secrets, `config.yaml` for settings | Secrets can land in project `.cleo/config.json` (tier 5) | No secrets in project config |
| Credential pool | Multi-entry pool with source tagging | Pool exists (llm-credentials.json) but not seeded from external sources | Pool seeded from claude-creds, env, partner CLIs |
| Credential visibility | `hermes auth list` shows ALL sources | `cleo llm list` shows pool file only | Unified list showing all sources |
| Write-back on refresh | Writes back to `~/.claude/.credentials.json` | Never writes back | Write-back on refresh (with owner decision — see §2) |
| RemovalStep registry | Unified, per-source | None — removal leaves re-seeding gap | RemovalStep equivalent for each seeder |
| Setup wizard | 5 modular sections | None | `cleo setup` with modular sections |
| Status surface | `hermes config` / `hermes auth list` | None (scattered across 3 commands) | `cleo status` unified diagnostic |
| Studio credential UI | Web dashboard Keys page | None | Studio /keys and /setup routes |

---

## 2. Consensus

### 2.1 Decided — Path Resolution

**Decision**: `cleoHomeDir()` in `packages/core/src/llm/credentials.ts` MUST be replaced with `getCleoHome()` from `@cleocode/paths`. Every other call site (`credentials-store.ts`, `stable-device-id.ts`, `rate-limit-guard.ts`) follows the same replacement.

Rationale: `cleoHomeDir()` duplicates `env-paths` logic without supporting `CLEO_HOME`. The existing `@cleocode/paths` package is already the SSoT. The duplication is an artifact of the credentials module being written before the paths package was finalized.

**Decision**: `globalConfigPath()` MUST be moved to the config dir (`getCleoPlatformPaths().config`), not the data dir.

Rationale: XDG mandates this. Non-secret configuration (not credentials) belongs in `XDG_CONFIG_HOME`. Current behavior (`config.json` in data dir) violates XDG and comingles config with runtime data.

**Migration**: Mandatory. Any user with `~/.local/share/cleo/config.json` must have it migrated to `~/.config/cleo/config.json` on first run after upgrade. The migration MUST be idempotent, backup-first, and atomic.

### 2.2 Decided — Credential Pool Architecture

**Decision**: Replace the 6-tier resolver with a **pool-first architecture** where `resolveCredentials()` becomes a thin wrapper over the pool. The pool is seeded at startup (or lazily on first resolve) from typed source seeders.

Rationale: The current tier walk is done on every resolve call (no caching, no pooling). Each tier is an independent filesystem read. The pool architecture concentrates reads at load time, provides a single source of truth for "what credentials are available," and makes the credential list visible in `cleo llm list`.

**Decision**: Tier 5 (project-config secrets) MUST be removed. API keys must not be stored in project-scoped config files.

Rationale: Project config files are often committed to git. The `no-secrets-in-project-config` rule is a hard security requirement. Users who had secrets in tier 5 MUST be warned and prompted to move them to the pool via a migration CLI step.

**Decision**: Auto-seeding from `~/.claude/.credentials.json` MUST be gated behind an explicit user consent check, analogous to Hermes PR #4210.

Rationale: Reading another tool's credential file without explicit user consent is a privacy boundary violation. The consent check should verify that the user has explicitly configured `anthropic` as their provider (e.g., via `cleo llm login anthropic` or `cleo llm add anthropic ...`).

**Decision**: The `RemovalStep` registry pattern from `credential_sources.py` MUST be implemented for every seeder. Removal without suppression causes invisible re-seeding.

### 2.3 Open Question — Write-Back to `~/.claude/.credentials.json`

**Question**: Should CLEO write refreshed Anthropic OAuth tokens back to `~/.claude/.credentials.json` (cooperative co-ownership), or should CLEO maintain its own OAuth token copy without touching Claude Code's file?

**Arguments for write-back**:
- Users benefit: they log in once via either tool, both stay current  
- Hermes already does this (PR #4210 precedent); the behavior is well-understood  
- Without write-back, a CLEO-refreshed token is invisible to Claude Code  

**Arguments against write-back**:
- `~/.claude/.credentials.json` is owned by Anthropic's Claude Code; writing to another tool's file is a layering violation  
- A bug in CLEO's write path could corrupt Claude Code's auth state  
- Future changes to Claude Code's file format could silently break CLEO's write-back  
- CLEO could maintain its own separate `anthropic-oauth.json` under `getCleoPlatformPaths().data` and be fully self-contained  

**Recommendation**: Implement write-back behind a user-configured opt-in flag (`auth.cooperativeWriteBack: true` in global config), defaulting to `true` for consistency with Hermes behavior. Flag it HITL before shipping.

**HITL required**: Owner must decide before E2 implementation begins.

### 2.4 Decided — Seeder Sources for E2

The following external sources MUST be implemented as seeders in E2:

| Seeder | External file | Provider | Priority |
|--------|---------------|----------|----------|
| `claude-code` | `~/.claude/.credentials.json` | `anthropic` | 3 (after env, after PKCE) |
| `env` | `process.env[ENV_VARS[provider]]` | all | 2 |
| `cleo-pkce` | `{getCleoPlatformPaths().data}/anthropic-oauth.json` | `anthropic` | 2 |
| `codex-cli` | `~/.codex/auth.json` (to verify path) | `openai` | 4 |
| `gemini-cli` | `~/.gemini/credentials.json` (to verify path) | `gemini` | 4 |
| `gh-cli` | `gh auth token` subprocess | `openai` (Copilot) | 4 |
| `manual` | `{getCleoPlatformPaths().data}/llm-credentials.json` | all | 1 |

NOTE: The external file paths for `codex-cli` and `gemini-cli` must be verified against the actual CLIs before implementation. They are listed here as placeholders based on the Hermes PROVIDER_REGISTRY declarations.

### 2.5 Decided — Setup Wizard Scope

`cleo setup` MUST cover more than just LLM configuration. The wizard sections:

1. **LLM** — provider selection, model selection, credential entry or OAuth flow  
2. **Identity** — CLEO agent identity (SOUL equivalent)  
3. **Harness** — Pi or Claude Code adapter selection  
4. **Sentient** — enable/disable daemon, configure Tier-2 proposals  
5. **Project conventions** — strictness preset, session notes policy  
6. **BRAIN** — memory bridge mode, memory retention settings  

Each section MUST be independently runnable (`cleo setup --section llm`).

### 2.6 Decided — `cleo status` Scope

`cleo status` (top-level, not a subcommand of another group) MUST show:

1. **Identity** — current user / agent identity, login state  
2. **Credentials** — per-provider: source, expiry, last-used, OK/warn/error  
3. **Config** — active config file path, which tiers are set, any secret-in-wrong-place warnings  
4. **Session** — current session state (active/idle), focused task  
5. **Harness** — active harness, harness health  
6. **Daemon** — sentient daemon status (running/stopped, last tick)  

### 2.7 Decided — Migration Strategy

Three migration scenarios must be handled:

1. **Config file in data dir** → move to config dir (E1)  
2. **Secrets in project config** → warn + emit migration command (E2)  
3. **Legacy flat file `anthropic-key`** → import to pool (E1, already partial via tier 4b)  

All migrations MUST:
- Run on first CLEO command after upgrade, not on install  
- Back up the original file before moving/changing it  
- Be idempotent (safe to run multiple times)  
- Report what was migrated in human-readable output  
- Write migration completion marker to prevent repeated runs  

### 2.8 Divergence from Hermes — Deliberate

The following Hermes patterns are explicitly NOT adopted:

- **Hermes `~/.hermes/` flat layout** → CLEO uses XDG dirs via `@cleocode/paths`. The separation of config/data/cache is intentional and cross-platform.  
- **Hermes auxiliary model slots** → CLEO's role-based routing (extraction/consolidation/derivation/hygiene/judgement) serves different purposes. No change to CLEO roles.  
- **Hermes `oauth_external` for Gemini/Codex** → Partial adoption. CLEO should seed from these CLIs' files (when installed) but the `oauth_external` auth type label is Hermes-specific. CLEO's seeder will use `source: 'codex-cli'` etc.  

---

## 3. Architecture

### 3.1 File Layout (Post-E1 + E2)

All paths use `@cleocode/paths` helpers. No literal `~/.cleo` or `~/.local/share/cleo` in the proposed architecture.

```
getCleoPlatformPaths().config/          ← XDG_CONFIG_HOME/cleo (~/.config/cleo on Linux)
├── config.json                         ← Non-secret global config (MOVED from data dir)
├── auth/                               ← Currently exists (auth state)
└── (no credentials here)              ← Secrets never in config dir

getCleoPlatformPaths().data/            ← XDG_DATA_HOME/cleo (~/.local/share/cleo on Linux)
├── llm-credentials.json               ← Multi-source credential pool (pool file)
├── anthropic-oauth.json               ← CLEO's own PKCE OAuth state (new, separate from claude)
├── device-id                          ← Stable device ID
├── rate-limit-state/                  ← Per-credential rate limit state
├── templates/                         ← CLEO-INJECTION.md etc.
├── agents/                            ← Agent config
├── brain.db                           ← BRAIN memory DB
├── nexus/                             ← GitNexus index
├── locks/                             ← File locks
└── (no config.json — moved to config/)

getCleoPlatformPaths().cache/           ← XDG_CACHE_HOME/cleo (~/.cache/cleo on Linux)
└── llm-catalog/                       ← Provider model catalog cache

getCleoPlatformPaths().log/             ← XDG state dir (~/.local/state/cleo on Linux)
└── (logs)
```

### 3.2 Module Layout

#### 3.2.1 `packages/core/src/llm/` — Reorganized

```
packages/core/src/llm/
├── credentials.ts              ← MODIFIED: remove cleoHomeDir(), use getCleoHome()
├── credentials-store.ts        ← MODIFIED: remove cleoHomeDir() import, add seeder wiring
├── credential-pool.ts          ← NEW: CredentialPool class (thin runtime wrapper)
├── credential-seeders/         ← NEW directory
│   ├── index.ts                ← exports SeederRegistry
│   ├── env-seeder.ts           ← reads ENV_VARS[provider] for all providers
│   ├── claude-code-seeder.ts   ← reads ~/.claude/.credentials.json
│   ├── cleo-pkce-seeder.ts     ← reads cleo's own anthropic-oauth.json
│   ├── codex-cli-seeder.ts     ← reads ~/.codex/auth.json (openai)
│   ├── gemini-cli-seeder.ts    ← reads ~/.gemini/credentials.json
│   ├── gh-cli-seeder.ts        ← runs `gh auth token` subprocess (copilot)
│   └── manual-seeder.ts        ← reads llm-credentials.json (existing store)
├── credential-removal.ts       ← NEW: RemovalStep registry (ported from credential_sources.py)
├── credential-writeback.ts     ← NEW: write-back handler (gate behind config flag)
├── stable-device-id.ts         ← MODIFIED: use getCleoHome() not cleoHomeDir()
├── rate-limit-guard.ts         ← MODIFIED: use getCleoHome() not cleoHomeDir()
└── (other existing files unchanged)
```

#### 3.2.2 `packages/core/src/config/` — Migration Handler

```
packages/core/src/config/
├── migration.ts                ← NEW: config migration runner
│   - migrateConfigFromDataToConfigDir()
│   - migrateSecretsFromProjectConfig()
│   - importLegacyFlatKey()
│   - isMigrationComplete()
│   - markMigrationComplete()
└── (existing config files)
```

#### 3.2.3 `packages/cleo/src/cli/commands/` — New Commands

```
packages/cleo/src/cli/commands/
├── setup.ts                    ← NEW: cleo setup wizard
├── status.ts                   ← NEW: cleo status diagnostic
├── auth.ts                     ← NEW: cleo auth subcommand group (list, remove)
└── (existing commands modified)
```

#### 3.2.4 `packages/studio/src/routes/` — New Pages

```
packages/studio/src/routes/
├── keys/
│   ├── +page.svelte            ← NEW: credential management UI
│   └── +page.server.ts         ← NEW: server-side credential API
└── setup/
    ├── +page.svelte            ← NEW: setup wizard web UI
    └── +page.server.ts         ← NEW: server-side setup state
```

### 3.3 TypeScript Interface Drafts

#### 3.3.1 `CredentialSeeder` Interface

```typescript
// packages/core/src/llm/credential-seeders/index.ts

export type SeederSourceId =
  | 'manual'
  | 'env'
  | 'cleo-pkce'
  | 'claude-code'
  | 'codex-cli'
  | 'gemini-cli'
  | 'gh-cli';

export interface SeederResult {
  /** Provider this entry is for. */
  provider: ModelTransport;
  /** Unique source identifier. Used as the `source` field in StoredCredential. */
  source: SeederSourceId;
  /** Bearer token or API key. */
  accessToken: string;
  /** OAuth refresh token, if available. */
  refreshToken?: string;
  /** Unix epoch ms for expiry, if known. */
  expiresAt?: number | null;
  /** Authentication scheme. */
  authType: StoredAuthType;
  /** Base URL override, if the source specifies one. */
  baseUrl?: string;
  /** Human-readable label for pool display. */
  label: string;
  /** Priority within the pool (lower = higher priority). */
  priority: number;
}

export interface CredentialSeeder {
  /**
   * Identifier for this seeder.
   */
  readonly sourceId: SeederSourceId;

  /**
   * Providers this seeder can seed credentials for.
   * `['*']` means "any provider".
   */
  readonly providers: ModelTransport[] | ['*'];

  /**
   * Whether user consent has been established for this provider.
   * Seeders that read external tool files (claude-code, codex-cli, etc.)
   * MUST return false when the user has not explicitly configured this
   * provider in CLEO.
   */
  isConsentEstablished(provider: ModelTransport): boolean;

  /**
   * Attempt to seed credentials for the given provider.
   * Returns null when the source is unavailable or not applicable.
   * MUST NOT throw — all errors caught internally.
   */
  seed(provider: ModelTransport): Promise<SeederResult | null>;
}
```

#### 3.3.2 `RemovalStep` Interface (TypeScript port)

```typescript
// packages/core/src/llm/credential-removal.ts

export interface RemovalResult {
  /** Descriptions of state that was actually mutated. */
  cleaned: string[];
  /**
   * Diagnostic lines about state the user may need to clean up
   * manually (shell env vars, external files not deleted, etc.).
   */
  hints: string[];
  /**
   * Whether to suppress this (provider, source) pair in the pool
   * on future re-seeding. Default true. False only for 'manual' entries
   * that were never auto-seeded.
   */
  suppress: boolean;
}

export interface RemovalStep {
  /** Pool key for the provider, or '*' for any. */
  provider: ModelTransport | '*';
  /** Source ID as appears in StoredCredential.source. */
  sourceId: SeederSourceId;
  /** Optional predicate for prefix-match sources (env:* etc). */
  matchFn?: (source: string) => boolean;
  /** The removal handler. Never throws. */
  removeFn: (provider: ModelTransport, entry: StoredCredential) => Promise<RemovalResult>;
  description: string;
}

export class RemovalRegistry {
  private steps: RemovalStep[] = [];

  register(step: RemovalStep): void { this.steps.push(step); }

  find(provider: ModelTransport, source: string): RemovalStep | null {
    return this.steps.find(s =>
      (s.provider === '*' || s.provider === provider) &&
      (s.matchFn ? s.matchFn(source) : s.sourceId === source)
    ) ?? null;
  }
}

export const REMOVAL_REGISTRY = new RemovalRegistry();
```

#### 3.3.3 `CredentialPool` Runtime Class

```typescript
// packages/core/src/llm/credential-pool.ts

export interface PoolLoadOptions {
  /** Force re-seed even if pool was recently seeded. */
  force?: boolean;
  /** Only seed from these sources. */
  sources?: SeederSourceId[];
}

export class CredentialPool {
  private seeders: CredentialSeeder[];
  private lastSeedAt: number = 0;
  private readonly SEED_TTL_MS = 60_000; // 1 minute cache

  constructor(seeders: CredentialSeeder[]) {
    this.seeders = seeders;
  }

  /**
   * Seed the pool from all registered seeders.
   * Skips if seeded within SEED_TTL_MS unless force=true.
   */
  async seed(opts: PoolLoadOptions = {}): Promise<void>;

  /**
   * Pick the best credential for a provider.
   * Triggers seed if pool is empty or stale.
   */
  async pick(
    provider: ModelTransport,
    opts?: { strategy?: CredentialsStoreStrategy; preferLabel?: string },
  ): Promise<StoredCredential | null>;

  /**
   * List all pool entries, optionally filtered by provider.
   * Includes auto-seeded entries from all sources.
   */
  async list(provider?: ModelTransport): Promise<StoredCredential[]>;

  /**
   * Remove an entry and invoke its RemovalStep.
   */
  async remove(provider: ModelTransport, label: string): Promise<RemovalResult>;

  /**
   * Write back refreshed tokens to their originating source files,
   * if write-back is enabled in config.
   */
  async writeBack(entry: StoredCredential, refreshed: { accessToken: string; refreshToken?: string; expiresAt?: number }): Promise<void>;
}
```

#### 3.3.4 Pool-Aware `resolveCredentials()` — Revised Signature

After E2, `resolveCredentials()` delegates to the pool for tiers 2-5 and keeps tier 1 (explicit override) as a pass-through:

```typescript
// packages/core/src/llm/credentials.ts (revised)

export async function resolveCredentials(
  provider: ModelTransport,
  options: CredentialResolveOptions = {},
): Promise<CredentialResult> {
  // Tier 1: explicit override (no pool involvement)
  if (options.apiKey?.trim()) { ... }

  // Tier 2+: pool pick (pool has already been seeded from all sources)
  const entry = await getCredentialPool().pick(provider, options);
  if (entry) {
    return { provider, apiKey: entry.accessToken, source: 'cred-file', authType: entry.authType === 'oauth' ? 'oauth' : 'api_key' };
  }

  return { provider, apiKey: null, source: undefined, authType: 'api_key' };
}
```

Note: A sync shim (`resolveCredentials` sync variant) must be maintained for call-sites that cannot be made async in one pass. The sync path reads from the on-disk pool only (no re-seeding). The async path seeds first.

#### 3.3.5 `SetupWizard` Interface

```typescript
// packages/core/src/setup/wizard.ts

export type WizardSection =
  | 'llm'
  | 'identity'
  | 'harness'
  | 'sentient'
  | 'project-conventions'
  | 'brain';

export interface WizardSectionRunner {
  section: WizardSection;
  title: string;
  /** Can this section be skipped without losing functionality? */
  optional: boolean;
  /**
   * Run the interactive section. Returns true if any changes were made.
   * Receives a readline-compatible I/O context.
   */
  run(io: WizardIO): Promise<boolean>;
}

export interface WizardIO {
  prompt(question: string): Promise<string>;
  confirm(question: string, defaultValue?: boolean): Promise<boolean>;
  select<T extends string>(question: string, options: T[]): Promise<T>;
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}
```

#### 3.3.6 `CleoStatus` Interface (for `cleo status`)

```typescript
// packages/core/src/status/index.ts

export interface CredentialStatusEntry {
  provider: ModelTransport;
  source: SeederSourceId | 'none';
  hasCredential: boolean;
  authType?: StoredAuthType;
  expiresAt?: number | null;
  isExpired?: boolean;
  lastStatus?: 'ok' | 'exhausted' | 'invalid';
  label?: string;
}

export interface CleoStatus {
  identity: {
    agentId: string | null;
    loggedIn: boolean;
    identityFile: string | null;
  };
  credentials: CredentialStatusEntry[];
  config: {
    globalConfigPath: string;
    projectConfigPath: string | null;
    activeConfigPath: string;
    hasSecretsInProjectConfig: boolean;
    secretsWarnings: string[];
  };
  session: {
    active: boolean;
    sessionId: string | null;
    focusedTask: string | null;
  };
  harness: {
    active: 'pi' | 'claude-code' | 'unknown';
    healthy: boolean;
    issues: string[];
  };
  daemon: {
    running: boolean;
    pid: number | null;
    lastTickAt: number | null;
    killSwitchActive: boolean;
  };
}
```

### 3.4 Migration Strategy (Detailed)

#### Phase 1 Migration (E1)

Migration is triggered on the first CLEO command after upgrade, via a bootstrap hook in `packages/core/src/bootstrap.ts`.

```
Migration 1: config.json from data dir to config dir
  Source: getCleoPlatformPaths().data + '/config.json'
  Target: getCleoPlatformPaths().config + '/config.json'
  Steps:
    1. Check if source exists AND target does not exist
    2. If source has content: copy to target (do not move — allow rollback)
    3. Verify target is parseable JSON
    4. If verified: write migration marker to getCleoPlatformPaths().data + '/.migrations/config-dir-v1.done'
    5. The old file at source is kept as backup: source + '.pre-e1-bak'
    6. On next read, resolver prefers target (config dir) over source (data dir)

Migration 2: legacy anthropic-key flat file → pool entry
  Source: getCleoPlatformPaths().data + '/anthropic-key'
  Steps:
    1. Read key from source
    2. If exists: call addCredential({ provider: 'anthropic', label: 'legacy-flat-key', authType: 'api_key', accessToken: key, source: 'manual', priority: 100 })
    3. Write migration marker: getCleoPlatformPaths().data + '/.migrations/flat-key-v1.done'
    4. Keep source as backup: source + '.pre-e1-bak'
```

#### Phase 2 Migration (E2)

```
Migration 3: secrets in project config → warning + manual migration prompt
  Steps:
    1. On every `cleo` invocation, scan .cleo/config.json for llm.providers.*.apiKey
    2. If found: emit warning to stderr with migration command
       "Warning: API key found in .cleo/config.json. This file may be committed to git.
        Run: cleo auth migrate-project-secrets to move these to the credential pool."
    3. cleo auth migrate-project-secrets:
       a. Read all llm.providers.*.apiKey from .cleo/config.json
       b. Call addCredential() for each
       c. Remove the apiKey fields from .cleo/config.json
       d. Confirm with the user before step c
```

### 3.5 Public API Surface

#### E1 Public API Changes

```typescript
// packages/paths/src/cleo-paths.ts — no change (already correct)

// packages/core/src/llm/credentials.ts — replacements
// REMOVED: export function cleoHomeDir(): string
// ADDED (re-export from @cleocode/paths): getCleoHome, getCleoPlatformPaths

// packages/core/src/llm/credentials-store.ts — path fix only
// credentialsStorePath() now returns: join(getCleoHome(), 'llm-credentials.json')
// (behavior unchanged: still data dir, only the source of truth changes)
```

#### E2 Public API Changes

```typescript
// packages/core/src/llm/credential-pool.ts — NEW
export { CredentialPool, getCredentialPool } from './credential-pool.js';

// packages/core/src/llm/credential-seeders/index.ts — NEW
export { SeederRegistry, registerSeeder, BUILTIN_SEEDERS } from './credential-seeders/index.js';

// packages/core/src/llm/credential-removal.ts — NEW
export { RemovalRegistry, REMOVAL_REGISTRY } from './credential-removal.js';

// packages/core/src/llm/credentials.ts — modified
// resolveCredentials() gains async overload; sync variant retained for BC
```

#### E3 Public API Changes

```typescript
// packages/core/src/setup/wizard.ts — NEW
export { WizardRunner, runSetupWizard, runWizardSection } from './wizard.js';

// packages/core/src/status/index.ts — NEW
export { getCleoStatus } from './index.js';
```

---

## 4. Specification

### 4.1 Epic E1 — Path SSoT Enforcement

#### 4.1.1 Normative Requirements

**E1-MUST-001**: All path resolution in `packages/core/src/llm/credentials.ts` MUST use `getCleoHome()` from `@cleocode/paths` (via `packages/core/src/paths.ts` re-export). The private `cleoHomeDir()` function MUST be removed.

**E1-MUST-002**: `packages/core/src/llm/credentials-store.ts` MUST NOT import `cleoHomeDir` from `credentials.ts`. It MUST resolve the credentials store path using `getCleoHome()` from `@cleocode/paths`.

**E1-MUST-003**: `packages/core/src/llm/stable-device-id.ts` MUST use `getCleoHome()` from `@cleocode/paths` for all path resolution.

**E1-MUST-004**: `packages/core/src/llm/rate-limit-guard.ts` MUST use `getCleoHome()` from `@cleocode/paths` for all rate-limit state path resolution.

**E1-MUST-005**: The global CLEO config file (`config.json`) MUST reside in `getCleoPlatformPaths().config` (the XDG config dir), not in `getCleoPlatformPaths().data`. The `globalConfigPath()` function MUST be updated accordingly.

**E1-MUST-006**: On the first `cleo` invocation after upgrade, if `config.json` exists in the data dir and does NOT exist in the config dir, the migration MUST automatically copy the file to the config dir. The migration MUST write a marker file to prevent re-running.

**E1-MUST-007**: The migration MUST be atomic: copy to temp file, verify JSON parse, then rename. If the copy fails, the old location MUST continue to work (backward compat read from both locations during transition).

**E1-MUST-008**: The migration MUST produce human-readable output to stderr on first run: "Migrating CLEO config: {source} → {target}" and "Migration complete." or "Migration failed: {reason} — using {source}".

**E1-MUST-009**: After E1 ships, all new CLEO installs MUST write `config.json` to the config dir only.

**E1-MUST-010**: The `CLEO_HOME` env var MUST be honored by all path resolution in the LLM layer. Specifically, `CLEO_HOME` MUST override `getCleoPlatformPaths().data`, and this override MUST propagate to `credentialsStorePath()`, device ID path, and rate-limit state paths.

**E1-SHOULD-011**: The `XDG_DATA_HOME` and `XDG_CONFIG_HOME` env vars SHOULD be honored for users who set them outside of `CLEO_HOME`. (`env-paths` already handles this; this requirement ensures no bypass exists in CLEO code.)

**E1-MUST-012**: The existing test suite MUST continue to pass after E1 changes. Any test that uses `cleoHomeDir()` directly MUST be updated to use the equivalent `getCleoHome()` call.

**E1-MUST-013**: `pnpm biome check --write .` and `pnpm run build` and `pnpm run test` MUST all pass green before E1 is marked complete.

#### 4.1.2 Verification Criteria

- `grep -r "cleoHomeDir" packages/core/src/ --include="*.ts"` returns zero hits.  
- `grep -r "XDG_DATA_HOME" packages/core/src/llm/ --include="*.ts"` returns zero hits.  
- Setting `CLEO_HOME=/tmp/test-cleo cleo config list` resolves config from `/tmp/test-cleo/`.  
- On a fresh system with no prior CLEO install, `config.json` is written to `getCleoPlatformPaths().config`.  
- On a system with `~/.local/share/cleo/config.json` (pre-E1), first `cleo` run outputs migration message and creates `~/.config/cleo/config.json`.  

---

### 4.2 Epic E2 — Unified Credential Pool with Multi-Source Seeders

#### 4.2.1 Core Pool Requirements

**E2-MUST-001**: A `CredentialPool` class MUST exist in `packages/core/src/llm/credential-pool.ts`. It MUST be the single runtime instance used by `resolveCredentials()`.

**E2-MUST-002**: The pool MUST support seeding from the following sources at minimum: `env`, `claude-code`, `cleo-pkce`, `manual`. Each source MUST be implemented as a typed `CredentialSeeder` conforming to the interface in §3.3.1.

**E2-MUST-003**: Pool entries MUST carry a `source` field identifying which seeder populated them.

**E2-MUST-004**: `cleo llm list` (or `cleo auth list`) MUST display ALL pool entries from ALL sources, not only the manual pool file. Each entry MUST show its `source` label.

**E2-MUST-005**: Pool seeding MUST be cached for at least 60 seconds. Seeding MUST NOT happen on every `resolveCredentials()` call.

**E2-MUST-006**: The pool MUST be seeded lazily (on first call to `pick()`) if not already seeded.

**E2-MUST-007**: Seeder errors MUST be caught and logged at DEBUG level. A seeder failure MUST NOT cause `resolveCredentials()` to throw — it should simply contribute zero entries from that source.

**E2-MUST-008**: The `claude-code` seeder MUST NOT run unless `isConsentEstablished('anthropic')` returns true. Consent is established when the user has run `cleo llm login anthropic` or `cleo llm add anthropic ...`.

**E2-MUST-009**: The `env` seeder MUST read from `process.env[ENV_VARS[provider]]` for all providers. Entries seeded from env MUST have `source: 'env'` and label `'env:PROVIDER_KEY_VAR'`.

**E2-MUST-010**: Tier 5 (project-config secrets) MUST be removed from `resolveCredentials()`. Any API key in `.cleo/config.json` MUST generate a stderr warning but MUST NOT be used as a credential. Removal of this tier MUST be gated on the migration warning being implemented first (see E2-MUST-023).

**E2-MUST-011**: The `RemovalStep` registry MUST be implemented in `packages/core/src/llm/credential-removal.ts`. Every seeder MUST have a corresponding `RemovalStep` registered.

**E2-MUST-012**: `cleo auth remove <provider> <label>` MUST invoke the matching `RemovalStep`. The entry MUST be suppressed from re-seeding on subsequent pool loads.

**E2-MUST-013**: Suppression state MUST be persisted across process restarts. Suppressed `(provider, sourceId)` pairs MUST be stored in a file under `getCleoPlatformPaths().data` (e.g., `auth-suppression.json`).

#### 4.2.2 External Seeder Requirements

**E2-MUST-014**: The `claude-code` seeder MUST read `~/.claude/.credentials.json` using the existing `parseClaudeCodeCredentials` function from `@cleocode/contracts`. It MUST extract `accessToken`, `refreshToken`, and `expiresAt` from `claudeAiOauth`.

**E2-MUST-015**: The `claude-code` seeder MUST skip seeding and return null when the token is expired.

**E2-MUST-016**: The `cleo-pkce` seeder MUST read from `getCleoPlatformPaths().data + '/anthropic-oauth.json'`. The file format MUST be the same `claudeAiOauth` shape as `~/.claude/.credentials.json` for compatibility.

**E2-MUST-017**: When CLEO refreshes an Anthropic OAuth token, the refreshed token MUST be written to `getCleoPlatformPaths().data + '/anthropic-oauth.json'` (CLEO's own OAuth file). Whether to ALSO write back to `~/.claude/.credentials.json` is controlled by the `auth.cooperativeWriteBack` config flag (owner decision required — see §2.3).

**E2-SHOULD-018**: The `codex-cli` seeder SHOULD be implemented if the Codex CLI OAuth file path can be verified. It SHOULD read `~/.codex/auth.json` (path to be confirmed against actual Codex CLI behavior). It SHOULD be skipped silently when the file does not exist.

**E2-SHOULD-019**: The `gemini-cli` seeder SHOULD be implemented if the gemini-cli credential file path can be verified. It SHOULD be skipped silently when the file does not exist.

**E2-SHOULD-020**: The `gh-cli` seeder SHOULD implement GitHub Copilot credential seeding via `gh auth token` subprocess for the `openai` transport. It SHOULD handle the subprocess failing gracefully (gh not installed, not logged in).

**E2-MAY-021**: Additional seeders (e.g., for qwen-cli) MAY be added in subsequent tasks after E2 core ships.

#### 4.2.3 Migration and Footgun Removal

**E2-MUST-022**: The legacy `storeAnthropicApiKey()` function that writes to `anthropic-key` flat file MUST be deprecated. Any callers MUST be updated to use `addCredential()` instead.

**E2-MUST-023**: Before tier 5 is removed, CLEO MUST implement a migration warning: when `.cleo/config.json` contains `llm.providers.*.apiKey`, every `cleo` invocation MUST emit a stderr warning describing the security risk and providing the migration command.

**E2-MUST-024**: `cleo auth migrate-project-secrets` MUST exist and move API keys from `.cleo/config.json` to the credential pool, removing them from the project config file. It MUST prompt for confirmation before modifying the project config file.

**E2-MUST-025**: After E2, the integration test for tier 5 credentials MUST be updated to verify that project-config API keys emit a warning, not that they work silently.

#### 4.2.4 Quality and Security

**E2-MUST-026**: All seeder reads of third-party credential files MUST be wrapped in try-catch. Filesystem errors MUST be logged at DEBUG level and treated as "source unavailable."

**E2-MUST-027**: The credential pool MUST maintain 0600 file permissions on `llm-credentials.json` through all write operations (existing behavior, must not regress).

**E2-MUST-028**: `pnpm biome check --write .`, `pnpm run build`, and `pnpm run test` MUST all pass green before E2 is marked complete.

**E2-MUST-029**: New seeder tests MUST cover: successful seed, file-not-found (graceful), expired token (skipped), suppressed source (skipped), consent not established (skipped).

#### 4.2.5 Verification Criteria

- `cleo llm list` (or `cleo auth list`) shows an entry with `source: claude-code` when `~/.claude/.credentials.json` exists, is valid, and anthropic is consent-established.  
- `cleo auth remove anthropic <label>` where `<label>` is the claude-code entry: subsequent `cleo llm list` does NOT show it.  
- After removal + process restart: the claude-code entry does NOT re-appear in `cleo llm list` (suppression is durable).  
- `resolveCredentials('anthropic')` succeeds when only `~/.claude/.credentials.json` is present and anthropic is consent-established.  
- Secrets in `.cleo/config.json` produce a warning on every `cleo` command.  
- `grep -r "project-config" packages/core/src/llm/ --include="*.ts"` returns zero hits after tier 5 removal (except in the migration warning code).  

---

### 4.3 Epic E3 — Setup Wizard, Status Surface, and Studio Keys UI

#### 4.3.1 `cleo setup` Wizard Requirements

**E3-MUST-001**: `cleo setup` MUST be a top-level CLI command (not under `cleo config`).

**E3-MUST-002**: `cleo setup` with no arguments MUST run all sections interactively, in the order: LLM → Identity → Harness → Sentient → Project Conventions → BRAIN.

**E3-MUST-003**: `cleo setup --section <name>` MUST run only the named section. Valid section names: `llm`, `identity`, `harness`, `sentient`, `project-conventions`, `brain`.

**E3-MUST-004**: The LLM section MUST support: selecting a provider from the registered provider list, entering an API key (written to the pool, NOT to config), and triggering OAuth login (`cleo llm login <provider>`) for OAuth-capable providers.

**E3-MUST-005**: The LLM section MUST auto-detect already-configured credentials and display their status (source, expiry) rather than prompting for re-configuration.

**E3-MUST-006**: The Identity section MUST allow the user to set their agent identity name and SOUL.md content.

**E3-MUST-007**: The Harness section MUST allow the user to select between Pi and Claude Code adapters.

**E3-MUST-008**: The Sentient section MUST allow enabling/disabling the daemon and enabling/disabling Tier-2 proposals.

**E3-MUST-009**: The Project Conventions section MUST allow applying a strictness preset (`strict`, `standard`, `minimal`).

**E3-MUST-010**: The BRAIN section MUST allow configuring the memory bridge mode.

**E3-MUST-011**: Each section MUST write secrets (API keys) to the credential pool via `addCredential()`. Non-secret settings MUST be written to the global config via `config.set`. No section MUST write secrets to `config.json`.

**E3-MUST-012**: `cleo setup` MUST be runnable non-interactively for CI: `cleo setup --non-interactive --provider anthropic --api-key $ANTHROPIC_API_KEY`. Non-interactive mode MUST only configure explicitly-provided flags, skipping all other sections silently.

**E3-SHOULD-013**: `cleo setup` SHOULD detect when CLEO has never been configured (no config file, no credentials) and prompt the user to run setup on first `cleo` invocation, with the option to skip.

#### 4.3.2 `cleo status` Requirements

**E3-MUST-014**: `cleo status` MUST be a top-level CLI command that outputs a structured summary of CLEO's current state.

**E3-MUST-015**: `cleo status` MUST show: identity block (agent ID, login state), credential block (per provider: source, expiry, ok/warn/error), config block (active config path, any warnings), session block (active session, focused task), harness block (active harness, health), daemon block (running/stopped, last tick).

**E3-MUST-016**: `cleo status --json` MUST output the `CleoStatus` interface (§3.3.6) as JSON.

**E3-MUST-017**: `cleo status` MUST complete in under 2 seconds on a healthy system. It MUST NOT block waiting for network.

**E3-MUST-018**: `cleo status` MUST highlight warnings in the config block when secrets are found in project config.

**E3-MUST-019**: `cleo status` MUST display all credential sources visible in the pool (not only manually-added entries).

#### 4.3.3 Studio Keys UI Requirements

**E3-MUST-020**: A `/keys` route MUST exist in `packages/studio/src/routes/keys/`. It MUST display all credential pool entries grouped by provider.

**E3-MUST-021**: The `/keys` page MUST show for each entry: provider, label, source, auth type, expiry status, and last status (ok/exhausted/invalid).

**E3-MUST-022**: The `/keys` page MUST include an "Add credential" action that opens a form for entering provider, label, and API key. The form MUST write to the credential pool via an API endpoint, never to a config file.

**E3-MUST-023**: The `/keys` page MUST include a "Remove" action per entry that invokes the RemovalStep for that source (via an API endpoint).

**E3-MUST-024**: A `/setup` route MUST exist in `packages/studio/src/routes/setup/`. It MUST provide a guided web-based setup flow equivalent to `cleo setup` sections (at minimum: LLM and Project Conventions).

**E3-SHOULD-025**: The `/setup` page SHOULD use the same section runner logic as the CLI wizard (shared business logic in `packages/core/src/setup/`).

#### 4.3.4 Quality Requirements

**E3-MUST-026**: `pnpm biome check --write .`, `pnpm run build`, and `pnpm run test` MUST all pass green before E3 is marked complete.

**E3-MUST-027**: `cleo setup` MUST have unit tests covering: each section's write behavior, non-interactive flag parsing, section-selection flag, secret routing to pool (not config), non-secret routing to config (not pool).

**E3-MUST-028**: `cleo status` MUST have unit tests covering: JSON output shape, credential source display, config warning display, daemon status display.

**E3-SHOULD-029**: The Studio pages SHOULD have Playwright E2E tests for the key management flow (add, list, remove).

#### 4.3.5 Verification Criteria

- `cleo setup --section llm --non-interactive --provider anthropic --api-key sk-ant-...` adds the key to the pool, NOT to any config file.  
- `cleo status` runs and exits in under 2 seconds.  
- `cleo status --json` validates against the `CleoStatus` TypeScript interface.  
- The Studio `/keys` page loads and displays pool entries from all sources.  
- Removing an entry via the Studio `/keys` page invokes the RemovalStep and suppresses re-seeding.  

---

## 5. Decomposition

Tasks are listed with proposed IDs for reference. Do NOT file these tasks in CLEO yet — the orchestrator will file them after owner review.

### 5.1 Epic E1 — Path SSoT Enforcement

#### T-E1-1: Remove `cleoHomeDir()` from `credentials.ts` — replace with `getCleoHome()`

**Size**: small  
**Dependencies**: none  
**Acceptance criteria**:
- `cleoHomeDir()` function is removed from `packages/core/src/llm/credentials.ts`
- All internal call-sites in `credentials.ts` (`globalConfigPath`, `readFlatAnthropicKey`, `storeAnthropicApiKey`) use `getCleoHome()` from `@cleocode/paths`
- `cleoHomeDir` is no longer exported from `packages/core/src/llm/index.ts` or `packages/core/src/internal.ts`
- `grep -r "cleoHomeDir" packages/core/src/llm/credentials.ts` returns zero hits
- `pnpm run test` passes green
- `CLEO_HOME=/tmp/foo cleo config list` resolves config from `/tmp/foo/`

#### T-E1-2: Remove `cleoHomeDir()` from `credentials-store.ts`, `stable-device-id.ts`, `rate-limit-guard.ts`

**Size**: small  
**Dependencies**: T-E1-1 (or parallel — each module can be updated independently after the export is removed)  
**Acceptance criteria**:
- `credentials-store.ts` imports `getCleoHome` from `@cleocode/paths` (directly or via `packages/core/src/paths.ts`)
- `stable-device-id.ts` uses `getCleoHome()` for all path resolution
- `rate-limit-guard.ts` uses `getCleoHome()` for all path resolution
- `grep -r "cleoHomeDir" packages/core/src/llm/ --include="*.ts"` returns zero hits
- `pnpm run test` passes green

#### T-E1-3: Move `globalConfigPath()` to config dir; implement XDG drift migration

**Size**: medium  
**Dependencies**: T-E1-1  
**Acceptance criteria**:
- `globalConfigPath()` in `credentials.ts` resolves to `getCleoPlatformPaths().config + '/config.json'`
- On first `cleo` command, if `config.json` exists in the data dir and NOT in the config dir: migration runs automatically
- Migration is atomic: temp-file + verify JSON + rename
- Migration writes completion marker to prevent re-running
- Migration outputs human-readable stderr message
- Migration is idempotent: running twice is safe
- The old data-dir `config.json` is renamed to `.pre-e1-bak` (not deleted)
- During the transition window (after migration), the resolver checks BOTH locations for backward compat (config dir wins)
- `pnpm run test` passes green; migration logic has unit tests

#### T-E1-4: Import legacy `anthropic-key` flat file into the pool

**Size**: small  
**Dependencies**: T-E1-1  
**Acceptance criteria**:
- On first `cleo` command, if `getCleoHome() + '/anthropic-key'` exists AND no anthropic entry with label `'legacy-flat-key'` exists in the pool: import the key
- Import uses `addCredential({ provider: 'anthropic', label: 'legacy-flat-key', authType: 'api_key', source: 'manual', priority: 100 })`
- Migration marker prevents re-running
- The original flat file is kept as backup: `anthropic-key.pre-e1-bak`
- `pnpm run test` passes green

#### T-E1-5: Update all E1-affected tests; run quality gates

**Size**: small  
**Dependencies**: T-E1-1, T-E1-2, T-E1-3, T-E1-4  
**Acceptance criteria**:
- All tests that use `cleoHomeDir()` directly are updated to use `getCleoHome()`
- All tests that set `XDG_DATA_HOME` for path isolation also validate `CLEO_HOME` override
- `pnpm biome check --write .` exits 0
- `pnpm run build` exits 0
- `pnpm run test` exits 0 with zero new failures
- `cleo verify T-E1 --gate implemented --evidence "commit:<sha>;files:packages/core/src/llm/credentials.ts,packages/core/src/llm/credentials-store.ts,packages/core/src/llm/stable-device-id.ts,packages/core/src/llm/rate-limit-guard.ts,packages/core/src/config/migration.ts"`

---

### 5.2 Epic E2 — Unified Credential Pool with Multi-Source Seeders

#### T-E2-1: Define `CredentialSeeder` interface and `SeederRegistry`

**Size**: small  
**Dependencies**: T-E1-1 (needs stable `getCleoHome()`)  
**Acceptance criteria**:
- `packages/core/src/llm/credential-seeders/index.ts` exports `CredentialSeeder` interface, `SeederSourceId` type, `SeederResult` interface, and `SeederRegistry` class
- Registry supports `register(seeder)` and `getAll()` methods
- All types exported through `packages/core/src/llm/index.ts`
- Unit tests for registry registration and retrieval
- `pnpm run test` passes green

#### T-E2-2: Implement `env` seeder

**Size**: small  
**Dependencies**: T-E2-1  
**Acceptance criteria**:
- `packages/core/src/llm/credential-seeders/env-seeder.ts` implements `CredentialSeeder` for all `ModelTransport` providers
- Reads from `ENV_VARS[provider]` in `process.env`
- Returns entries tagged `source: 'env'`, label `'env:VAR_NAME'`
- `isConsentEstablished()` returns true for env-seeded sources (no external file)
- Unit tests: env var set → seed returns entry; env var unset → seed returns null; env var for wrong provider → null
- `pnpm run test` passes green

#### T-E2-3: Implement `claude-code` seeder with consent gate

**Size**: small  
**Dependencies**: T-E2-1  
**Acceptance criteria**:
- `packages/core/src/llm/credential-seeders/claude-code-seeder.ts` implements `CredentialSeeder` for `anthropic`
- Reads `~/.claude/.credentials.json` via `parseClaudeCodeCredentials` from `@cleocode/contracts`
- `isConsentEstablished('anthropic')` checks for a persisted consent flag (e.g., `auth.claudeCodeConsentGiven: true` in global config, set by `cleo llm login anthropic` or explicit user opt-in)
- Expired tokens → null
- Consent not given → null (does NOT read the file)
- Unit tests: valid file + consent → entry; valid file + no consent → null; missing file → null; expired token → null
- `pnpm run test` passes green

#### T-E2-4: Implement `cleo-pkce` seeder and write-back handler

**Size**: medium  
**Dependencies**: T-E2-1, T-E2-3  
**Acceptance criteria**:
- `packages/core/src/llm/credential-seeders/cleo-pkce-seeder.ts` reads `getCleoHome() + '/anthropic-oauth.json'`
- File format matches `claudeAiOauth` shape from `parseClaudeCodeCredentials`
- When `cleo llm login anthropic` completes PKCE flow: refreshed token is written to `getCleoHome() + '/anthropic-oauth.json'`
- `credential-writeback.ts` implements write-back to `~/.claude/.credentials.json` (gated behind `auth.cooperativeWriteBack` config flag)
- Unit tests: PKCE file present + valid → entry; file missing → null; write-back gated by config flag
- `pnpm run test` passes green

#### T-E2-5: Implement `CredentialPool` class

**Size**: medium  
**Dependencies**: T-E2-1, T-E2-2, T-E2-3, T-E2-4  
**Acceptance criteria**:
- `packages/core/src/llm/credential-pool.ts` exports `CredentialPool` class
- `seed()` method calls all registered seeders, upserts results into `llm-credentials.json` pool
- Seed results are cached for 60 seconds; `force: true` bypasses cache
- `pick()` seeds if not already seeded, then calls `pickCredentialForProviderSync()`
- `list()` returns all pool entries including auto-seeded entries
- `getCredentialPool()` singleton accessor
- Unit tests: seeder results → pool entries with correct source; cache invalidation; pick after seed; list shows all sources
- `pnpm run test` passes green

#### T-E2-6: Wire pool into `resolveCredentials()` — async path

**Size**: medium  
**Dependencies**: T-E2-5  
**Acceptance criteria**:
- `resolveCredentials()` gains an async overload that calls `getCredentialPool().pick()`
- The existing sync overload is retained for backward compat (reads pool file directly, no re-seeding)
- Tier 4 (direct claude-creds read) is removed from the sync path — the claude-code seeder handles this via the pool
- Tier 4a (global config API key) is deprecated: reads still work but emit a deprecation warning
- Tier 5 (project config API key) MUST emit a stderr warning but MUST NOT be used (behavior change, guarded behind migration warning from T-E2-9)
- Unit tests: async resolve uses pool; sync resolve reads file directly; tier 5 warning is emitted
- `pnpm run test` passes green

#### T-E2-7: Implement `RemovalStep` registry and per-source steps

**Size**: medium  
**Dependencies**: T-E2-1  
**Acceptance criteria**:
- `packages/core/src/llm/credential-removal.ts` exports `RemovalRegistry` and `REMOVAL_REGISTRY`
- Removal steps registered for: `env`, `claude-code`, `cleo-pkce`, `manual`, `codex-cli` (if implemented), `gemini-cli` (if implemented), `gh-cli` (if implemented)
- `manual` entry removal: no external cleanup, `suppress: false`
- `env` entry removal: hint about shell env var, suppress source
- `claude-code` entry removal: do NOT delete `~/.claude/.credentials.json` (hint about it), suppress source
- `cleo-pkce` entry removal: delete `getCleoHome() + '/anthropic-oauth.json'`, suppress source
- Suppression state persisted to `getCleoHome() + '/auth-suppression.json'`
- Unit tests: removal step dispatched correctly; suppression persisted; env removal hints; claude-code removal hints without deleting file
- `pnpm run test` passes green

#### T-E2-8: Implement `cleo auth` command group (list, remove)

**Size**: medium  
**Dependencies**: T-E2-5, T-E2-7  
**Acceptance criteria**:
- `cleo auth list` shows ALL pool entries including auto-seeded, with columns: provider, label, source, auth type, expiry status, current marker
- `cleo auth list --provider anthropic` filters to one provider
- `cleo auth remove <provider> <label>` invokes the RemovalStep, outputs cleaned/hint messages
- `cleo auth list` and `cleo llm list` are unified or aliased (decide in implementation — one should delegate to the other)
- Unit tests for list output format and remove dispatch
- `pnpm run test` passes green

#### T-E2-9: Project-config secrets warning + `cleo auth migrate-project-secrets`

**Size**: small  
**Dependencies**: T-E2-6  
**Acceptance criteria**:
- On every `cleo` invocation, if `.cleo/config.json` contains `llm.providers.*.apiKey`: warn to stderr with migration command
- `cleo auth migrate-project-secrets` reads API keys from `.cleo/config.json`, prompts user for confirmation, calls `addCredential()` for each, removes the keys from the project config file
- Migration is atomic: backup project config before modifying
- Unit tests: warning emitted; migration reads + moves keys; migration is idempotent
- `pnpm run test` passes green

#### T-E2-10: Implement optional external seeders (`codex-cli`, `gemini-cli`, `gh-cli`)

**Size**: medium  
**Dependencies**: T-E2-1  
**Acceptance criteria**:
- `codex-cli` seeder: locate Codex CLI credential file (verify actual path), read if exists, return null if not
- `gemini-cli` seeder: locate gemini-cli credential file (verify actual path), return null if not
- `gh-cli` seeder: run `gh auth token` subprocess, capture output, return null if gh not installed or exits non-zero
- Each seeder skips gracefully if the external tool is not installed
- All three registered in `BUILTIN_SEEDERS`
- Unit tests: file present → entry; file absent → null; subprocess failure → null
- `pnpm run test` passes green

#### T-E2-11: E2 quality gates — full test pass and credential-pool integration tests

**Size**: small  
**Dependencies**: T-E2-1 through T-E2-10  
**Acceptance criteria**:
- `pnpm biome check --write .` exits 0
- `pnpm run build` exits 0
- `pnpm run test` exits 0 with zero new failures
- Integration test: `resolveCredentials('anthropic')` uses claude-code entry when present and consent given, env entry when claude-code absent, returns null when neither present
- Integration test: `cleo auth list` shows entries from all seeded sources
- Integration test: `cleo auth remove anthropic claude-code` suppresses re-seeding durably

---

### 5.3 Epic E3 — Setup Wizard, Status Surface, and Studio Keys UI

#### T-E3-1: Core setup wizard engine (`packages/core/src/setup/`)

**Size**: medium  
**Dependencies**: T-E2-5 (pool), T-E2-6 (resolver)  
**Acceptance criteria**:
- `packages/core/src/setup/wizard.ts` exports `WizardRunner`, `WizardSectionRunner` interface, `WizardIO` interface
- `WizardRunner.run(sections)` executes sections in order, returning a summary of changes
- `WizardRunner.runSection(name)` executes a single named section
- LLM section: displays current credential status, prompts for provider selection, API key entry, or OAuth login trigger
- Identity section: prompts for agent name, optional SOUL.md content
- Sentient section: enable/disable daemon, enable/disable Tier-2 proposals
- Project conventions section: apply strictness preset
- API keys are written to pool, NOT to config
- Non-interactive mode: accepts `--provider`, `--api-key`, `--section` flags; non-configured sections are skipped silently
- Unit tests for each section: write-routing (secrets → pool, settings → config), non-interactive flag parsing
- `pnpm run test` passes green

#### T-E3-2: `cleo setup` CLI command

**Size**: small  
**Dependencies**: T-E3-1  
**Acceptance criteria**:
- `cleo setup` runs all wizard sections interactively in order
- `cleo setup --section <name>` runs one section
- `cleo setup --non-interactive --provider <p> --api-key <k>` configures LLM without prompts
- Help text explains all flags
- `cleo setup` exits 0 after successful run, non-zero on error
- `pnpm run test` passes green

#### T-E3-3: First-run detection and setup prompt

**Size**: small  
**Dependencies**: T-E3-2  
**Acceptance criteria**:
- On first `cleo` invocation with no credentials and no global config: outputs "CLEO is not configured. Run `cleo setup` to get started. (Press Enter to skip)"
- Skipping is the default (user presses Enter or waits 10 seconds)
- Detection logic: no global config.json AND no entries in pool AND no `ANTHROPIC_API_KEY` env
- First-run prompt MUST NOT block automated environments (CI): detect TTY; if stdin is not a TTY, skip prompt silently
- Unit tests for TTY detection and prompt skip behavior
- `pnpm run test` passes green

#### T-E3-4: `CleoStatus` core logic (`packages/core/src/status/`)

**Size**: medium  
**Dependencies**: T-E2-5 (pool), T-E1-3 (config path)  
**Acceptance criteria**:
- `packages/core/src/status/index.ts` exports `getCleoStatus(): Promise<CleoStatus>`
- Identity block: reads agent identity from config
- Credentials block: calls `getCredentialPool().list()` and maps to `CredentialStatusEntry[]`
- Config block: reports config file paths, detects secrets-in-project-config, reports active tier
- Session block: reads active session state from CLEO session subsystem
- Harness block: detects active harness
- Daemon block: reads sentient daemon state
- `getCleoStatus()` completes in under 2 seconds (no network calls, no seeding if already seeded)
- Unit tests for each block; mock dependencies
- `pnpm run test` passes green

#### T-E3-5: `cleo status` CLI command

**Size**: small  
**Dependencies**: T-E3-4  
**Acceptance criteria**:
- `cleo status` outputs a formatted summary (human-readable)
- `cleo status --json` outputs the `CleoStatus` JSON, validates against interface
- Exit 0 on success; exit non-zero if credential state is ERROR
- Credentials with `lastStatus: 'invalid'` are highlighted as errors
- Secrets-in-project-config warning is shown prominently
- `pnpm run test` passes green

#### T-E3-6: Harness and BRAIN wizard sections

**Size**: small  
**Dependencies**: T-E3-1  
**Acceptance criteria**:
- Harness section: displays active harness, prompts for Pi vs Claude Code selection
- BRAIN section: displays memory bridge mode, allows configuration
- Both sections work in non-interactive mode with appropriate flags
- `pnpm run test` passes green

#### T-E3-7: Studio `/keys` route — credential management UI

**Size**: medium  
**Dependencies**: T-E2-5, T-E2-7, T-E2-8  
**Acceptance criteria**:
- `packages/studio/src/routes/keys/+page.svelte` renders a list of all pool entries
- Entries are grouped by provider
- Each entry shows: label, source, auth type, expiry (human-readable), last status badge
- "Add credential" button opens a form for provider + label + API key
- Form submits to `packages/studio/src/routes/api/credentials/+server.ts` (or equivalent API route)
- API route calls `addCredential()` and returns success/error
- "Remove" action calls API route that invokes `REMOVAL_REGISTRY.find()` and `removeFn()`
- No credential values are returned by any API endpoint (write-only; list shows labels not tokens)
- Playwright E2E test: add credential, verify it appears in list, remove credential, verify it disappears
- `pnpm run test` passes green (unit); `pnpm exec playwright test` passes (E2E)

#### T-E3-8: Studio `/setup` route — guided web setup

**Size**: medium  
**Dependencies**: T-E3-1, T-E3-7  
**Acceptance criteria**:
- `packages/studio/src/routes/setup/+page.svelte` presents a step-by-step setup flow
- At minimum: LLM section (provider selection, API key entry or OAuth link) and Project Conventions section
- Uses the same `WizardSectionRunner` business logic from `packages/core/src/setup/`
- API key entry submits to the credential pool API (not to config)
- Wizard state is saved per-section; user can return to a completed section
- Playwright E2E test: navigate to /setup, complete LLM section, verify credential appears in /keys
- `pnpm run test` passes green; Playwright E2E passes

#### T-E3-9: E3 quality gates — full test pass + E2E

**Size**: small  
**Dependencies**: T-E3-1 through T-E3-8  
**Acceptance criteria**:
- `pnpm biome check --write .` exits 0
- `pnpm run build` exits 0
- `pnpm run test` exits 0 with zero new failures
- `cleo setup --non-interactive --provider anthropic --api-key sk-ant-test-key` exits 0 and adds key to pool
- `cleo status --json` validates against `CleoStatus` interface
- `cleo status` completes in under 2 seconds on a healthy system
- Studio `/keys` page loads and displays pool entries
- Studio `/setup` page completes LLM section without writing to config.json

---

## Appendix A — Evidence References Quick Index

| Claim | Evidence file + lines |
|-------|-----------------------|
| Hermes `~/.hermes/` layout, secrets in `.env` | `hermes-agent/website/docs/user-guide/configuration.md:9-56` |
| Hermes aux slots (8 slots, not roles) | `hermes-agent/website/docs/user-guide/configuring-models.md:1-80` |
| Hermes `_seed_from_singletons()` with PR #4210 consent gate | `hermes-agent/agent/credential_pool.py:1169-1193` |
| Hermes priority order (`hermes_pkce:2`, `claude_code:3`) | `hermes-agent/agent/credential_pool.py:1139-1144` |
| Hermes `_seed_from_env()` prefers `.env` over `os.environ` | `hermes-agent/agent/credential_pool.py:1400-1420` |
| Hermes write-back to `~/.claude/.credentials.json` | `hermes-agent/agent/anthropic_adapter.py:871-913` |
| Hermes scopes field preservation for Claude Code >=2.1.81 | `hermes-agent/agent/anthropic_adapter.py:897-902` |
| Hermes `RemovalStep` registry pattern | `hermes-agent/agent/credential_sources.py:1-132` |
| Hermes PROVIDER_REGISTRY (`oauth_external` entries) | `hermes-agent/hermes_cli/auth.py:149-227` |
| Hermes `auth list` shows all sources | `hermes-agent/hermes_cli/auth_commands.py:404-428` |
| Hermes setup wizard 5 sections | `hermes-agent/hermes_cli/setup.py:1-11` |
| CLEO `cleoHomeDir()` — parallel XDG impl ignoring `CLEO_HOME` | `packages/core/src/llm/credentials.ts:160-163` |
| CLEO 6-tier resolver chain (docstring) | `packages/core/src/llm/credentials.ts:1-27` |
| CLEO tier 4a reads from data dir not config dir | `packages/core/src/llm/credentials.ts:166-168` |
| CLEO tier 3 reads pool; tier 4 reads claude-creds | `packages/core/src/llm/credentials.ts:291-316` |
| CLEO tier 5 — project-config secrets footgun | `packages/core/src/llm/credentials.ts:345-356` |
| CLEO `credentials-store.ts` — manual pool only, schema comment | `packages/core/src/llm/credentials-store.ts:1-36` |
| CLEO `credentialsStorePath()` uses `cleoHomeDir()` | `packages/core/src/llm/credentials-store.ts:215-217` |
| CLEO `@cleocode/paths` SSoT — `getCleoPlatformPaths()` | `packages/paths/src/platform-paths.ts:32-43` |
| CLEO `getCleoHome()` re-export in core/paths.ts | `packages/core/src/paths.ts:181-183` |
| CLEO `getCleoConfigDir()` exists but unused by credentials | `packages/core/src/paths.ts:1186-1201` |
| CLEO `cleo config` — no wizard, only raw k/v | `packages/cleo/src/cli/commands/config.ts:1-80` |
| CLEO `cleo llm login` — anthropic + kimi only | `packages/cleo/src/cli/commands/llm-login.ts:1-60` |
| CLEO zero write-back to `~/.claude/.credentials.json` | grep returns zero hits in `packages/core/src/llm/` |
| CLEO Studio — no credential or setup routes | `packages/studio/src/routes/` listing |

---

## Appendix B — Migration Decision Tree

```
First `cleo` command after upgrade:
│
├── Is ~/.config/cleo/config.json absent AND ~/.local/share/cleo/config.json present?
│   ├── YES → run Migration 1 (config file move)
│   └── NO → skip
│
├── Is ~/.local/share/cleo/anthropic-key present AND no 'legacy-flat-key' in pool?
│   ├── YES → run Migration 2 (flat key import)
│   └── NO → skip
│
└── Does .cleo/config.json in CWD contain llm.providers.*.apiKey?
    ├── YES → emit warning, skip (don't auto-migrate secrets)
    └── NO → skip
```

---

## Appendix C — Open Questions Requiring HITL

| # | Question | Decision needed before | Options |
|---|----------|----------------------|---------|
| OQ-1 | Should CLEO write refreshed Anthropic OAuth tokens back to `~/.claude/.credentials.json`? | E2 T-E2-4 | (A) Write-back always; (B) Write-back opt-in (default true); (C) No write-back, CLEO maintains own file only |
| OQ-2 | Should `codex-cli`, `gemini-cli`, `gh-cli` seeders be in E2 core or E2 follow-up? | E2 task filing | (A) Core E2; (B) Follow-up tasks after E2 ships |
| OQ-3 | What is the actual path for Codex CLI's OAuth file? | T-E2-10 | Requires inspection of actual Codex CLI installation |
| OQ-4 | What is the actual path for gemini-cli's credential file? | T-E2-10 | Requires inspection of actual gemini-cli installation |
| OQ-5 | Should `cleo auth list` supersede and alias `cleo llm list`, or run in parallel? | E2 T-E2-8 | (A) `cleo auth list` is the new primary, `cleo llm list` becomes alias; (B) Both maintained separately |

---

*End of E-CONFIG-AUTH-UNIFY RCASD specification.*  
*Produced by: LEAD architect role, 2026-05-16.*  
*Next step: owner review → HITL on open questions → file tasks via `cleo add`.*
