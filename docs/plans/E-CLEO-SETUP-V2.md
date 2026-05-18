# E-CLEO-SETUP-V2: Complete Progressive Onboarding Wizard

**Epic**: E-CLEO-SETUP-V2 (T9591)  
**Saga**: SG-CLEO-CORE-V2 (T9585)  
**Status**: Specification  
**Date**: 2026-05-18  
**Author**: RCASD Architect (T9591 respawn)

---

## 1. Research — Current Wired State

### 1.1 What Exists Today (v2026.5.79+)

The setup wizard is a two-package system:

**`@cleocode/core/setup/`** (engine — CORE-first, I/O-agnostic):

| File | Exports | Status |
|------|---------|--------|
| `wizard.ts` | `WizardRunner`, `WizardIO`, `WizardOptions`, `WizardSection`, `WizardSectionResult`, `WizardRunResult`, `StubWizardIO` | DONE |
| `index.ts` | `createBuiltinSections()`, `createDefaultWizardRunner()` | DONE |
| `sections/llm.ts` | `createLlmSection()` | DONE |
| `sections/identity.ts` | `createIdentitySection()` | DONE |
| `sections/sentient.ts` | `createSentientSection()` | DONE |
| `sections/project-conventions.ts` | `createProjectConventionsSection()` | DONE |
| `sections/harness.ts` | `createHarnessSection()` | DONE |
| `sections/brain.ts` | `createBrainSection()` | DONE |

**`@cleocode/cleo/cli/commands/setup.ts`** (CLI thin wrapper):

- `cleo setup` — runs all 6 built-in sections in canonical order
- `cleo setup --section <name>` — runs a single named section
- `cleo setup --non-interactive --provider <p> --api-key <k>` — scriptable LLM section
- Emits LAFS-shaped envelope on stdout
- `ReadlineWizardIO` wires `node:readline` to `WizardIO` interface

**Current canonical section order**:

```
1. llm               — credentials are prerequisite for everything
2. identity          — agent name + SOUL.md
3. sentient          — daemon kill-switch + Tier-2 proposals
4. project-conventions — strictness preset
5. harness           — Pi vs Claude Code
6. brain             — memory bridge mode
```

**Gaps vs the 8-section target**:

| Section | Current Status | Gap |
|---------|---------------|-----|
| `identity` | Wired — agent name + SOUL.md | Missing: SignalDock identity registration |
| `llm` | Wired — provider + API key + OAuth deferred | Missing: pool-seeding consent, `--config-json` flag |
| `sentient` | Wired — enable/disable + Tier-2 toggle | Complete for v2 scope |
| `harness` | Wired — Pi vs Claude Code | Missing: Pi URL config, custom harness path |
| `brain` | Wired — bridge mode only | Missing: retention days, decay parameters, BRAIN index toggle |
| `project-conventions` | Wired — strictness preset only | Missing: AC policy, session policy details |
| `integrations` | NOT WIRED | New section: Studio, Conduit endpoints, SignalDock |
| `verification` | NOT WIRED | New section: `cleo status` runner + state validation |

**Global config keys already in use** (from `packages/core/src/config.ts`):

```
agent.name              — identity section writes this
harness.active          — harness section writes this
brain.memoryBridge.mode — brain section writes this
session.autoStart       — project-conventions (strictness preset) writes this
session.requireNotes    — project-conventions (strictness preset) writes this
session.multiSession    — project-conventions (strictness preset) writes this
signaldock.enabled      — integrations section will write this
signaldock.endpoint     — integrations section will write this
auth.claudeCodeConsentGiven — llm section (pool-seeding consent)
auth.cooperativeWriteBack   — llm section (cooperative write-back)
```

### 1.2 Hermes Agent Reference Patterns

Hermes `setup.py` (NousResearch, reviewed 2026-05-18) provides the following UX patterns relevant to CLEO V2:

1. **Non-interactive fallback guidance**: when stdin is not a TTY, `print_noninteractive_setup_guidance()` prints explicit `hermes config set` commands instead of aborting. CLEO MUST implement equivalent — print `cleo config set <path> <value>` equivalents.

2. **Bracketed paste sanitization**: strip `\x1b[200~` / `\x1b[201~` from pasted API keys before saving. CLEO `ReadlineWizardIO` does not currently do this.

3. **Section-level help text**: each section opens with a 2–3 line description of what it configures and where config lands. Hermes uses `print_header(title)` + paragraph. CLEO `WizardIO.info()` is sufficient; sections should emit this before prompting.

4. **Setup completion summary**: Hermes `_print_setup_summary()` validates tool availability post-run. CLEO `verification` section mirrors this pattern — validate connectivity, not just config presence.

5. **Idempotency via current-value display**: Hermes shows current values before asking for new ones (e.g., current model, current provider). All CLEO sections MUST display the current value alongside the prompt.

6. **`--config-json` pattern**: Hermes passes structured JSON to bypass interactive mode for entire sections. CLEO will add `--config-json '{"section": {...}}'` as an alternate to per-flag non-interactive.

---

## 2. Consensus — Section List, UX Patterns, HITL Questions

### 2.1 Resolved Section List (8 sections)

The 8 sections and their mapping to config scope:

| # | Section ID | Title | Config Scope | Required |
|---|------------|-------|-------------|----------|
| 1 | `identity` | Agent Identity | Global + Project (`SOUL.md`) | No |
| 2 | `llm` | LLM Authentication | Global (credential pool) | **Yes** |
| 3 | `sentient` | Sentient Daemon | Project (`sentient-state.json`) | No |
| 4 | `harness` | Active Harness | Global (`harness.active`) | No |
| 5 | `brain` | BRAIN Memory | Global (`brain.*`) | No |
| 6 | `project-conventions` | Project Conventions | Project config | No |
| 7 | `integrations` | Integrations | Global (`signaldock.*`, Studio) | No |
| 8 | `verification` | Verification | Read-only (validation run) | No |

**Canonical run order**: `identity` → `llm` → `sentient` → `harness` → `brain` → `project-conventions` → `integrations` → `verification`

Rationale for reordering from current:
- Identity first: establishes "who is this" before auth
- LLM second: credentials unlock everything else
- Verification last: validates the whole config state

### 2.2 UX Patterns (Consensus)

**Skip logic**: sections MUST check "already configured" and short-circuit with `{changed: false, summary: 'skipped (already configured)'}` unless `--reset` is passed.

**Reset flag**: `cleo setup --reset` clears the "already configured" skip gate for all sections. `cleo setup --reset --section llm` resets only one section.

**First-run detection**: CLEO MUST auto-prompt `cleo setup` on first invocation when the credential pool is empty AND `auth.firstRunComplete` is not `true` in global config.

**Progress indicator**: `WizardRunner.run()` SHOULD emit `[1/8] Identity` style headers before each section (already partially present via `io.info(── title ──)`).

**Exit on Ctrl-C**: any `WizardIO.prompt()` receiving EOFError or interrupt MUST propagate a `WizardInterruptError` that the CLI catches to print `Setup interrupted. Run 'cleo setup' to continue.` and exit 130.

**Non-interactive JSON**: `--config-json` accepts a JSON object whose top-level keys are section IDs mapping to per-section option bags. Example:

```bash
cleo setup --non-interactive --config-json '{
  "identity": {"agentName": "Atlas"},
  "llm": {"provider": "anthropic", "apiKey": "sk-ant-..."}
}'
```

**Studio parity**: Studio `/setup` route calls `WizardRunner.runSection(name, studioIO, options)` directly. No new CLI-specific code is required.

### 2.3 Open HITL Questions (resolved via owner directive)

| Question | Resolution |
|----------|-----------|
| Should SignalDock identity registration be part of `identity` or `integrations`? | **Split**: `identity` handles agent name + SOUL.md; `integrations` handles SignalDock endpoint + enable toggle. Cross-link via `WizardOptions.signaldockAutoConnect`. |
| Should pool-seeding consent be a sub-step of `llm` or a separate section? | **Sub-step of `llm`**: show consent inline after API key entry when the provider supports pool sharing (Anthropic, OpenRouter). |
| Should `verification` mutate any state? | **No**: verification is read-only. It runs `cleo status` equivalent, validates reachability, and reports. |
| Where does `auth.firstRunComplete` live? | **Global config**. Set to `true` by `WizardRunner.run()` after a successful full-wizard pass. |
| Should `cleo setup --reset` clear credentials? | **No**: `--reset` only clears the "configured" sentinel; it does not touch the credential pool. Credential deletion is `cleo llm remove`. |

---

## 3. Architecture

### 3.1 WizardSection Type Extension

The current `WizardSection` union in `wizard.ts` covers 6 sections. V2 adds 2:

```typescript
export type WizardSection =
  | 'llm'
  | 'identity'
  | 'harness'
  | 'sentient'
  | 'project-conventions'
  | 'brain'
  | 'integrations'      // NEW — T9592
  | 'verification';     // NEW — T9593
```

### 3.2 WizardOptions Extension

New fields added to the existing `WizardOptions` interface:

```typescript
export interface WizardOptions {
  // --- existing fields unchanged ---
  nonInteractive?: boolean;
  provider?: string;
  apiKey?: string;
  label?: string;
  agentName?: string;
  soulMdContent?: string;
  sentientEnabled?: boolean;
  tier2Enabled?: boolean;
  strictness?: 'strict' | 'standard' | 'minimal';
  harness?: 'pi' | 'claude-code';
  brainBridgeMode?: 'digest' | 'file' | 'disabled';
  projectRoot?: string;

  // --- NEW fields for V2 sections ---

  /** `identity` section: connect to SignalDock after writing agent name. */
  signaldockAutoConnect?: boolean;

  /** `brain` section: how many days to retain memory entries (0 = forever). */
  brainRetentionDays?: number;

  /** `brain` section: enable/disable the BRAIN embedding index. */
  brainEmbeddingEnabled?: boolean;

  /** `integrations` section: enable SignalDock transport. */
  signaldockEnabled?: boolean;

  /** `integrations` section: SignalDock endpoint URL. */
  signaldockEndpoint?: string;

  /** `integrations` section: enable Studio web UI. */
  studioEnabled?: boolean;

  /** `integrations` section: Conduit local DB endpoint path. */
  conduitPath?: string;

  /** `llm` section: consent to pool seeding (sharing keys with the pool). */
  poolSeedingConsent?: boolean;

  /** `project-conventions` section: enforcement mode for missing ACs. */
  acEnforcementMode?: 'block' | 'warn' | 'off';

  /** `project-conventions` section: session auto-start behaviour. */
  sessionAutoStart?: boolean;

  /** Top-level: pass entire config as JSON (parsed before per-section options). */
  configJson?: Record<string, Record<string, unknown>>;

  /** Top-level: reset "already configured" sentinel before running. */
  reset?: boolean;
}
```

### 3.3 WizardSectionRunner Extension

New optional field on `WizardSectionRunner` to support idempotency:

```typescript
export interface WizardSectionRunner {
  section: WizardSection;
  title: string;
  optional: boolean;

  /**
   * Return `true` if the section has already been configured and should be
   * skipped unless `options.reset === true`.
   *
   * Called by `WizardRunner` before `run()`. When undefined, the section
   * is always run (old behaviour preserved for backward compatibility).
   */
  isConfigured?(options: WizardOptions): Promise<boolean>;

  run(io: WizardIO, options: WizardOptions): Promise<WizardSectionResult>;
}
```

### 3.4 WizardRunner Protocol Changes

`WizardRunner.run()` acquires two new behaviours:

1. **Skip logic**: before calling `section.run()`, call `section.isConfigured?.(options)`. If it returns `true` and `options.reset !== true`, emit `io.info('[skip] <title> — already configured. Use --reset to reconfigure.')` and push `{changed: false, summary: 'skipped (already configured)'}`.

2. **First-run completion**: after successfully running all sections (no `failed:` summary lines), call `setConfigValue('auth.firstRunComplete', true)` in the global config.

3. **Progress prefix**: emit section headers as `[N/total] title (section-id)` instead of the current `── title (section-id) ──` for better scripting legibility.

### 3.5 ReadlineWizardIO Enhancements

`packages/cleo/src/cli/lib/readline-wizard-io.ts` MUST add:

1. **Bracketed paste sanitization**: strip `\x1b[200~` / `\x1b[201~` sequences from all prompt responses before returning.
2. **WizardInterruptError propagation**: catch `readline` `SIGINT`/`close` events and throw `new WizardInterruptError('interrupted by user')`. `WizardInterruptError` is exported from `@cleocode/core/setup`.
3. **Select with arrow keys**: current `select()` is text-input fallback. The CLI implementation SHOULD present a numbered-list menu; plain readline is acceptable for V2.

### 3.6 CLI Flag Extensions

`packages/cleo/src/cli/commands/setup.ts` additions:

```typescript
args: {
  // --- existing ---
  section: { type: 'string' },
  'non-interactive': { type: 'boolean' },
  provider: { type: 'string' },
  'api-key': { type: 'string' },
  label: { type: 'string' },
  'agent-name': { type: 'string' },
  strictness: { type: 'string' },
  'project-root': { type: 'string' },

  // --- new in V2 ---
  'config-json': {
    type: 'string',
    description: 'JSON bag of per-section options. Keys are section IDs, values are WizardOptions sub-objects.',
  },
  reset: {
    type: 'boolean',
    description: 'Clear "already configured" sentinel before running.',
  },
  'retention-days': {
    type: 'string',
    description: 'BRAIN retention days (0 = forever). Used by the brain section.',
  },
  'signaldock-enabled': {
    type: 'boolean',
    description: 'Enable SignalDock transport. Used by the integrations section.',
  },
  'signaldock-endpoint': {
    type: 'string',
    description: 'SignalDock endpoint URL. Used by the integrations section.',
  },
  'studio-enabled': {
    type: 'boolean',
    description: 'Enable Studio web UI. Used by the integrations section.',
  },
}
```

`buildWizardOptions()` MUST be extended to parse `--config-json`, merge its per-section keys into the top-level options bag, and parse the new flags above.

### 3.7 New Section Files

Two new files under `packages/core/src/setup/sections/`:

- `integrations.ts` — exports `createIntegrationsSection()`
- `verification.ts` — exports `createVerificationSection()`

Both follow the identical factory pattern as the existing sections.

### 3.8 Studio API Parity

The Studio `/setup` route (T-E3-8, already planned under E-CONFIG-AUTH-UNIFY) consumes:

```typescript
import { createDefaultWizardRunner } from '@cleocode/core/setup';

const runner = createDefaultWizardRunner();
// StudioWizardIO implements WizardIO via SvelteKit form/event bus
const result = await runner.runSection('integrations', studioIO, {
  nonInteractive: true,
  signaldockEnabled: true,
  signaldockEndpoint: formData.endpoint,
});
```

No new Studio code is needed for V2 sections — the `createBuiltinSections()` factory in `index.ts` is updated to include the two new sections, and Studio picks them up automatically.

### 3.9 Config Scope Map

Where each setting lands (Global = `~/.cleo/config.json`, Project = `<cwd>/.cleo/config.json`):

| Setting | Scope | Config Path |
|---------|-------|------------|
| `agent.name` | Global | `agent.name` |
| SOUL.md content | Project file | `.cleo/SOUL.md` |
| SignalDock identity | Global | `signaldock.agentId` (new) |
| Credential pool | Global | brain.db `credentials` table |
| `auth.claudeCodeConsentGiven` | Global | `auth.claudeCodeConsentGiven` |
| `auth.poolSeedingConsent` | Global | `auth.poolSeedingConsent` (new) |
| `sentient.killSwitch` | Project file | `.cleo/sentient-state.json` |
| `harness.active` | Global | `harness.active` |
| `brain.memoryBridge.mode` | Global | `brain.memoryBridge.mode` |
| `brain.llmExtraction.enabled` | Global | `brain.llmExtraction.enabled` |
| `brain.retention.days` | Global | `brain.retention.days` (new) |
| `brain.embedding.enabled` | Global | `brain.embedding.enabled` |
| Strictness preset | Project | multiple keys via `applyStrictnessPreset` |
| `enforcement.acceptance.mode` | Project | `enforcement.acceptance.mode` |
| `session.autoStart` | Project | `session.autoStart` |
| `signaldock.enabled` | Global | `signaldock.enabled` |
| `signaldock.endpoint` | Global | `signaldock.endpoint` |
| Studio enabled | Global | `studio.enabled` (new) |
| Conduit path | Project | `conduit.dbPath` (new) |
| `auth.firstRunComplete` | Global | `auth.firstRunComplete` (new) |

---

## 4. Specification (RFC 2119)

### 4.1 General Requirements

**GEN-1**: `cleo setup` MUST run all 8 sections in canonical order: `identity` → `llm` → `sentient` → `harness` → `brain` → `project-conventions` → `integrations` → `verification`.

**GEN-2**: `cleo setup --section <name>` MUST run exactly one named section and exit.

**GEN-3**: `cleo setup --non-interactive` MUST suppress all `WizardIO.prompt()`, `WizardIO.confirm()`, and `WizardIO.select()` calls. Sections lacking required non-interactive inputs MUST short-circuit with `{changed: false, summary: 'skipped (non-interactive: ...required)'}`.

**GEN-4**: `cleo setup --config-json '<json>'` MUST parse the JSON string, validate it is an object, merge per-section keys into the `WizardOptions` bag, and proceed as if each key was passed as a CLI flag.

**GEN-5**: `cleo setup --reset` MUST set `options.reset = true`, causing all `isConfigured()` checks to return `false` for the current run.

**GEN-6**: Every section MUST call `io.info()` with a 2–3 line description of what the section configures and where config is stored before issuing any prompts.

**GEN-7**: Every section MUST display the current value of each config key it manages before prompting for a new value.

**GEN-8**: The wizard MUST emit a LAFS-shaped JSON envelope on stdout when `--non-interactive` is set. The envelope MUST contain `{success, data: {sectionsRun, summary, ok}, meta}`.

**GEN-9**: `cleo setup` MUST detect first-run conditions (credential pool empty AND `auth.firstRunComplete !== true`) and print a call-to-action on `cleo` invocations when this condition is met. The auto-prompt mechanism is out of scope for V2 (documented as future work).

**GEN-10**: `WizardRunner.run()` MUST write `auth.firstRunComplete = true` to global config after completing all sections without any `failed:` summary line.

### 4.2 Section: `identity`

**IDENT-1**: The section MUST prompt for agent display name. If the current name is set, it MUST display it as the default.

**IDENT-2**: The section MUST offer to write a SOUL.md persona block. The prompt MUST explain that SOUL.md is project-scoped (`.cleo/SOUL.md`).

**IDENT-3**: If `options.agentName` is set in non-interactive mode, the section MUST persist it to `agent.name` in the global config via `setConfigValue`.

**IDENT-4**: SOUL.md content from `options.soulMdContent` MUST be written to `<projectRoot>/.cleo/SOUL.md` atomically (write to temp file, rename).

**IDENT-5**: The section MUST prompt whether to register a SignalDock identity. If confirmed (or `options.signaldockAutoConnect === true`), the section MUST emit a note directing the user to run `cleo signaldock connect` — it MUST NOT block on network I/O.

**IDENT-6**: `isConfigured()` MUST return `true` if `agent.name` is already set in global config.

### 4.3 Section: `llm`

**LLM-1**: The section MUST display all current credential pool entries with provider, label, authType, and source before prompting.

**LLM-2**: The section MUST support interactive provider selection from a menu (`anthropic`, `openai`, `gemini`, `openrouter`, `moonshot`, `deepseek`, `xai`, `groq`, `ollama`).

**LLM-3**: For providers that support OAuth (`anthropic`, `openrouter`), the section MUST offer `api_key` or `oauth_login` as the auth mechanism. Choosing `oauth_login` MUST defer to `cleo llm login <provider>` without blocking.

**LLM-4**: API key input MUST strip bracketed paste sequences before persisting.

**LLM-5**: For providers that support pool seeding (`anthropic`, `openrouter`), after key entry the section MUST ask: "Consent to including this key in CLEO's credential pool for multi-agent distribution? [y/N]". The consent answer MUST be persisted to `auth.poolSeedingConsent` in global config.

**LLM-6**: In non-interactive mode: `options.provider` + `options.apiKey` MUST be both present to write a credential. `options.poolSeedingConsent` optionally writes consent.

**LLM-7**: `isConfigured()` MUST return `true` if the credential pool has at least one entry.

**LLM-8**: `--config-json` for the llm section MUST accept `{"llm": {"provider": "...", "apiKey": "...", "poolSeedingConsent": true}}`.

### 4.4 Section: `sentient`

**SENT-1**: The section MUST display the current sentient state (daemon enabled/disabled, Tier-2 on/off, last-tick timestamp if available).

**SENT-2**: The section MUST prompt: "Enable the sentient daemon? [y/N]" with default `false`.

**SENT-3**: The section MUST prompt: "Enable Tier-2 autonomous proposals? (only applies when daemon is enabled) [y/N]" with default `false`.

**SENT-4**: In non-interactive mode, `options.sentientEnabled` and `options.tier2Enabled` are applied if present. Missing values leave the current state unchanged.

**SENT-5**: `isConfigured()` MUST return `true` if `sentient-state.json` exists in the project root.

### 4.5 Section: `harness`

**HARN-1**: The section MUST display the current harness from `CLEO_HARNESS` env var and/or `harness.active` global config.

**HARN-2**: The section MUST offer `pi` and `claude-code` as choices. It SHOULD offer an "other / skip" option that leaves `harness.active` unset.

**HARN-3**: Selecting `pi` MUST additionally prompt for the Pi process URL (`CLEO_PI_URL`), defaulting to `http://localhost:7800`. The URL MUST be validated as a valid HTTP(S) URL before being persisted to `harness.piUrl` in global config.

**HARN-4**: Selecting `claude-code` MUST emit a note: "Ensure `claude` is on your PATH. Run `cleo harness doctor` to verify."

**HARN-5**: In non-interactive mode, `options.harness` MUST be persisted if present. `harness` MUST be one of `'pi'` | `'claude-code'`.

**HARN-6**: `isConfigured()` MUST return `true` if `harness.active` is set in global config.

### 4.6 Section: `brain`

**BRAIN-1**: The section MUST display the current bridge mode (`digest` / `file` / `disabled`), embedding enabled state, and retention days.

**BRAIN-2**: The section MUST prompt for bridge mode with choices `['digest', 'file', 'disabled']`.

**BRAIN-3**: The section MUST prompt: "How long should BRAIN retain memory entries? [days, 0 = forever, default 0]". The input MUST be validated as a non-negative integer. The value MUST be persisted to `brain.retention.days` (new config key, default `0`).

**BRAIN-4**: The section MUST prompt: "Enable BRAIN embedding index (enables semantic search, requires local disk)? [Y/n]". The value MUST be persisted to `brain.embedding.enabled`.

**BRAIN-5**: In non-interactive mode: `options.brainBridgeMode`, `options.brainRetentionDays`, and `options.brainEmbeddingEnabled` are each applied if present.

**BRAIN-6**: `isConfigured()` MUST return `true` if `brain.memoryBridge.mode` is set in global config.

### 4.7 Section: `project-conventions`

**PROJ-1**: The section MUST display the current strictness preset, AC enforcement mode, and session policy.

**PROJ-2**: The section MUST prompt for strictness preset: `['strict', 'standard', 'minimal']`.

**PROJ-3**: After applying the preset, the section MUST offer fine-grained overrides:
  - "Override AC enforcement mode? [block / warn / off / keep-preset-default]"
  - "Override session auto-start? [yes / no / keep-preset-default]"

**PROJ-4**: In non-interactive mode: `options.strictness` applies the preset. `options.acEnforcementMode` and `options.sessionAutoStart` apply overrides if present.

**PROJ-5**: `isConfigured()` MUST return `true` if a project config file exists and has at least one strictness-related key (`enforcement.acceptance.mode` or `session.requireNotes`).

### 4.8 Section: `integrations`

**INTG-1**: The section MUST display current SignalDock state (`enabled`, `endpoint`, `mode`) and Studio state.

**INTG-2**: The section MUST prompt: "Enable SignalDock transport? [y/N]". If yes, it MUST prompt for endpoint URL (defaulting to `http://localhost:4000`) and validate it as a valid HTTP(S) URL.

**INTG-3**: The section MUST prompt: "Enable Studio web UI? [y/N]". If yes, it MUST persist `studio.enabled = true` to global config. It MUST emit: "Start Studio with `cleo studio start`."

**INTG-4**: The section MUST prompt: "Custom Conduit DB path? [leave blank to use default]". If provided, the path MUST be validated as an absolute path and persisted to `conduit.dbPath` in project config.

**INTG-5**: In non-interactive mode: `options.signaldockEnabled`, `options.signaldockEndpoint`, `options.studioEnabled`, and `options.conduitPath` are each applied if present.

**INTG-6**: `isConfigured()` MUST return `true` if `signaldock.enabled` is explicitly set in global config (even if `false`).

**INTG-7**: The section MUST NOT make any network calls. It persists config only; connectivity is validated in the `verification` section.

### 4.9 Section: `verification`

**VERIF-1**: The verification section MUST be read-only. It MUST NOT mutate any config or DB.

**VERIF-2**: The section MUST run the following checks and report pass/fail for each:
  - Credential pool: at least one entry exists
  - Credential reachability: `cleo llm pool check` (calls provider health endpoint; non-blocking, timeout 5s per provider)
  - Config integrity: `cleo config validate` exits 0
  - Harness reachability: if `harness.active === 'pi'`, attempt HTTP GET to `harness.piUrl`/health (timeout 3s); if `claude-code`, check `which claude`
  - SignalDock reachability: if `signaldock.enabled === true`, attempt HTTP GET to `signaldock.endpoint`/health (timeout 3s)
  - BRAIN DB: `brain.db` is accessible (open + close)

**VERIF-3**: The section MUST emit a summary table: one row per check with status (`PASS` / `FAIL` / `SKIP`) and a short message.

**VERIF-4**: In non-interactive mode, all checks are still run. The section emits the table to stdout as JSON when `--non-interactive` is set.

**VERIF-5**: A `FAIL` on any check MUST result in `{changed: false, summary: 'verification: N check(s) failed — see output'}` and MUST NOT set `auth.firstRunComplete = true`.

**VERIF-6**: `isConfigured()` always returns `false` — verification always runs when included.

---

## 5. Decomposition

### 5.1 Epic Structure

```
E-CLEO-SETUP-V2 (T9591)            ← this spec
  T9592  Shared infra: WizardSection + WizardOptions extensions + isConfigured protocol
  T9593  Section: integrations
  T9594  Section: verification
  T9595  Extend existing sections: identity + llm + sentient + harness + brain + project-conventions
  T9596  CLI: --config-json + --reset + new flags + buildWizardOptions V2
  T9597  ReadlineWizardIO: paste sanitize + WizardInterruptError + select menu
  T9598  WizardRunner: skip logic + first-run completion + progress prefix
  T9599  Tests: integration test suite for all 8 sections
```

### 5.2 Task Details

---

#### T9592 — Shared infra: WizardSection type + WizardOptions extensions + isConfigured protocol

**Parent**: T9591  
**Kind**: work  
**Sizing**: small  
**Priority**: high  
**Acceptance**:
- `WizardSection` union in `wizard.ts` includes `'integrations'` and `'verification'` | No downstream type errors from the union extension | `WizardOptions` interface includes all new fields from §3.2 | `WizardSectionRunner` interface includes optional `isConfigured?()` | `WizardInterruptError` class exported from `@cleocode/core/setup` | All existing tests still pass

**Subtasks**:
1. Extend `WizardSection` union (2 new members)
2. Add new fields to `WizardOptions` interface
3. Add `isConfigured?()` optional method to `WizardSectionRunner` interface
4. Export `WizardInterruptError extends Error` from `wizard.ts`
5. Update `index.ts` re-exports

**Files**: `packages/core/src/setup/wizard.ts`, `packages/core/src/setup/index.ts`

---

#### T9593 — Section: `integrations`

**Parent**: T9591  
**Depends on**: T9592  
**Kind**: work  
**Sizing**: small  
**Priority**: medium  
**Acceptance**:
- `createIntegrationsSection()` exported from `@cleocode/core/setup` | Interactive flow: SignalDock enable/endpoint + Studio enable + Conduit path | Non-interactive flow: all 4 options applied from `WizardOptions` | `isConfigured()` returns `true` when `signaldock.enabled` is set | Section emits current state before prompting | No network calls inside the section | Registered in `createBuiltinSections()` at position 7

**Subtasks**:
1. Implement `createIntegrationsSection()` factory
2. `isConfigured()` implementation
3. Interactive flow (SignalDock + Studio + Conduit prompts)
4. Non-interactive flow
5. Register in `index.ts` `createBuiltinSections()`
6. Unit tests (StubWizardIO)

**Files**: `packages/core/src/setup/sections/integrations.ts`, `packages/core/src/setup/index.ts`

---

#### T9594 — Section: `verification`

**Parent**: T9591  
**Depends on**: T9592  
**Kind**: work  
**Sizing**: medium  
**Priority**: medium  
**Acceptance**:
- `createVerificationSection()` exported from `@cleocode/core/setup` | Runs 6 checks: credential pool, credential reachability, config integrity, harness reachability, SignalDock reachability, BRAIN DB | Each check emits `PASS`/`FAIL`/`SKIP` with message | `{changed: false}` always (read-only) | FAIL count in summary line | Non-interactive JSON table output | Registered in `createBuiltinSections()` at position 8 | Timeouts enforced (5s per provider, 3s per endpoint)

**Subtasks**:
1. Define `VerificationCheck` interface: `{name, status: 'PASS'|'FAIL'|'SKIP', message}`
2. Implement `runCredentialPoolCheck()`
3. Implement `runCredentialReachabilityCheck()` (with timeout)
4. Implement `runConfigIntegrityCheck()`
5. Implement `runHarnessReachabilityCheck()` (with timeout)
6. Implement `runSignaldockReachabilityCheck()` (with timeout)
7. Implement `runBrainDbCheck()`
8. Wire all checks into `createVerificationSection()` runner
9. Register in `index.ts` `createBuiltinSections()`
10. Unit tests (stub all external calls)

**Files**: `packages/core/src/setup/sections/verification.ts`, `packages/core/src/setup/index.ts`

---

#### T9595 — Extend existing 6 sections

**Parent**: T9591  
**Depends on**: T9592  
**Kind**: work  
**Sizing**: medium  
**Priority**: high  
**Acceptance**:
- Each of the 6 existing sections has `isConfigured()` implemented per §4.2–4.7 | `identity` prompts for SignalDock registration (IDENT-5) | `llm` strips paste sequences (LLM-4) and asks pool-seeding consent (LLM-5) | `harness` prompts for Pi URL (HARN-3) and emits note for claude-code (HARN-4) | `brain` prompts for retention days (BRAIN-3) and embedding toggle (BRAIN-4) | `project-conventions` offers AC and session policy overrides (PROJ-3) | Each section emits current value before prompting (GEN-7) | Each section has a 2-3 line section description (GEN-6) | All existing tests still pass

**Subtasks**:
1. `identity.ts`: add `isConfigured()`, SignalDock note, current-value display
2. `llm.ts`: add `isConfigured()`, paste sanitization, pool-seeding consent prompt
3. `sentient.ts`: add `isConfigured()`, current-state display
4. `harness.ts`: add `isConfigured()`, Pi URL prompt, claude-code note
5. `brain.ts`: add `isConfigured()`, retention days prompt, embedding toggle
6. `project-conventions.ts`: add `isConfigured()`, AC override prompt, session override prompt

**Files**: `packages/core/src/setup/sections/*.ts`

---

#### T9596 — CLI: --config-json + --reset + new flags

**Parent**: T9591  
**Depends on**: T9592  
**Kind**: work  
**Sizing**: small  
**Priority**: high  
**Acceptance**:
- `cleo setup --config-json '{"identity":{"agentName":"Atlas"}}'` applies non-interactively | `cleo setup --reset` passes `options.reset = true` to runner | All new flags (`--retention-days`, `--signaldock-enabled`, `--signaldock-endpoint`, `--studio-enabled`) parsed and threaded into `WizardOptions` | `buildWizardOptions()` function extended and documented | `--section` flag description updated to list all 8 valid names | CLI test suite updated

**Subtasks**:
1. Add `--config-json` arg + parse + merge logic in `buildWizardOptions()`
2. Add `--reset` arg
3. Add `--retention-days`, `--signaldock-enabled`, `--signaldock-endpoint`, `--studio-enabled` args
4. Update `setupCommand.meta.description` to mention all 8 sections
5. Update CLI tests

**Files**: `packages/cleo/src/cli/commands/setup.ts`

---

#### T9597 — ReadlineWizardIO: paste sanitize + WizardInterruptError + select menu

**Parent**: T9591  
**Depends on**: T9592  
**Kind**: work  
**Sizing**: small  
**Priority**: medium  
**Acceptance**:
- Pasted API keys with `\x1b[200~` prefix are stripped before return | `WizardInterruptError` thrown on Ctrl-C / EOF during any prompt | CLI command catches `WizardInterruptError` and prints `Setup interrupted. Run 'cleo setup' to continue.` then exits 130 | `select()` presents a numbered list to stdout before accepting input

**Subtasks**:
1. Add bracketed paste strip helper
2. Apply strip to all `prompt()` responses
3. Handle `SIGINT`/`close` events → throw `WizardInterruptError`
4. Catch `WizardInterruptError` in `setup.ts` command run handler
5. Improve `select()` to emit numbered list

**Files**: `packages/cleo/src/cli/lib/readline-wizard-io.ts`, `packages/cleo/src/cli/commands/setup.ts`

---

#### T9598 — WizardRunner: skip logic + first-run completion + progress prefix

**Parent**: T9591  
**Depends on**: T9592, T9595  
**Kind**: work  
**Sizing**: small  
**Priority**: high  
**Acceptance**:
- Sections with `isConfigured() → true` are skipped unless `options.reset === true` | Skip emits `io.info('[skip] <title> — already configured. Use --reset to reconfigure.')` | Section headers use `[N/total] title (section-id)` format | `auth.firstRunComplete = true` written to global config after a successful full-run (no `failed:` lines) | Existing tests updated to match new header format

**Subtasks**:
1. Extend `WizardRunner.run()` with `isConfigured()` skip logic
2. Extend `WizardRunner.run()` with first-run completion write
3. Update section header format
4. Update wizard tests

**Files**: `packages/core/src/setup/wizard.ts`, `packages/core/src/setup/__tests__/wizard.test.ts`

---

#### T9599 — Tests: integration test suite for all 8 sections

**Parent**: T9591  
**Depends on**: T9593, T9594, T9595, T9596, T9597, T9598  
**Kind**: work  
**Sizing**: medium  
**Priority**: high  
**Acceptance**:
- Each section has a describe block with: happy-path interactive, happy-path non-interactive, `isConfigured()` short-circuit, reset-override, invalid-input handling | `verification` section tests mock all 6 external checks | CLI `--config-json` round-trip test | CLI `--reset` test | `WizardInterruptError` propagation test | Zero new test failures on `pnpm run test`

**Subtasks**:
1. Integration tests for `integrations` section (6 cases)
2. Integration tests for `verification` section (8 cases — one per check + full-pass + partial-fail)
3. Tests for `isConfigured()` on all 6 extended sections
4. `--config-json` CLI test
5. `WizardRunner` skip-logic + first-run-completion tests
6. `ReadlineWizardIO` paste-sanitize + interrupt tests

**Files**: `packages/core/src/setup/__tests__/wizard.test.ts`, `packages/core/src/setup/__tests__/sections/`, `packages/cleo/src/cli/commands/__tests__/setup-command.test.ts`

---

## 6. Worker Dispatch + Ship Plan

### 6.1 Wave Structure

Dependency-safe execution waves:

```
Wave 0 (unblocked):
  T9592 — Shared infra (foundation for all other tasks)

Wave 1 (depends only on T9592):
  T9593 — integrations section
  T9594 — verification section
  T9595 — extend existing 6 sections
  T9596 — CLI: --config-json + --reset + new flags
  T9597 — ReadlineWizardIO improvements

Wave 2 (depends on Wave 1 complete):
  T9598 — WizardRunner: skip logic + first-run completion

Wave 3 (depends on Wave 2 complete):
  T9599 — Full integration test suite
```

### 6.2 Parallel Agent Dispatch

All Wave 1 tasks CAN run in parallel — they touch independent files:

| Task | Primary Files | Worker Role |
|------|--------------|-------------|
| T9592 | `wizard.ts`, `index.ts` | Core infra worker |
| T9593 | `sections/integrations.ts` | Section worker |
| T9594 | `sections/verification.ts` | Section worker |
| T9595 | `sections/identity.ts`, `sections/llm.ts`, `sections/sentient.ts`, `sections/harness.ts`, `sections/brain.ts`, `sections/project-conventions.ts` | Section worker (extends 6 files; single worker preferred to avoid merge conflicts) |
| T9596 | `cli/commands/setup.ts` | CLI worker |
| T9597 | `cli/lib/readline-wizard-io.ts`, `cli/commands/setup.ts` | CLI worker (coordinate with T9596 on setup.ts) |

**Note**: T9596 and T9597 both touch `setup.ts`. They MUST be assigned to the same worker or sequenced.

### 6.3 PR Strategy

Single PR per wave. Each PR targets `main`:

- **Wave 0 PR**: `feat/T9592-wizard-core-infra`
- **Wave 1 PR**: `feat/T9591-setup-v2-wave1` (all Wave 1 tasks, commit-per-task)
- **Wave 2 PR**: `feat/T9591-setup-v2-wave2`
- **Wave 3 PR**: `feat/T9591-setup-v2-wave3`

Alternatively, squash all waves into a single `feat/T9591-setup-v2` PR after all waves pass CI locally — acceptable given no other active branches touching the setup package.

### 6.4 Quality Gates (pre-PR)

Each PR MUST pass before opening:

```bash
# 1. Format + lint
pnpm biome check --write .

# 2. Typecheck (CI gate — NOT just build)
pnpm run typecheck

# 3. Build
pnpm run build

# 4. Tests — zero new failures
pnpm run test

# 5. Scope check
git diff --stat HEAD
```

### 6.5 Migration from v2026.5.79+

The V2 wizard is additive:

- `WizardSection` union is extended (no breaking change — existing string literals are subsets)
- `WizardOptions` interface gains optional fields (no breaking change)
- `WizardSectionRunner.isConfigured()` is optional (no breaking change for custom sections)
- New `createBuiltinSections()` includes 2 new entries — operators who call `createDefaultWizardRunner()` get the new sections automatically
- The 6 existing sections gain `isConfigured()` — existing callers that construct custom runners with `new WizardRunner([...])` are unaffected
- `auth.firstRunComplete` is a new config key — if absent, the first run of `cleo setup` from V2 will set it

No data migration is required. No breaking changes.

---

## 7. Open Questions / Future Work

The following items are explicitly OUT OF SCOPE for V2 (document for future epic):

1. **Auto-prompt on first `cleo` invocation**: detecting first-run and surfacing `cleo setup` interactively before the main command runs. Requires hooking into the CLI entry point.

2. **`cleo doctor` integration**: the `verification` section is a wizard-time health check. A persistent `cleo doctor` command that runs the same checks on-demand would complement it.

3. **Plugin-registered sections**: custom `WizardSectionRunner` implementations registered by plugins via `cleo plugin install`. The `WizardRunner` constructor already supports custom sections; the plugin registration hook is future work.

4. **Web-based setup (Studio `/setup` route, T-E3-8)**: Studio already consumes `WizardRunner.runSection()`; the full Studio setup UI is tracked under E-CONFIG-AUTH-UNIFY.

5. **Pi URL validation with live connectivity**: HARN-3 validates URL format only. A live HTTP check belongs in `verification` (already covered) but not in the `harness` section itself.

6. **Credential rotation wizard**: guide operators through rotating expired credentials without losing pool continuity.
