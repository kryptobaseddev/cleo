# E-AUDIT-V2-FIXES — Post-Audit Bug Fix Specification

**Epic**: E-AUDIT-V2-FIXES (T9587)
**Saga**: SG-CLEO-CORE-V2 (T9585)
**Date**: 2026-05-18
**Status**: SPECIFICATION

Source: 12 bugs from `.cleo/agent-outputs/T9573-AUDIT-ROLLUP.md` — post-audit of
E-CONFIG-AUTH-UNIFY deliverables (v2026.5.78).

---

## 1. Research — Root Cause File:Line Analysis

All line references are against `main` HEAD as of 2026-05-18 (post-v2026.5.79).

### Bug 1 — `cleo setup` LAFS broken: `io.info()` corrupts stdout

**File**: `packages/cleo/src/cli/lib/readline-wizard-io.ts:109-111`

```ts
info(message: string): void {
  process.stdout.write(`${message}\n`);  // <-- writes to stdout
}
```

The `WizardIO.info()` contract says "informational message (goes to stdout in the CLI)"
but `cliOutput()` also writes its JSON envelope to stdout. When the wizard runs any
section (`WizardRunner.run()` in `wizard.ts:266` calls `io.info(...)` before every
section header), those strings arrive on stdout before `cliOutput()` emits its envelope.
Piping `cleo setup ... | jq` sees mixed text + JSON and fails.

The `ReadlineWizardIO` docstring at line 28 says "`info` writes to stdout (the human
channel)". This is correct for interactive TTY use but breaks the machine-readable path.
The fix is to route `info()` to `stderr`, matching `warn()` and `error()`.

### Bug 2 — `cleo setup --non-interactive` missing `--harness` and `--brain-bridge-mode`

**File**: `packages/cleo/src/cli/commands/setup.ts:199-263`

The `setupCommand` `args` block defines these flags: `section`, `non-interactive`,
`provider`, `api-key`, `label`, `agent-name`, `strictness`, `project-root`.

The `buildWizardOptions()` function at line 95 also maps only those flags. Neither
`--harness` nor `--brain-bridge-mode` appears anywhere in `setup.ts`.

The `WizardOptions` type in `wizard.ts:89-128` defines `harness?: 'pi' | 'claude-code'`
and `brainBridgeMode?: 'digest' | 'file' | 'disabled'` — they exist in the engine
but have no CLI surface. The `harness.ts` section at line 68 checks
`options.nonInteractive === true && !options.harness` and short-circuits silently.

The CLI `--section` description at line 207 lists "llm | identity | sentient |
project-conventions" — omitting `harness` and `brain`. That is the `--help` bug (Bug 9).

### Bug 3 — `cleo status.identity.agentId` always null

**File**: `packages/core/src/setup/sections/identity.ts:88` (writer)
and `packages/core/src/status/index.ts:211-224` (reader)

Writer (`identity.ts:88`):
```ts
await setConfigValue('agent.name', name, projectRoot, { global: true });
```
Writes key `agent.name` to global config.

Reader (`status/index.ts:211-224`):
```ts
const top = global['agentId'];          // looks for 'agentId' at root
// ...
const nested = (identity as ...)['agentId']; // looks for 'identity.agentId'
```
Reads `global.agentId` or `global.identity.agentId`. Neither matches `agent.name`.

**Fix**: align the reader to check `agent.name` (preferred) OR update both reader and
writer to use a canonical `identity.agentId` key. Given that `agent.name` is the
display name and `agentId` semantically means an ID, the cleanest fix is:
- Writer: also write `identity.agentId` when a name is set (derive from name or use a
  UUID), OR
- Reader: check `agent.name` and surface it as `agentId` in the status response.

The simpler approach: reader checks `global['agent']?.['name']` as a fallback when the
`agentId` keys are absent. This avoids a schema migration and keeps backward compat.

### Bug 4 — `cleo status.harness.active` always "unknown"

**File**: `packages/core/src/status/index.ts:176-181`

```ts
function detectHarness(): CleoStatus['harness'] {
  const raw = process.env['CLEO_HARNESS'];
  const active = raw === 'pi' || raw === 'claude-code' ? raw : 'unknown';
  return { active, healthy: true, issues: [] };
}
```

This only checks `CLEO_HARNESS`. The richer cascade in
`packages/core/src/orchestration/harness-hint.ts` also checks:
- `CLEO_HARNESS_LOADS_AGENTS_MD=1` (step 2b)
- Persisted `<projectRoot>/.cleo/harness-profile.json` (step 3)
- `CLAUDECODE=1` AND `CLAUDE_CODE_ENTRYPOINT` (step 4)

In Claude Code environments, `CLAUDECODE=1` is always set (confirmed by the audit
operator) but `CLEO_HARNESS` is not. So `detectHarness()` returns `'unknown'` even
though `resolveHarnessHint()` would return `{ hint: 'claude-code', source: 'auto-detect' }`.

Also, the harness setup section writes to `harness.active` in global config via
`setConfigValue('harness.active', ...)` but `detectHarness()` in status never reads
the config — only the env var.

**Fix**: replace the inline `detectHarness()` with a call to `resolveHarnessHint()`
from `packages/core/src/orchestration/harness-hint.ts` (pass `projectRoot`).

### Bug 5 — Anthropic OAuth missing from pool: no CLI surface for `auth.claudeCodeConsentGiven`

**File**: `packages/core/src/llm/credential-seeders/claude-code-seeder.ts:68`
and `packages/cleo/src/cli/commands/auth.ts`

The `ClaudeCodeSeeder.isConsentEstablished()` reads `getConfigValue('auth.claudeCodeConsentGiven')`.
Default is `false`. The only way to enable it today is `cleo config set --global auth.claudeCodeConsentGiven true`
which is invisible to users since it is not documented in `cleo auth --help` or `cleo setup`.

**Fix**: add a `cleo auth claude-code consent` subcommand (or integrate into
`cleo setup --section llm`) that toggles `auth.claudeCodeConsentGiven`. Additionally,
`cleo setup` interactive LLM section should offer to enable it when the user picks
`anthropic` as their provider and the Claude Code credential file exists.

### Bug 6 — Consent revoke doesn't purge persisted token

**File**: `packages/cleo/src/cli/commands/auth/remove.ts` (exists, correct flow)
and the consent disable path (missing).

`cleo auth remove anthropic claude-code` correctly: invokes `CLAUDE_CODE_REMOVAL_STEP`
(suppress=true), calls `addSuppression('anthropic', 'claude-code')`, and then
`removeCredential(entry.provider, label)` to purge from `llm-credentials.json`.

The bug is the **consent revoke path**: there is no `cleo auth claude-code revoke`
command. The operator turning off consent via `cleo config set --global
auth.claudeCodeConsentGiven false` only stops future seeding — it does NOT delete the
already-persisted entry in `llm-credentials.json`. Pool.pick() still finds and serves
the cached token.

**Fix**: the consent-disable CLI surface (Bug 5's command) MUST also call
`removeCredential('anthropic', 'claude-code')` and `addSuppression(...)` when the user
disables consent, mirroring what `cleo auth remove` does.

### Bug 7 — Studio dev server HTTP 500: `@cleocode/cant` CJS force-inlined by Vite SSR

**File**: `packages/studio/vite.config.ts:69-74`

```ts
ssr: {
  noExternal: [/^@cleocode\//],   // forces bundling ALL @cleocode/* packages
  external: ['loro-crdt', 'llmtxt'],
}
```

`@cleocode/cant` uses `require()` and `__dirname` (CJS globals) in
`native-loader.ts:144,147,153,441`. These are unavailable in an ESM bundle.
When Vite SSR tries to inline-bundle `@cleocode/cant` (because `noExternal`
matches `/^@cleocode\//`), it fails with a build/runtime error surfaced as HTTP 500.

`@cleocode/cant/package.json` has no `"type"` field (defaults to CJS entry) and no
`exports` map — it ships as a CJS package that must be `require()`-d, not bundled.

**Fix**: add `'@cleocode/cant'` to `ssr.external` so Vite leaves it as a Node
`require()` call at runtime rather than attempting ESM inlining.

### Bug 8 — `cleo status credentials[].source = "none"` for cli-input entries

**File**: `packages/core/src/llm/credential-seeders/index.ts:63-70` (type)
and `packages/core/src/setup/sections/llm.ts:160` (writer)
and `packages/core/src/status/index.ts:119-131` (narrower)

The `llm` setup section writes `source: 'cli-input'` at line 160:
```ts
source: 'cli-input',
```

But `SeederSourceId` only includes: `env | claude-code | cleo-pkce | codex-cli |
gemini-cli | gh-cli | manual`. No `'cli-input'`.

`KNOWN_SEEDER_SOURCES` in `status/index.ts:119-127` mirrors `SeederSourceId` and
therefore also lacks `'cli-input'`. So `narrowSeederSource('cli-input')` returns
`'none'`.

**Fix**: rename the write in `llm.ts` from `'cli-input'` to `'manual'` (which is the
semantically correct value for operator-provided credentials), OR add `'cli-input'` to
`SeederSourceId`. The cleaner fix is rename to `'manual'` since `SeederSourceId`
already documents `manual` as "operator-added entry via `cleo llm add` or store edit".

### Bug 9 — `cleo setup --help` shows 4 of 6 sections

**File**: `packages/cleo/src/cli/commands/setup.ts:207-210` (section arg description)
and line 200-204 (meta.description)

The `section` arg description says:
```
'Run only one named section. Valid: llm | identity | sentient | project-conventions'
```

`meta.description` at line 200-204 also lists only those four. Both omit `harness`
and `brain`.

**Fix**: update both strings to include all 6 sections.

### Bug 10 — Setup readline EOF exits 0 with no JSON

**File**: `packages/cleo/src/cli/commands/setup.ts:242-262`

```ts
async run({ args }) {
  const io = new ReadlineWizardIO();
  let result: CleoSetupResult;
  try {
    result = await runSetup(args as Record<string, unknown>, io);
  } finally {
    io.close();
  }
  cliOutput(result, ...);
  if (!result.ok) process.exit(1);
}
```

When stdin closes (EOF), `rl.question()` rejects with an error (or resolves to `''`
on some Node versions). The `WizardRunner.invokeSection` wrapper catches section-level
exceptions but `ReadlineWizardIO.confirm()` and `prompt()` both call `rl.question()`
directly without EOF handling. The rejection propagates past `try/finally` and no
`cliOutput()` call is made.

The `finally` block does call `io.close()` so stdin is released, but `result` is never
assigned and no LAFS envelope is emitted, leaving the process with exit code 1 and no
stdout.

**Fix**: in `ReadlineWizardIO.prompt()` and `confirm()`, catch the `rl.question()`
rejection and convert it to an empty string response (treating EOF as "no answer").
Also wrap `setupCommand.run()` in a top-level try/catch to emit a `cliError` envelope
on unexpected failures.

### Bug 11 — gh-cli seeder mistags `provider: 'openai'`

**File**: `packages/core/src/llm/credential-seeders/gh-cli-seeder.ts:95,112-119`

```ts
readonly provider = 'openai';
// ...
entries: [{
  provider: 'openai',
  label: 'gh-cli',
  ...
}]
```

The docstring claims "GitHub Copilot's API is OpenAI-compatible and routes through
OpenAI's transport". This is architecturally wrong: while the GitHub Copilot API
is _protocol_-compatible with OpenAI's chat completions format, the credential is
not valid for `api.openai.com` — it only works with `api.githubcopilot.com`.

`packages/core/src/llm/generated/provider-profiles.ts:265` defines a
`'github-copilot'` provider with `baseUrl: 'https://api.githubcopilot.com'`.
The gh-cli seeder should tag credentials as `provider: 'github-copilot'` so the
resolver routes them through the correct base URL.

**Fix**: change `provider = 'openai'` to `provider = 'github-copilot'` in
`GhCliSeeder` and update all references.

### Bug 12 — codex-cli seeder produces unusable ChatGPT OAuth token

**File**: `packages/core/src/llm/credential-seeders/codex-cli-seeder.ts:124-138`

The seeder reads `tokens.access_token` from `~/.codex/auth.json` when the user
authenticated via the ChatGPT consumer OAuth flow (`codex login` with a ChatGPT
account, not an API key). This token is a session token for `chatgpt.com`, NOT an
API key for `api.openai.com`. OpenAI's inference API rejects consumer OAuth tokens.

The seeder already has a second path for `OPENAI_API_KEY` (line 144-151) which
correctly seeds an API-key credential. The ChatGPT OAuth path is the problematic one.

**Fix options**:
- Option A (minimal): skip the `tokens.access_token` path when `auth_mode === 'chatgpt'`
  in `auth.json`. The Codex CLI writes `auth_mode` when the user uses ChatGPT login.
- Option B (correct): tag these tokens with `label: 'codex-cli-chatgpt'` and emit a
  warning in `SeederResult.warnings[]` so the operator understands they need an API key
  for inference. Do NOT add them to the pool under `'openai'` provider.

Option B is preferred because it surfaces the problem to operators rather than silently
ignoring legitimate credentials.

---

## 2. Consensus — Fix Strategy

| Bug | Strategy | Complexity |
|-----|----------|------------|
| 1. info() stdout | Route `info()` to stderr in `ReadlineWizardIO` | XS — 1 line |
| 2. Missing flags | Add `--harness` + `--brain-bridge-mode` to `setup.ts` args + `buildWizardOptions()` | S — ~30 lines |
| 3. agentId key mismatch | Reader checks `global['agent']?.['name']` as fallback | XS — ~5 lines |
| 4. Harness detection | Replace inline `detectHarness()` with `resolveHarnessHint()` | S — ~10 lines |
| 5. Consent CLI surface | Add `cleo auth claude-code consent` + integrate in setup LLM section | M — new subcommand + wiring |
| 6. Revoke doesn't purge | Consent-disable path calls `removeCredential` + `addSuppression` | S — ~20 lines in consent CLI |
| 7. Studio SSR 500 | Add `'@cleocode/cant'` to `ssr.external` in vite.config.ts | XS — 1 line |
| 8. source="none" | Rename `'cli-input'` → `'manual'` in llm.ts | XS — 1 line |
| 9. --help incomplete | Update `section` arg description + meta.description in setup.ts | XS — 2 strings |
| 10. EOF exits 0 no JSON | EOF guard in `ReadlineWizardIO` + top-level try/catch in command | S — ~15 lines |
| 11. gh-cli mistagged | `provider = 'github-copilot'` in GhCliSeeder | XS — 1 line + test |
| 12. codex-cli unusable | Skip/warn ChatGPT OAuth tokens in CodexCliSeeder | S — ~15 lines |

**Grouping decisions**:

- Bugs 1, 9, 10 share the `setup.ts` / `readline-wizard-io.ts` files → Task A
- Bugs 2, 9 share setup.ts CLI surface → also Task A
- Bug 3, 4, 8 are all in `status/index.ts` or its feed paths → Task B (status accuracy)
- Bugs 5, 6 are auth consent surface (new CLI command) → Task C
- Bug 7 is a standalone one-liner in Studio → Task D
- Bugs 11, 12 are both credential-seeder mistagging → Task E
- Task F: integration tests verifying every fix end-to-end

---

## 3. Architecture — Shared Types and Utilities

### 3.1 No new shared types required for most fixes

Bugs 1, 2, 3, 4, 7, 8, 9, 10 are all in existing files with no new type surface needed.

### 3.2 Bug 11 — `provider: 'github-copilot'` type impact

`GhCliSeeder.provider = 'openai'` is declared as `readonly provider = 'openai'`.
Changing to `'github-copilot'` means the provider field will be a `string` that is
a valid `BuiltinProviderId` / `ModelTransport` string but is not currently listed as
a `BuiltinProviderId` in `packages/contracts/src/llm/provider-id.ts`.

**Decision**: add `'github-copilot'` to `BuiltinProviderId` OR keep `provider` as
`string` on the seeder (it already satisfies the `CredentialSeeder` interface). Since
`github-copilot` exists in `generated/provider-profiles.ts`, the clean path is to add
it to `BuiltinProviderId`. This is a contracts change but is backward-compatible
(extending the union, not restricting it).

### 3.3 Bug 5/6 — New `cleo auth claude-code` subcommand

The consent surface introduces a new subcommand tree: `cleo auth claude-code consent`
(enable/disable) and potentially `cleo auth claude-code status`. It lives in
`packages/cleo/src/cli/commands/auth/claude-code.ts` and exports a
`authClaudeCodeCommand` to be registered in `auth/index.ts`.

The revoke path (Bug 6) is co-located in `claude-code.ts`: on disable, it imports
`removeCredential` from `credentials-store.ts` and `addSuppression` from
`credential-removal.ts` and calls both.

---

## 4. Specification (RFC 2119 Acceptance Criteria per Task)

### Task A — Setup stdout discipline + CLI completeness

**Scope**: `packages/cleo/src/cli/lib/readline-wizard-io.ts`,
`packages/cleo/src/cli/commands/setup.ts`

**AC-A-1**: `ReadlineWizardIO.info()` MUST write to `process.stderr`, not `process.stdout`.
**AC-A-2**: `cleo setup ... | jq` MUST parse without error (no text before JSON envelope).
**AC-A-3**: `setupCommand` args MUST include `--harness` accepting `'pi' | 'claude-code'`.
**AC-A-4**: `setupCommand` args MUST include `--brain-bridge-mode` accepting `'digest' | 'file' | 'disabled'`.
**AC-A-5**: `buildWizardOptions()` MUST map `--harness` → `options.harness` and `--brain-bridge-mode` → `options.brainBridgeMode`.
**AC-A-6**: `cleo setup --help` section description MUST list all 6 sections: `llm | identity | sentient | project-conventions | harness | brain`.
**AC-A-7**: When stdin closes (EOF) during interactive prompting, `ReadlineWizardIO.prompt()` MUST return `''` instead of rejecting.
**AC-A-8**: When stdin closes (EOF) during interactive prompting, `ReadlineWizardIO.confirm()` MUST return `defaultValue ?? false` instead of rejecting.
**AC-A-9**: `setupCommand.run()` MUST emit a LAFS error envelope and exit non-zero when `runSetup()` throws unexpectedly (e.g. from an EOF-caused exception that escapes section guards).
**AC-A-10**: `cleo setup --non-interactive --harness claude-code` MUST persist `harness.active=claude-code` in global config without prompting.
**AC-A-11**: `cleo setup --non-interactive --brain-bridge-mode digest` MUST persist `brain.memoryBridge.mode` appropriately without prompting.

### Task B — Status accuracy: identity, harness, source

**Scope**: `packages/core/src/status/index.ts`, `packages/core/src/setup/sections/identity.ts`

**AC-B-1**: `getCleoStatus().identity.agentId` MUST return the value stored at `agent.name` in global config when no `agentId` / `identity.agentId` key is present.
**AC-B-2**: `getCleoStatus().harness.active` MUST return `'claude-code'` when `CLAUDECODE=1` is set in the environment (even when `CLEO_HARNESS` is unset).
**AC-B-3**: `getCleoStatus().harness.active` MUST return `'claude-code'` when `harness.active` is persisted in global config as `'claude-code'` (even when env vars are absent).
**AC-B-4**: The status `detectHarness()` function MUST delegate to `resolveHarnessHint({ projectRoot })` from `packages/core/src/orchestration/harness-hint.ts`.
**AC-B-5**: `getCleoStatus().credentials[].source` MUST return `'manual'` (not `'none'`) for credentials added via `cleo setup --section llm --non-interactive --api-key ...`.
**AC-B-6**: The LLM section `applyLlmCredential()` MUST write `source: 'manual'` (not `source: 'cli-input'`).
**AC-B-7**: `KNOWN_SEEDER_SOURCES` in `status/index.ts` MUST remain aligned with `SeederSourceId` in `credential-seeders/index.ts` (no `'cli-input'` in either after the fix).

### Task C — Anthropic OAuth consent CLI surface

**Scope**: `packages/cleo/src/cli/commands/auth/claude-code.ts` (new),
`packages/cleo/src/cli/commands/auth/index.ts`,
`packages/core/src/llm/credential-seeders/claude-code-seeder.ts`

**AC-C-1**: `cleo auth claude-code consent --enable` MUST set `auth.claudeCodeConsentGiven = true` in global config.
**AC-C-2**: `cleo auth claude-code consent --disable` MUST set `auth.claudeCodeConsentGiven = false` AND call `removeCredential('anthropic', 'claude-code')` AND call `addSuppression('anthropic', 'claude-code')`.
**AC-C-3**: `cleo auth claude-code consent --disable` MUST be idempotent: calling it a second time when no credential is present MUST NOT error.
**AC-C-4**: `cleo auth claude-code consent` (no flag) MUST print current consent state to stdout as a LAFS envelope.
**AC-C-5**: `cleo auth --help` MUST show the `claude-code` subcommand.
**AC-C-6**: When `--enable` is supplied and `~/.claude/.credentials.json` does not exist, the command MUST succeed with a warning (not error) noting the credential file is absent.
**AC-C-7**: When `--disable` is supplied and no pool entry labelled `'claude-code'` exists under `'anthropic'`, the `removeCredential` call MUST be a no-op (idempotent).

### Task D — Studio SSR fix

**Scope**: `packages/studio/vite.config.ts`

**AC-D-1**: `'@cleocode/cant'` MUST appear in `ssr.external` in `vite.config.ts`.
**AC-D-2**: The Studio dev server (`pnpm --filter @cleocode/studio dev`) MUST return HTTP 200 on the root route (`/`).
**AC-D-3**: The fix MUST NOT add `@cleocode/cant` to `ssr.noExternal` (that would override the external setting).
**AC-D-4**: Existing Studio unit tests (19 tests) MUST continue to pass after the change.

### Task E — Credential seeder mistagging fixes

**Scope**: `packages/core/src/llm/credential-seeders/gh-cli-seeder.ts`,
`packages/core/src/llm/credential-seeders/codex-cli-seeder.ts`,
`packages/contracts/src/llm/provider-id.ts`

**AC-E-1**: `GhCliSeeder.provider` MUST be `'github-copilot'`, not `'openai'`.
**AC-E-2**: The seeded entry from `GhCliSeeder.seed()` MUST carry `provider: 'github-copilot'`.
**AC-E-3**: `'github-copilot'` MUST be added to `BuiltinProviderId` in `packages/contracts/src/llm/provider-id.ts`.
**AC-E-4**: `CodexCliSeeder.seed()` MUST detect when `auth.json` contains `auth_mode === 'chatgpt'` and skip the `tokens.access_token` entry.
**AC-E-5**: When `CodexCliSeeder.seed()` detects a ChatGPT OAuth token, it MUST include a human-readable warning in `SeederResult.warnings[]` explaining why the token is not seeded.
**AC-E-6**: `CodexCliSeeder.seed()` MUST still seed `OPENAI_API_KEY` entries regardless of `auth_mode`.
**AC-E-7**: Existing gh-cli and codex-cli seeder unit tests MUST be updated to reflect the new provider value and the new skip behaviour.

### Task F — Integration test pass

**Scope**: New test file `packages/core/src/__tests__/audit-v2-fixes.test.ts`
(or co-located with each package's test suite)

**AC-F-1**: A test MUST verify that `ReadlineWizardIO.info()` writes to stderr (not stdout).
**AC-F-2**: A test MUST verify that `cleo setup` with an EOF stdin completes without throwing.
**AC-F-3**: A test MUST verify `getCleoStatus()` returns `agentId` equal to `agent.name` when that config key is set.
**AC-F-4**: A test MUST verify `getCleoStatus()` returns `harness.active = 'claude-code'` when `CLAUDECODE=1` and `CLAUDE_CODE_ENTRYPOINT` are set in the env.
**AC-F-5**: A test MUST verify that a credential written with `source: 'manual'` appears with `source: 'manual'` (not `'none'`) in `getCleoStatus()`.
**AC-F-6**: A test MUST verify `GhCliSeeder.seed()` returns `provider: 'github-copilot'`.
**AC-F-7**: A test MUST verify `CodexCliSeeder.seed()` with a ChatGPT-mode `auth.json` returns no entries and at least one warning.

---

## 5. Decomposition — Tasks and Subtasks

### Task A — T9590: Setup stdout discipline + CLI completeness

**Files**: `packages/cleo/src/cli/lib/readline-wizard-io.ts`,
`packages/cleo/src/cli/commands/setup.ts`
**Size**: small | **Priority**: P1

**Subtasks**:
- **T9590-1**: Route `ReadlineWizardIO.info()` to stderr (1 line change)
- **T9590-2**: Add EOF guard to `ReadlineWizardIO.prompt()` and `confirm()` (~15 lines)
- **T9590-3**: Add `--harness` and `--brain-bridge-mode` args + `buildWizardOptions()` mapping (~30 lines)
- **T9590-4**: Update `section` arg description and `meta.description` to list all 6 sections (2 strings)
- **T9590-5**: Add top-level try/catch in `setupCommand.run()` to emit LAFS error envelope on unexpected failures (~10 lines)

**Gates**: `pnpm biome check --write .` + `pnpm run build` + `pnpm run test`
**Acceptance**: AC-A-1 through AC-A-11

---

### Task B — T9591: Status accuracy fixes

**Files**: `packages/core/src/status/index.ts`,
`packages/core/src/setup/sections/llm.ts`
**Size**: small | **Priority**: P1

**Subtasks**:
- **T9591-1**: Fix `buildIdentityBlock()` to read `global['agent']?.['name']` as agentId fallback (~5 lines in status/index.ts)
- **T9591-2**: Replace `detectHarness()` with `resolveHarnessHint()` call (~10 lines in status/index.ts)
- **T9591-3**: Rename `source: 'cli-input'` → `source: 'manual'` in `llm.ts:160` (1 line)

**Gates**: `pnpm biome check --write .` + `pnpm run build` + `pnpm run test`
**Acceptance**: AC-B-1 through AC-B-7

---

### Task C — T9592: Anthropic OAuth consent CLI surface

**Files**: `packages/cleo/src/cli/commands/auth/claude-code.ts` (new),
`packages/cleo/src/cli/commands/auth/index.ts`,
`packages/cleo/src/cli/commands/auth.ts`
**Size**: medium | **Priority**: P1

**Subtasks**:
- **T9592-1**: Create `auth/claude-code.ts` with `authClaudeCodeConsentCommand` (enable/disable/status)
- **T9592-2**: Register `claude-code` subcommand in `auth/index.ts` and `auth.ts`
- **T9592-3**: Implement `--enable` path: `setConfigValue('auth.claudeCodeConsentGiven', true)` + LAFS envelope
- **T9592-4**: Implement `--disable` path: set false + `removeCredential` + `addSuppression` + LAFS envelope
- **T9592-5**: Write unit tests for both paths (idempotency, missing credential, missing file)

**Gates**: `pnpm biome check --write .` + `pnpm run build` + `pnpm run test`
**Acceptance**: AC-C-1 through AC-C-7

---

### Task D — T9593: Studio SSR fix

**Files**: `packages/studio/vite.config.ts`
**Size**: XS | **Priority**: P0/P1

**Subtasks**:
- **T9593-1**: Add `'@cleocode/cant'` to `ssr.external` array (1 line)
- **T9593-2**: Verify Studio unit tests still pass (19 tests)

**Gates**: `pnpm biome check --write .` + `pnpm --filter @cleocode/studio run build` + Studio unit tests
**Acceptance**: AC-D-1 through AC-D-4

---

### Task E — T9594: Credential seeder mistagging fixes

**Files**: `packages/core/src/llm/credential-seeders/gh-cli-seeder.ts`,
`packages/core/src/llm/credential-seeders/codex-cli-seeder.ts`,
`packages/contracts/src/llm/provider-id.ts`
**Size**: small | **Priority**: P2

**Subtasks**:
- **T9594-1**: Add `'github-copilot'` to `BuiltinProviderId` in `packages/contracts/src/llm/provider-id.ts`
- **T9594-2**: Change `GhCliSeeder.provider` and emitted entry to `'github-copilot'`; update unit test
- **T9594-3**: Add `auth_mode` detection in `CodexCliSeeder.seed()` — skip tokens + emit warning for `auth_mode === 'chatgpt'`
- **T9594-4**: Update codex-cli unit tests for the new skip behaviour

**Gates**: `pnpm biome check --write .` + `pnpm run build` + `pnpm run test`
**Acceptance**: AC-E-1 through AC-E-7

---

### Task F — T9595: Integration test pass

**Files**: New test additions in existing test suites or a new
`packages/core/src/__tests__/audit-v2-integration.test.ts`
**Size**: medium | **Priority**: P2 (depends on A-E)

**Subtasks**:
- **T9595-1**: Write `ReadlineWizardIO.info()` stderr test (AC-F-1)
- **T9595-2**: Write EOF-stdin test for setup command (AC-F-2)
- **T9595-3**: Write `getCleoStatus()` agentId fallback test (AC-F-3)
- **T9595-4**: Write `getCleoStatus()` harness auto-detect test (AC-F-4)
- **T9595-5**: Write `getCleoStatus()` credentials source=manual test (AC-F-5)
- **T9595-6**: Write `GhCliSeeder.seed()` provider test (AC-F-6)
- **T9595-7**: Write `CodexCliSeeder.seed()` chatgpt-mode skip test (AC-F-7)

**Gates**: `pnpm run test` — zero new failures
**Acceptance**: AC-F-1 through AC-F-7

---

## 6. Worker Dispatch + Ship Plan

All tasks ship via: `git worktree → feature branch → PR → CI green → merge to main`.
`cleo release` is broken per constraint; use `gh pr merge --squash` after CI.

### Dependency order

```
T9590 (A) ─┐
T9591 (B) ─┤─→ T9595 (F)
T9592 (C) ─┤
T9593 (D) ─┘
T9594 (E) ─┘
```

Tasks A-E are independent and can be dispatched in parallel.
Task F depends on A-E being merged (integration tests verify the fixes).

### Per-task spawn instructions

**T9590 (Setup discipline)**:
```bash
git worktree add -B fix/T9590-setup-stdout /tmp/wt-T9590 origin/main
# Files: packages/cleo/src/cli/lib/readline-wizard-io.ts
#        packages/cleo/src/cli/commands/setup.ts
# Branch: fix/T9590-setup-stdout
# PR title: fix(T9590): setup stdout discipline + CLI flags for harness/brain
```

**T9591 (Status accuracy)**:
```bash
git worktree add -B fix/T9591-status-accuracy /tmp/wt-T9591 origin/main
# Files: packages/core/src/status/index.ts
#        packages/core/src/setup/sections/llm.ts
# Branch: fix/T9591-status-accuracy
# PR title: fix(T9591): status identity/harness/source accuracy
```

**T9592 (Consent CLI)**:
```bash
git worktree add -B fix/T9592-consent-cli /tmp/wt-T9592 origin/main
# Files: packages/cleo/src/cli/commands/auth/claude-code.ts (new)
#        packages/cleo/src/cli/commands/auth/index.ts
#        packages/cleo/src/cli/commands/auth.ts
# Branch: fix/T9592-consent-cli
# PR title: feat(T9592): cleo auth claude-code consent enable/disable
```

**T9593 (Studio SSR)**:
```bash
git worktree add -B fix/T9593-studio-ssr /tmp/wt-T9593 origin/main
# Files: packages/studio/vite.config.ts
# Branch: fix/T9593-studio-ssr
# PR title: fix(T9593): add @cleocode/cant to Studio SSR externals
```

**T9594 (Seeder mistagging)**:
```bash
git worktree add -B fix/T9594-seeder-tags /tmp/wt-T9594 origin/main
# Files: packages/core/src/llm/credential-seeders/gh-cli-seeder.ts
#        packages/core/src/llm/credential-seeders/codex-cli-seeder.ts
#        packages/contracts/src/llm/provider-id.ts
# Branch: fix/T9594-seeder-tags
# PR title: fix(T9594): gh-cli provider=github-copilot; skip codex chatgpt tokens
```

**T9595 (Integration tests)**:
```bash
# After T9590-T9594 are merged:
git worktree add -B fix/T9595-integration-tests /tmp/wt-T9595 origin/main
# Files: packages/core/src/__tests__/audit-v2-integration.test.ts (new)
#        packages/cleo/src/cli/commands/__tests__/setup-command.test.ts (extend)
# Branch: fix/T9595-integration-tests
# PR title: test(T9595): integration tests for E-AUDIT-V2-FIXES
```

### Merge checklist (per PR)

1. `pnpm biome check --write .` — zero lint errors
2. `pnpm run build` — zero type errors
3. `pnpm run test` — zero new test failures
4. PR description references task ID (e.g. "Closes T9590")
5. CI passes before merge
6. Merge via `gh pr merge --squash` (not rebase/merge-commit)

---

## 7. Summary Table

| Task | ID | Bugs | Size | Priority | Depends |
|------|----|------|------|----------|---------|
| Setup discipline + flags | T9590 | 1, 2, 9, 10 | S | P1 | — |
| Status accuracy | T9591 | 3, 4, 8 | S | P1 | — |
| Consent CLI surface | T9592 | 5, 6 | M | P1 | — |
| Studio SSR | T9593 | 7 | XS | P0 | — |
| Seeder mistagging | T9594 | 11, 12 | S | P2 | E-3 |
| Integration tests | T9595 | — | M | P2 | A–E |
