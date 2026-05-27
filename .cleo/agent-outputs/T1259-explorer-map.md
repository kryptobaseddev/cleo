# T1259 PSYCHE E2 — Explorer Surface Map

**Generated**: 2026-04-24 (overnight campaign pre-work)
**Purpose**: Fast decomposition context for the .127 orchestrator. Read-only analysis.
**Depends on**: T1258 E1 (canonical naming refactor) — must be done first

---

## 1. Surface Inventory

### 1.1 `cleo init --install-seed-agents` command handler

**Entry point (CLI)**: `packages/cleo/src/cli/commands/init.ts` lines 59-128
- `initCommand` defineCommand; `--install-seed-agents` flag at line 86
- Calls `initProject(initOpts)` from `@cleocode/core`

**Core implementation (`initProject`)**: `packages/core/src/init.ts`
- `InitOptions` interface: lines 65-85. `installSeedAgents?: boolean` at line 84
- `resolveSeedAgentsDir()`: lines 145-178 — resolves `@cleocode/agents/seed-agents/` via require.resolve + 5 fallback candidates
- `initAgentDefinition()`: lines 184-253 — installs `cleo-subagent` to `~/.agents/agents/` via symlink/copy
- **Seed-install block**: lines 841-868 — `if (opts.installSeedAgents)` block. Currently does **static file copy** from `seedDir` `.cant` files into `.cleo/agents/`. **This is the PRIMARY gap T1259 AC1 must fix.**
- `deployStarterBundle()`: lines 1035-1102 — deploys `@cleocode/agents/starter-bundle/` team + agent .cant files to `.cleo/cant/`. Called unconditionally during init (not gated on `--install-seed-agents`).

**Current behavior (must change)**: Lines 843-866 reads `.cant` files from `seedDir` and copies statically. AC1 requires this block to invoke `agent-architect` (with project-context.json + templates as inputs) and fall back to static copy only if agent-architect unavailable.

### 1.2 `agent-architect` agent definition

**Location**: `packages/agents/meta/agent-architect.cant` (114 lines)
- `kind: agent`, `version: 2`
- `role: specialist`, `model: opus`, `parent: cleo-prime` ← **R6 risk**: post-E1 the canonical orchestrator name changes
- Receives: `PROJECT_NAME`, `CANT_AGENTS_DIR`, `BUNDLE_VERSION` (required)
- Optional: `MODEL_OVERRIDE`, `TIER_OVERRIDE`, `SKILLS_JSON`, `DOMAINS_JSON`
- Constraints: LC-001 reads project-context.json; LC-002 reads from `packages/agents/seed-agents/`; OUT-004 writes to `$CANT_AGENTS_DIR`

**Resolver registration**: NOT registered. Lives only in `packages/agents/meta/`. **5-tier resolver has no path to `meta/`**.

### 1.3 Packaged-tier loader for agents

**5-tier registry resolver**: `packages/core/src/store/agent-resolver.ts`
- Tier order: project → global → packaged → fallback → universal
- `packaged` tier reads `@cleocode/agents/seed-agents/` (`{{var}}` templates)
- `fallback` synthesizes from bundled `.cant` files
- `universal` (5th) uses `@cleocode/agents/cleo-subagent.cant`

**Meta/ directory NOT in any tier lookup.** `meta/` listed in `packages/agents/package.json` `files[]` (line 11) but resolver has no code path checking `packages/agents/meta/*.cant`. For agent-architect to be invocable: either add DB row at packaged tier, OR add new resolver path (simpler: dedicated helper `resolveMetaAgentsDir()` mirroring `resolveSeedAgentsDir()`).

**`resolveStarterBundle()` helper**: `packages/core/src/agents/resolveStarterBundle.ts` — exports `resolveStarterBundle()`, `resolveStarterBundleAgentsDir()`, `resolveStarterBundleTeamFile()`, `resolveStarterBundleIdentityFile()`. **No equivalent `resolveMetaAgentsDir()`.**

### 1.4 Playbook command surface

**CLI handler**: `packages/cleo/src/cli/commands/playbook.ts` (165 lines)
- Current subcommands: `run`, `status`, `resume`, `list`
- All route through `dispatchFromCli` → `playbook` domain
- **Missing: `create` subcommand.** AC5 requires adding it.
- Root `playbookCommand` export at line 148.

**Dispatch domain**: `packages/cleo/src/dispatch/domains/playbook.ts` (confirmed via `@cleocode/playbooks` wiring in `build.mjs`).

**`playbook-architect.cant`**: Does NOT exist at `packages/agents/meta/playbook-architect.cant`. AC4 requires authoring it.

### 1.5 pnpm pack / publish workflow

**Release workflow**: `.github/workflows/release.yml`
- Version-sync loop at line 117 covers `packages/agents` (already in list)
- npm publish order at line 481: contracts → lafs → worktree → git-shim → core → caamp → cant → nexus → brain → runtime → adapters → agents → skills → playbooks → cleo → cleo-os
- `@cleocode/agents` already published per release. No new publish loop for existing `agents` package.

**AC9: `@cleocode/agents-starter` package**:
- Does NOT exist. No `packages/agents-starter/`.
- NEW package requires: `packages/agents-starter/package.json`, `publishConfig`, source, addition to version-sync loop AND publish loop.
- Boundary: per AGENTS.md, belongs alongside `packages/agents/`. Alternative: subset export from `@cleocode/agents` (no new package). **Risk: 17th package; release.yml needs new `publish_pkg` call + version-sync entry.**

**`build.mjs` impact**: `@cleocode/agents` has no `dist/` (ships raw `.cant`). No esbuild entry needed. Same for `agents-starter`.

### 1.6 Where `cleo agent mint` would live

**Current `agent` subcommand surface**: `packages/cleo/src/cli/commands/agent.ts`
- Existing subcommands (lines 2819-2845): `doctor`, `register`, `signin`, `start`, `stop`, `status`, `assign`, `wake`, `spawn`, `reassign`, `stop-all`, `work`, `list`, `get`, `attach`, `detach`, `remove`, `rotate-key`, `claim-code`, `watch`, `poll`, `send`, `health`, `install`, `pack`, `create`
- **`mint` does not exist.** AC8 requires adding.
- New `const mintCommand = defineCommand(...)` registered in `agentCommand.subCommands` at line 2844 area.
- Semantic: `mint` invokes `agent-architect` to synthesize from a `.cant` spec file. `create` scaffolds from static role templates. `mint` = meta-agent-driven; `create` = static.

### 1.7 `user_profile` + `project-context.json` threading

**user_profile (PSYCHE Wave 1)**:
- SDK: `packages/core/src/nexus/user-profile.ts` — `listUserProfile()`, `upsertUserProfile()`
- CLI: `cleo nexus profile view` → `nexus.profile.view`
- In `buildRetrievalBundle`: cold pass calls `fetchIdentity(peerId, nexusDb)` → `listUserProfile(nexusDb, { minConfidence: 0.5 })` (brain-retrieval.ts:1628-1646)

**project-context.json**:
- Written by `ensureProjectContext()` in `packages/core/src/scaffold.ts` during init
- Located at `.cleo/project-context.json`
- Schema example at `.cleo/project-context.json` (committed to repo)

**Threading into agent-architect (AC6)**: when `initProject({ installSeedAgents: true })` runs, both available. Invocation shim must read both, serialize as JSON tokens, pass as `SKILLS_JSON`/`DOMAINS_JSON` or new `PROJECT_CONTEXT` token.

### 1.8 M1 spawn-retrieval-parity AcceptanceGate

**M1 requires**: `composeSpawnPayload({ taskId }).retrievalBundle` defined and structurally matches briefing-path retrieval. Test file: `packages/core/src/orchestration/__tests__/spawn-retrieval-parity.test.ts` (does not exist).

**Current state**:
- `buildRetrievalBundle`: `packages/core/src/memory/brain-retrieval.ts:1918` — fully implemented, returns `RetrievalBundle`
- `computeBriefing` in `briefing.ts:212-238` — calls `buildRetrievalBundle`, populates `bundle` field
- `composeSpawnPayload` in `packages/core/src/orchestration/spawn.ts` — does NOT call `buildRetrievalBundle`. **SDK-complete but NOT wired (Lesson 7).**
- `SpawnPayload` type (spawn.ts:188-210) — no `retrievalBundle` field

**M1 closes only when T1260 (E3) ships.** Test authored in E2 as RED gate; turns green when E3 wires `composeSpawnPayload → buildRetrievalBundle`.

---

## 2. Dependency Map

```
packages/cleo (CLI — thin)
  ├── commands/init.ts          → @cleocode/core (initProject)
  ├── commands/agent.ts         → @cleocode/core/internal (AgentRegistryAccessor, installAgentFromCant)
  └── commands/playbook.ts      → dispatch/adapters/cli.js → @cleocode/playbooks

packages/core (SDK)
  ├── init.ts                   → agents/resolveStarterBundle.ts, scaffold.ts, injection.ts, @cleocode/caamp
  ├── agents/resolveStarterBundle.ts → @cleocode/agents (require.resolve)
  ├── store/agent-resolver.ts   → @cleocode/agents (seed-agents/, cleo-subagent.cant)
  ├── orchestration/spawn.ts    → store/agent-resolver.ts, classify.ts, spawn-prompt.ts
  ├── sessions/briefing.ts      → memory/brain-retrieval.ts (buildRetrievalBundle)
  └── memory/brain-retrieval.ts → store/nexus-sqlite.ts, memory-sqlite.ts, data-accessor.ts

packages/agents (data-only — no dist/)
  ├── meta/agent-architect.cant    ← needs resolver path
  ├── meta/playbook-architect.cant ← NOT YET AUTHORED
  ├── seed-agents/*.cant            ← {{var}} templates (security-worker pending E1)
  ├── starter-bundle/               ← direct-use .cant files
  └── cleo-subagent.cant            ← universal base

packages/contracts
  └── RetrievalBundle, RetrievalRequest → consumed by brain-retrieval.ts, briefing.ts; spawn.ts not yet
```

**Package-boundary risks**:
- AC1 (agent-architect invocation) lives in `packages/core/src/init.ts` — NOT `packages/cleo/`. SDK logic.
- AC8 (`cleo agent mint`) is CLI verb — thin handler in `packages/cleo/src/cli/commands/agent.ts`; actual logic in new `packages/core/src/agents/mint-agent.ts`.
- AC9 (`@cleocode/agents-starter`) — if new package, alongside `packages/agents/`. If subset export, no new dir.
- Do NOT add meta-agent invocation logic to `packages/cleo/` (violates thin-CLI rule).

---

## 3. Test Surface

| File | Describe | Notes |
|------|----------|-------|
| `packages/core/src/orchestration/__tests__/spawn.test.ts` | composeSpawnPayload tier 0/1/2, harnessHint dedup, atomicity, W2-4 real resolve | No retrievalBundle assertions |
| `packages/core/src/orchestration/__tests__/classify.test.ts` | classifyTask persona resolution, confidence floor, fallback | Standalone, no DB |
| `packages/core/src/store/__tests__/agent-resolver.test.ts` | (inferred — tests 5-tier resolve) | Real SQLite + fixtures |

**Missing — author in E2**:
- `packages/core/src/orchestration/__tests__/spawn-retrieval-parity.test.ts` — M1 red test
- `packages/core/src/agents/__tests__/resolve-meta-agents-dir.test.ts` — for new helper
- `packages/core/src/__tests__/init-seed-agents.test.ts` — agent-architect invocation path
- `packages/cleo/src/cli/commands/__tests__/playbook-create.test.ts` — AC5

---

## 4. Atomic Decomposition Proposal (7 worker tasks under T1259)

### T1259-W1 — `resolveMetaAgentsDir` SDK helper + agent-architect loader (small)
**Files**: `packages/core/src/agents/resolveStarterBundle.ts` (extend), `packages/agents/meta/agent-architect.cant` (read-only)
**AC**: `resolveMetaAgentsDir()` exported from `@cleocode/core/agents`, resolves `packages/agents/meta/` via require.resolve + relative walk, returns null on miss; test covers all 3 paths

### T1259-W2 — agent-architect invocation shim in `initProject` (medium)
**Files**: `packages/core/src/init.ts` (modify lines 841-868), `packages/core/src/agents/invoke-meta-agent.ts` (new)
**AC**: `initProject({ installSeedAgents: true })` invokes agent-architect (subprocess via `cleo orchestrate spawn` or direct CANT runtime) with required tokens populated from project-context.json; falls back to static copy when meta agent unavailable; test confirms invocation tokens

### T1259-W3 — user_profile + project-context threading (small)
**Files**: `packages/core/src/agents/invoke-meta-agent.ts` (depends W2), `packages/core/src/nexus/user-profile.ts` (read-only)
**AC**: `invokeMetaAgent()` reads `.cleo/project-context.json` + calls `listUserProfile(nexusDb)`, passes both as serialized token args; mocked unit test asserts payload shape

### T1259-W4 — `playbook-architect.cant` authoring (small)
**Files**: `packages/agents/meta/playbook-architect.cant` (new)
**AC**: file exists, `kind: agent`, `version: 2`, documents token contract; pattern matches `agent-architect.cant`

### T1259-W5 — `cleo playbook create` CLI verb (small)
**Files**: `packages/cleo/src/cli/commands/playbook.ts` (add `createCommand` + wire `subCommands`)
**AC**: `cleo playbook create <name>` dispatches `dispatchFromCli('mutate', 'playbook', 'create', { name })`; smoke-test exit-0 + LAFS envelope success

### T1259-W6 — `cleo agent mint <spec.cant>` CLI verb (medium)
**Files**: `packages/cleo/src/cli/commands/agent.ts` (add `mintCommand`), `packages/core/src/agents/invoke-meta-agent.ts` (reuse W2)
**AC**: `cleo agent mint <spec.cant>` reads spec, resolves agent-architect, invokes with spec + project-context + user_profile, writes outputs to `.cleo/cant/agents/`; integration test with fixture

### T1259-W7 — `@cleocode/agents-starter` package + Release wiring + M1 red test (medium)
**Files**: `packages/agents-starter/package.json` (new), `packages/agents-starter/` (curated content), `.github/workflows/release.yml` (add version-sync + publish_pkg), `packages/core/src/orchestration/__tests__/spawn-retrieval-parity.test.ts` (new red test)
**AC**: `npm pack --dry-run` on agents-starter shows canonical files; `publish_pkg agents-starter` added to release.yml; spawn-retrieval-parity.test.ts has one red `expect(payload.retrievalBundle).toBeDefined()` (turns green in E3); `pnpm biome ci .` passes

---

## 5. Risk Callouts

**R1 — agent-architect invocation mechanism unspecified.**
The `.cant` file describes invocation by `cleo init --install-seed-agents` but no `invokeMetaAgent()` exists. Mechanism undefined: subprocess (`cleo orchestrate spawn agent-architect`), direct CANT runtime call, or adapter delegation? Single biggest design decision E2 must resolve. **Recommended**: subprocess via `cleo orchestrate spawn agent-architect --no-worktree`. If CANT runtime can't execute synchronously, static fallback MUST work reliably.

**R2 — `cleoos-opus-orchestrator` residual reference.**
`packages/cleo/src/cli/commands/agent.ts:129` — `cleo agent register` scaffolds `.cant` files with `parent: cleoos-opus-orchestrator`. Should have been cleaned in T1257/T1258. E2 worker touching `agent.ts` for `mint` MUST fix this line to canonical E1 orchestrator name, or T1257 dogfood ID is reintroduced.

**R3 — `@cleocode/agents-starter` as separate npm package adds release complexity.**
Every release becomes 17 packages. Version-sync loop (release.yml line 117) and publish loop both need updates. Missing either repeats the v2026.4.118-.122 incident. Alternative: subset export from `@cleocode/agents` (no new package).

**R4 — M1 gate means E2 cannot close until E3 ships.**
spawn-retrieval-parity test deliberately RED at E2 close. `cleo verify` evidence gate for T1259 must explicitly note open gate, document expected red until T1260 lands. **Do NOT pass M1 gate green at E2 time** — Council violation.

**R5 — No test coverage for `initProject({ installSeedAgents: true })`.**
Entire seed-install block (init.ts:841-868) untested. Refactor to invoke agent-architect needs new test fixture. Init E2E tests don't cover `--install-seed-agents`.

**R6 — `agent-architect.cant` parent says `cleo-prime` (pre-E1 name).**
After E1 renames canonical orchestrator, `packages/agents/meta/agent-architect.cant:21` needs update from `parent: cleo-prime` to E1 canonical name. E2 worker confirms E1 landed before using new name.

**R7 — `build.mjs` SUBPATH_DIRS scanner doesn't include `packages/agents/src/`.**
`@cleocode/agents` is data-only (raw `.cant`). If TypeScript inadvertently added, scanner won't pick up. If `agents-starter` needs TypeScript index for type exports, separate `tsconfig.json` + esbuild entry needed.

---

## 6. Files Essential for the .127 Orchestrator

| File | Why Essential |
|------|---------------|
| `packages/core/src/init.ts` | Primary site for AC1, AC6 — seed-install block, `resolveSeedAgentsDir()`, `deployStarterBundle()` |
| `packages/agents/meta/agent-architect.cant` | The meta-agent — token contract, constraints |
| `packages/cleo/src/cli/commands/init.ts` | CLI entry — `--install-seed-agents` flag |
| `packages/cleo/src/cli/commands/agent.ts` | Add `mint` (AC8); fix `cleoos-opus-orchestrator` residual |
| `packages/cleo/src/cli/commands/playbook.ts` | Add `create` (AC5) |
| `packages/core/src/agents/resolveStarterBundle.ts` | Pattern for new `resolveMetaAgentsDir()` |
| `packages/core/src/orchestration/spawn.ts` | M1 context — `SpawnPayload`, `composeSpawnPayload` |
| `packages/core/src/memory/brain-retrieval.ts` | `buildRetrievalBundle` signature for M1 red test |
| `packages/core/src/sessions/briefing.ts` | Briefing path (vs spawn path gap) |
| `packages/agents/package.json` | Verify `meta/` in `files[]` |
| `.github/workflows/release.yml` | Add agents-starter to version-sync + publish loop if separate package chosen |
| `packages/core/src/orchestration/__tests__/spawn.test.ts` | Reference harness for M1 test |
