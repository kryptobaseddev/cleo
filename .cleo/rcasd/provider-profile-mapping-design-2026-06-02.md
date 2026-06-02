# Design: hermes-style LLM provider profile-mapping SSoT for CLEO

- **Date:** 2026-06-02
- **Task:** T11617
- **Branch / HEAD:** `task/T11617-llm-provider-profile-self-heal` off `main @ 815197eaa`
- **Author role:** system architect + implementer
- **Companion RCA:** `.cleo/rcasd/provider-llm-ssot-rca-2026-06-02.md`
- **Owner mandate (verbatim intent):** "It must NOT be set to any specific
  provider — it MUST be configurable to a PROFILE, where the user selects a
  provider to fulfill that. ANYTHING we ever need to use an LLM call for must be
  mapped / available to profiles. Look at how hermes-agent handles auxiliary
  systems … Be smarter and more dynamic … then a config system for dynamically
  associating whatever we need to the list of different LLM-call systems."

---

## 1. Executive summary

CLEO already shipped the hard 80% under epic **T9261**: a credential pool SSoT
(`~/.cleo/llm-credentials.json`), a 6-tier resolver, a role→provider→model→credential
resolver, a 10-provider registry, six wire transports (Anthropic, OpenAI
chat-completions, OpenAI Responses/Codex, Gemini, Bedrock, Ollama), OAuth
device-code/PKCE/refresh machinery, and a runtime CLI (`cleo llm profile`,
`use`, `whoami`, `list`, `add`, `remove`). **It is NOT hardcoded to Anthropic.**

The mandate is satisfied conceptually but with three gaps:

1. **No named, reusable Profiles.** Today a binding is an inline tuple
   (`llm.roles.consolidation = {provider, model, credentialLabel}`). hermes lets
   you define a provider+model once and reference it from many call sites. CLEO
   repeats the tuple per role. This is the "Profile" abstraction the owner wants.
2. **No `provider:"auto"` / fallback-chain binding.** hermes' `auto` resolves a
   best-available chain (OpenRouter → Nous → main → Codex). CLEO's implicit
   fallback is the single hardcoded `anthropic + claude-haiku-4-5`. There is an
   `llm.auxiliaryFallback` chain but it is only consulted on *pool exhaustion*,
   not as a first-class binding target.
3. **No call-site catalogue.** The mandate says "ANYTHING we ever need an LLM
   call for must be mapped." CLEO routes everything through ~7 semantic *roles*,
   which is the right granularity — but there is no enumerated, documented
   registry of call-sites→role so the owner can see and rebind the full surface.

Plus the live operational bug the RCA found: background roles silently fail
(`no_backend → skipping`) because the only refreshable credentials are an
**expired** Anthropic OAuth (not refreshed on the sync path) and a **live**
OpenAI Codex OAuth that **cannot be consumed** because `role-executor` has no
OpenAI-OAuth/Responses branch.

**Recommendation:** evolve the existing T9261 `llm/` subsystem into the profile
SSoT. **Do NOT introduce GenKit** — it is not present, and the hand-rolled layer
is already the SSoT. GenKit would be a parallel provider abstraction with zero
adoption, violating SSoT. (See §8.)

---

## 2. hermes-agent's model (the thing to emulate)

Source: `/mnt/projects/hermes-agent`. The mechanism the owner referenced is the
**auxiliary task → provider+model binding** plus declarative **ProviderProfiles**.

### 2.1 ProviderProfile — declarative provider description
`providers/base.py:38` `ProviderProfile` is a dataclass declaring everything
about a provider in one place: `name`, `api_mode` (`chat_completions` |
`codex_responses` | …), `aliases`, `base_url`, `auth_type`
(`api_key|oauth_device_code|oauth_external|copilot|aws_sdk`), `fallback_models`,
client/request quirks, and a `default_aux_model` (`base.py:75`) — "a cheap model
for auxiliary tasks". Profiles are discovered from bundled + user plugin dirs
(`providers/__init__.py:140`), last-writer-wins, so users can drop a profile
into `$HERMES_HOME/plugins/model-providers/<name>/` and override a builtin
**without editing repo code**. This is CLEO's `provider-registry/` (which already
has the same builtin + loader + plugin shape).

### 2.2 The auxiliary binding — "what to use when"
`cli-config.yaml.example:401-460` — the `auxiliary` block. Each side-task gets
its own `{provider, model}` pair:

```yaml
auxiliary:
  vision:        { provider: "auto", model: "" }   # image analysis + screenshots
  web_extract:   { provider: "auto", model: "" }   # page summarization
  session_search:{ provider: "auto", model: "", max_concurrency: 3 }
# compression summaries pin via auxiliary.compression.provider/model
```

`provider` values: `auto | openrouter | nous | gemini | ollama-cloud | codex |
main | custom:<name>`. `model: ""` → provider default. This is *exactly* the
"map a configured provider to a profile for what-to-use-when" the owner means:
**each subsystem names a provider (or `auto`) and optionally a model.**

### 2.3 The binding-resolution engine
`agent/auxiliary_client.py` is the resolver. `resolve_provider_client(provider,
model=…)` (called e.g. `mini_swe_runner.py:227`) takes the configured provider
string and returns a constructed client. `_normalize_aux_provider`
(`:165`) resolves aliases and the special tokens: `codex`→`openai-codex`,
`main`→the user's actual main provider, `custom:x`→`x`. When `provider=="auto"`
(`:2463`) it falls through to the main runtime's provider then a fallback chain;
on payment/credit/rate errors it auto-retries the **next** provider
(`_try_payment_fallback :2734`, `_try_main_agent_model_fallback :2785`). Codex
OAuth uses base URL `https://chatgpt.com/backend-api/codex` plus Cloudflare
headers `originator: codex_cli_rs` + `ChatGPT-Account-ID` extracted from the JWT
(`:441`, `:444`).

**The hermes model in one paragraph:** declarative ProviderProfiles describe
*how* to talk to each provider; a small set of named auxiliary task-keys each
bind to a `{provider, model}` (or `auto`); a single resolver maps task-key →
provider → constructed client, with alias normalization and an automatic
multi-provider fallback chain on failure.

---

## 3. CLEO's current model (verified, file:line)

| hermes concept | CLEO equivalent | File |
|----------------|-----------------|------|
| ProviderProfile (declarative) | `provider-registry/builtin/*.ts` + `loader.ts` + plugin dir | `packages/core/src/llm/provider-registry/` |
| auxiliary task-key | semantic **role** (`RoleName`) | `packages/contracts/src/config.ts:410` |
| `auxiliary.<task> = {provider, model}` | `llm.roles[role] = {provider, model, credentialLabel}` | `packages/contracts/src/config.ts:443` |
| `resolve_provider_client` | `resolveLLMForRole` / `executeForRole` | `llm/role-resolver.ts:291`, `llm/role-executor.ts:107` |
| `_normalize_aux_provider` aliases | provider-registry aliases | `provider-registry/loader.ts` |
| `auto` + fallback chain | `llm.auxiliaryFallback` (exhaustion-only) | `llm/cli-ops.ts:459`, `llm/auxiliary-fallback.ts` |
| credential pool | `~/.cleo/llm-credentials.json` | `llm/credentials-store.ts` |

**So CLEO's `role` IS already a profile-binding target** — it is the right
abstraction and the right granularity. What is missing is the *named, reusable*
Profile layer on top, an `auto` first-class binding, and the documented
call-site catalogue. The resolution order (`role-resolver.ts:158`
`selectProviderModel`) is: `roles[role]` → `default` → implicit-fallback
(`anthropic + claude-haiku-4-5`, `fallback-model.ts`).

### 3.1 Verified RCA claims
- `selectProviderModel` first-match-wins, implicit fallback anthropic+haiku: **confirmed** (`role-resolver.ts:167,177,187`).
- sync pick never refreshes OAuth: **confirmed** (`credentials-store.ts:449` `pickCredentialForProviderSync` has no refresh).
- expired entries silently filtered: **confirmed** (`credentials-store.ts:415`).
- `executeForRole` only knows anthropic / kimi-code / generic-chat_completions; **no OpenAI-OAuth/Codex branch**: **confirmed** (`role-executor.ts:130-195`). `CodexResponsesTransport` exists but is unwired (`transports/codex-responses.ts`, exported `transports/index.ts:33`).
- `proactiveRefresh` exists but is uncalled on the role path: **confirmed** (`credential-pool.ts:399`; note the RCA's `maybeRefresh` name is actually `proactiveRefresh`). It only fires when `0 <= remaining < floor` — it does **not** refresh an already-expired token (`remaining < 0` returns false at `:410`).
- `markExhausted(label, code)` exists, cooldown 401→5min (`credential-pool.ts:345`); `markOk` clears (`:366`); `lastStatus` field exists (`credentials-store.ts:124`).

---

## 4. Live call-site inventory (the "map everything" requirement)

Every CLEO LLM inference call already routes through the role SSoT. Catalogue:

| # | Subsystem | File | Entry | Role | On SSoT? |
|---|-----------|------|-------|------|----------|
| 1 | sleep / memory consolidation | `memory/sleep-consolidation.ts` | `executeForRole` | `consolidation` | yes |
| 2 | observer / reflector | `memory/observer-reflector.ts` | `executeForRole` | `consolidation` | yes |
| 3 | llm-extraction (dialectic) | `memory/llm-extraction.ts` | `resolveAnthropicForRole` | `extraction` | yes (anthropic-only) |
| 4 | deriver | `deriver/deriver.ts` | `resolveAnthropicForRole` | `derivation` | yes (anthropic-only) |
| 5 | duplicate detector | `tasks/duplicate-detector.ts` | `resolve*ForRole` | `derivation` | yes |
| 6 | dream-cycle | `sentient/dream-cycle.ts` | `resolveAnthropicForRole` | (dream) | yes (anthropic-only) |
| 7 | hygiene-scan | `sentient/hygiene-scan.ts` | `resolve*ForRole` | `hygiene` | yes |
| 8 | decision conflict validator | decisions write-gate (`DecisionsConfig`) | dialectic | `judgement` | yes |
| 9 | plugin sandbox single-turn | `plugin-facade.ts` | `executeForRole` | `plugin` | yes |
| 10 | context compression | context-engines | role | `compression` | yes |
| 11 | embeddings | `memory/brain-embedding.ts` | local `EmbeddingProvider` | — | **separate** (local ONNX/FTS5, no API key) — out of scope |
| 12 | vision / image routing | `llm/image-routing.ts`, `auxiliary-fallback.ts` | auxiliary chain | — | partial (auxiliary chain, not a role) |

**Gap:** the two `resolveAnthropicForRole` consumers (#3,#4,#6) are
**anthropic-only by contract** (`role-resolver.ts:387` returns `null` for
non-anthropic). So "route extraction to OpenAI Codex" silently no-ops for those
until that helper is widened. `executeForRole` consumers (#1,#2,#9,#10) can use
any provider — once the OpenAI-OAuth branch lands (this PR).

---

## 5. Proposed profile-mapping SSoT

### 5.1 Data model (three layers)

```
Connections (credentials) ──┐         already exist: ~/.cleo/llm-credentials.json
  provider + label + auth   │         (credentials-store.ts)
                            ▼
Profiles (named, reusable) ─┐         NEW: llm.profiles[name] = {provider, model, credentialLabel?, params?}
  e.g. "fast", "deep",      │              + reserved name "auto" = fallback chain
       "codex-bg"           │
                            ▼
Bindings (call-site → profile) ───────  EVOLVE: llm.roles[role] gains `profile?: string`
  role/call-site → profileName                  (back-compat: inline {provider,model} still works)
       + a configurable `llm.defaultProfile`
```

### 5.2 Config schema (extends `~/.config/cleo/config.json` `llm` block — NOT credentials.json)

Credentials stay in the 0600 pool file (secrets). Profiles + bindings are
non-secret config and belong in `config.json` next to the existing `llm.roles`:

```jsonc
{
  "llm": {
    "profiles": {
      "fast":    { "provider": "anthropic", "model": "claude-haiku-4-5-20251001" },
      "deep":    { "provider": "anthropic", "model": "claude-sonnet-4-6" },
      "codex-bg":{ "provider": "openai", "model": "gpt-5-codex", "credentialLabel": "codex-cli" }
    },
    "defaultProfile": "codex-bg",          // ← what background roles use unless overridden
    "roles": {
      "consolidation": { "profile": "codex-bg" },   // NEW: reference a named profile
      "hygiene":       { "provider": "anthropic", "model": "claude-sonnet-4-6" }  // OLD inline still valid
    }
  }
}
```

New contracts (`packages/contracts/src/config.ts`):
- `LlmProfileConfig { provider; model; credentialLabel?; params?: LlmProfileParams }`
- `LlmProfileParams { maxTokens?; temperature? }`
- `LlmConfig.profiles?: Record<string, LlmProfileConfig>`
- `LlmConfig.defaultProfile?: string`
- `LlmRoleConfig.profile?: string` (alternative to inline provider/model)

### 5.3 Resolution order (revised `selectProviderModel`)
1. `roles[role].profile` → look up `profiles[name]`
2. `roles[role].{provider,model}` (inline — existing behaviour)
3. `defaultProfile` → `profiles[name]`
4. `default` (existing `LlmDefaultConfig`)
5. implicit fallback (`anthropic + haiku`)

`profile === "auto"` (reserved) resolves the first provider in
`llm.auxiliaryFallback` that has a live credential — unifying the exhaustion
chain with binding (matches hermes `auto`).

### 5.4 CLI surface
- `cleo llm profile-create <name> <provider> --model M [--credential-label L] [--max-tokens N] [--temperature T]` — define/update a named profile.
- `cleo llm profiles list` — list named profiles + which roles bind to each.
- `cleo llm bind <role> <profileName>` — bind a role to a named profile (sugar over `llm.roles[role].profile`).
- `cleo llm bind --default <profileName>` — set `llm.defaultProfile`.
- `cleo llm profile <role> <provider> [--model] [--credential-label]` — KEEP (inline pin, existing).
- `cleo llm whoami` — extend to show `profile` column + `defaultProfile`.

### 5.5 Migration
Pure superset — every existing `llm.roles[role] = {provider, model}` keeps
working (resolution step 2). No migration required to upgrade. A one-time
`cleo llm doctor --suggest-profiles` can offer to collapse repeated inline
tuples into named profiles (optional, S).

### 5.6 Self-heal behaviour (owner Q3: "refresh, prompt only if nothing valid")
- **Refresh-on-resolve:** before filtering an OAuth entry as expired, attempt
  refresh (`proactiveRefresh`, widened to handle `remaining < 0`). Renews the
  expired Anthropic OAuth instead of dropping it.
- **Quarantine-on-401:** in `executeForRole`'s catch, a classified `auth`
  error (`error-classifier.ts` 401/403) marks the credential
  `lastStatus:'invalid'` via `markExhausted` so it stops being picked next tick.
- **Log-once:** latch the warning per `(role, provider, label)` so a dead key
  logs ONCE per process, not every briefing tick.
- **Actionable prompt:** when a role resolves to NO live credential, surface
  `run 'cleo llm login'` (or `cleo llm bind <role> <profile>`), not a silent
  `no_backend` skip or a 401 spam loop.

---

## 6. Epic decomposition

Proposed epic **E-LLM-PROFILE-MAPPING** (or fold into SG-AGENTIC-VERTICAL).
Reuses T9261 family infrastructure; T11617 is the minimal self-heal slice.

| ID | Title | Size | Deps |
|----|-------|------|------|
| **T11617** (this PR) | LLM credential self-heal: 401→quarantine+log-once · refresh-on-resolve · OpenAI Codex-OAuth role branch · configurable default binding | M | — |
| New | Contracts: `LlmProfileConfig` + `LlmConfig.profiles` + `defaultProfile` + `LlmRoleConfig.profile` | S | T11617 |
| New | `selectProviderModel` profile-aware resolution (steps 1-5 §5.3) | M | contracts task |
| New | `profile === "auto"` first-class binding → auxiliaryFallback live-credential pick | M | resolution task |
| New | CLI: `profile-create` / `profiles list` / `bind` + `whoami` profile column | M | resolution task |
| New | Widen `resolveAnthropicForRole` callers (#3,#4,#6) to provider-neutral so extraction/derivation/dream can use any profile | L | Codex branch (T11617) |
| New | Move role resolution onto async self-seeding pool (`resolveCredentialsAsync` / `getCredentialPool().pick()`) — eliminate sync/async divergence | M | T11617 |
| New | `cleo llm doctor`: quarantine fake keys (`sk-ant-test-*`), report expired-without-refresh-token, `--suggest-profiles` | S | resolution task |
| New | Provider-neutral test matrix + role-executor contract tests across all transports | M | Codex branch, resolution |

---

## 7. Owner decision points
1. **Default background profile:** confirm `openai/codex-cli` OAuth (the only
   live token) as the seeded `defaultProfile`, or re-auth Anthropic (`cleo llm
   login`) and keep cheap Haiku. (This PR defaults to a `codex-bg` profile
   pointing at `openai/codex-cli`, documented as user-changeable.)
2. **Named profiles vs inline-only:** ship the full named-Profile layer (§5),
   or keep the inline `llm.roles` tuple as the only binding (CLEO is already
   functionally "profiles" via roles). Recommendation: ship named profiles —
   it is the literal mandate and removes tuple duplication.
3. **Auto-refresh + auto-quarantine policy:** silent background, or visible
   re-auth prompt? This PR does silent refresh + quarantine + a ONE-TIME
   actionable prompt (hybrid — matches Q3 "refresh, prompt only if nothing valid").
4. **GenKit:** confirm GenKit is NOT adopted as the provider abstraction (§8).

---

## 8. North Star "GenKit substrate" reconciliation
The North Star lists a "GenKit phased substrate." **GenKit is not present** (no
`@genkit-ai`/`@google/genkit` dependency, no `defineFlow`/`genkit(...)` in
`packages/`). The real, shipped SSoT is the T9261 hand-rolled `llm/` subsystem.
Adopting GenKit now would create a second provider abstraction with zero
adoption — a direct SSoT violation. **Recommendation: the hand-rolled `llm/`
layer IS the provider SSoT; GenKit is deferred/dropped unless a concrete
capability (e.g. its flow tracing) is later required, and even then it would
wrap — not replace — the credential pool + transports.**

---

## 9. T11617 implementation slice (this PR)
1. `role-executor.ts`: OpenAI-OAuth/Codex branch (Responses API via
   `CodexResponsesTransport`, base URL `https://chatgpt.com/backend-api/codex`,
   Cloudflare headers); 401→`markExhausted`; log-once latch; actionable prompt.
2. `role-resolver.ts` / pool: refresh expired-but-refreshable OAuth before drop.
3. Configurable default binding seeded to a `codex-bg` profile pointing at
   `openai/codex-cli` (NOT hardcoded in code paths — routed through config).
4. Tests: self-heal (401→quarantine+log-once) + Codex branch.
</content>
