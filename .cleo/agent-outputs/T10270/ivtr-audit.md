# IVTR Current-State Audit (T10270 / Saga T10268)

**Mode**: Investigation only — no code edits. Maps current primitives so the
follow-up Synthesis (T10271-T10273) can land grounded improvement plans.

**Build context**: Post-T9831 SG-ARCH-SOLID (done), post-T9787 SG-DOCS-CANON-
CLOSURE (done), post-T9540 release-rewrite, post-T9964 orient-v2, post-T9782
changeset pipeline, post-T10176 boundary-registry. All file:line references
are absolute paths under `/mnt/projects/cleocode/`.

---

## 1. Executive Summary — Top 5 Gaps

1. **Evidence atoms verify EXISTENCE but not AC SATISFACTION** —
   `validateCommit` (`packages/core/src/tasks/evidence.ts:551`) only proves
   reachability + content-intersect with `task.files`. No atom binds a
   commit to a *specific* AC item. ACs are unindexed strings — there is no
   AC↔evidence mapping. `task.acceptance` is a mixed `(string |
   AcceptanceGate)[]` array with no stable IDs (only `req?: string` on the
   gate variant, which is opt-in).

2. **`lead-rollup.ts` is purely passive** —
   `packages/core/src/orchestration/lead-rollup.ts:67-200` reads from
   `pipeline_manifest` + `task.verification` and computes
   `readyToAdvance`. It NEVER triggers the next wave, never spawns a
   Validator, never publishes to a conduit topic. The caller must drain
   topics and pass `conduitMessages` — Lead is a thin reporter, not an
   autonomous coordinator.

3. **No Validator subagent role exists** — `DelegateTaskChild.role` is
   `'leaf' | 'worker'` (`packages/contracts/src/spawn.ts:69`).
   `DelegateTaskParent.role` is `'orchestrator' | 'lead'`. There is no
   independent Validator agent type — the same Worker that implemented
   the task also writes the `implemented` evidence atom.
   The T9216 `audit` phase added to `IvtrPhase`
   (`packages/core/src/lifecycle/ivtr-loop.ts:45`) provides a *time slot*
   for validation but no distinct *agent identity*.

4. **`cleo docs` is a SSoT for storage, NOT a validator** — `canon.yml`
   + `BUILTIN_DOC_KINDS` register WHERE docs live and which mirror dirs
   are CI-blocked. `cleo check canon docs` only blocks raw-fs writes; it
   does NOT consume the doc's content (e.g. spec body) to validate
   acceptance-gate satisfaction. There is NO programmatic hook of the
   form "spec-doc-X must pass before gate-Y closes".

5. **`CLEO_OWNER_OVERRIDE` still bypasses 4 of 6 gates without evidence**
   — `validateGateVerify`
   (`packages/core/src/validation/engine-ops.ts:463-485`) blocks override-
   only writes for `implemented` and `testsPassed`, but `qaPassed`,
   `documented`, `securityPassed`, `cleanupDone` still accept
   `{ kind: 'override', reason: … }` as the sole atom. T1501 added a
   per-session cap, T1502 added shared-evidence flag, but the structural
   bypass remains.

---

## 2. Per-Dimension Map

### 2.1 ADR-051 Atom Grammar + Verify Flow

**Atom kinds** (parsed in
`packages/core/src/tasks/evidence.ts:186-219`):
```
commit | files | test-run | tool | url | note | loc-drop |
callsite-coverage | decision | pr
```
Plus the `state:MERGED` modifier (`evidence.ts:394-428`) and an internal
`override` atom emitted only when `CLEO_OWNER_OVERRIDE=1` is set
(`engine-ops.ts:485`).

**`GATE_EVIDENCE_MINIMUMS`** (`evidence.ts:114-154`) — minimum atom sets
per gate:
| Gate | Required atom sets (any one) |
|------|------------------------------|
| `implemented` | `[commit,files]`, `[commit,note]`, `[decision,files]`, `[decision,note]`, `[pr]` |
| `testsPassed` | `[test-run]`, `[tool]`, `[pr]` |
| `qaPassed` | `[tool]`, `[pr]` |
| `documented` | `[files]`, `[url]` |
| `securityPassed` | `[tool]`, `[note]` |
| `cleanupDone` | `[note]` |
| `nexusImpact` | `[tool]`, `[note]` |

Extended gates (`packages/core/src/verification/gates.ts:42-68`) add
`metricsImproved` (T1023; required only for Tier-3 sentient experiments
via `isTier3Task`).

**Atom validators** (`evidence.ts:468-499` dispatch):
- `validateCommit` (`:551-622`): SHA reachable from `getEffectiveHead`,
  reachable from `task/<taskId>` branch when it exists (T9178), and
  diff intersects `task.files` ∪ AC-string path-tokens (T9245
  `checkCommitContentIntersect` `:810-876`).
- `validateFiles` (`:878-909`): exists + sha256 hash captured.
- `validateTestRun` (`:920-995`): JSON parsed, `numTotalTests>0`,
  `numFailedTests===0`, no non-passing suite.
- `validateTool` (`:997-1037`): resolves via
  `resolveToolCommand` (`tool-resolver.ts`), runs via `runToolCached`
  (`tool-cache.ts`), asserts exit code 0.
- `validateDecision` (`:1312-1384`): `brain_decisions` row exists and
  `confirmation_state ∈ {accepted, proposed}` (T1875).
- `validatePrAtom` (`:1396+`, delegates to
  `packages/core/src/release/pr-evidence.ts`): `gh pr view` →
  state=MERGED + required checks green.
- `validateCallsiteCoverage` (`:1198-1295`): runs `rg --fixed-strings`
  excluding source/test/dist, requires ≥1 hit (T1605).

**Gate.set entrypoint**:
`packages/cleo/src/cli/commands/verify.ts:54-128` (CLI) → dispatch
`check/gate.set` → `packages/cleo/src/dispatch/domains/check.ts:648-685`
→ `validateGateVerify` (`packages/core/src/validation/engine-ops.ts:307-
649`).

**Override path**:
- Env vars: `CLEO_OWNER_OVERRIDE=1|true` + `CLEO_OWNER_OVERRIDE_REASON`
  (`engine-ops.ts:374`).
- Restricted roles cannot override:
  `packages/core/src/lifecycle/engine-ops.ts` `forbiddenRoles =
  ['worker','lead','subagent']` (also see `validateSpawnRequest`
  `ivtr-loop.ts:940-979`).
- Per-session cap (T1501): `checkAndIncrementOverrideCap`
  (`engine-ops.ts:406`); ordinal logged.
- Shared-evidence detection (T1502): `enforceSharedEvidence`
  (`engine-ops.ts:421`); flag required when same atom is applied to
  >3 tasks.
- Critical gates (`implemented`, `testsPassed`) reject override-only
  evidence at verify time (`engine-ops.ts:473-483`) — must supply real
  atom alongside override.

**Audit logs**:
- `appendGateAuditLine` → `.cleo/audit/gates.jsonl`
  (`packages/core/src/tasks/gate-audit.ts:155-163`).
- `appendForceBypassLine` → `.cleo/audit/force-bypass.jsonl`
  (`gate-audit.ts:174-182`).
- Optional Ed25519 signature via `appendSignedGateAuditLine` (T947 /
  ADR-054 draft, `gate-audit.ts:247-262`).
- Lifecycle scope bypass: `appendLifecycleScopeBypassLine`
  (`lifecycle/engine-ops.ts` near `CLEO_OWNER_OVERRIDE` block).

**Complete handshake**:
`packages/core/src/tasks/complete.ts:1089` — when status is being
flipped to `done`, advancement may require IVTR `released` phase; the
error message points at `cleo orchestrate ivtr ${taskId} --next` or
`CLEO_OWNER_OVERRIDE=1`. CLEO re-validates every "hard" atom on
complete (commit reachable, file sha256 match, test-run hash match) —
this is documented but the re-validation entry point isn't isolated in
a single function; it relies on the same `validateAtom` chain.

**Gaps**:
- No `ac:<id>` atom — atoms don't reference WHICH acceptance criterion
  they satisfy.
- No `spec:<docId>` atom — cannot bind evidence to a doc-driven
  specification.
- Override emits a synthetic `{ kind: 'override' }` atom
  (`engine-ops.ts:485`) that bypasses normal grammar validation for
  non-critical gates.

### 2.2 AC (Acceptance Criteria) Handling

**Storage**:
- DB column: `tasks.acceptance_json` (`packages/core/src/store/schema/
  tasks.ts:135`) — JSON text default `'[]'`.
- TS type: `AcceptanceItem = string | AcceptanceGate`
  (`packages/contracts/src/task.ts:39`).
- `AcceptanceGate` union (`packages/contracts/src/acceptance-gate.ts:247`):
  `TestGate | FileGate | CommandGate | LintGate | HttpGate | ManualGate`.
  Optional `req?: string` REQ-ID field on `GateBase`
  (`acceptance-gate.ts:31`).

**REQ-ID handling**:
- `reqAdd` / `reqList` / `reqMigrate` in
  `packages/core/src/tasks/req.ts:174-280` — adds a structured gate to
  the acceptance array, enforces REQ-ID uniqueness *within one task*
  (`req.ts:186-200`).
- Cross-task uniqueness: only enforced inside the same acceptance array
  (`packages/contracts/src/acceptance-gate-schema.ts:328-342`).
- `reqMigrate` heuristically classifies free-text → typed gate using
  regex patterns `RE_TEST` / `RE_FILE_EXISTS` / `RE_LINT`
  (`req.ts:20-23`).

**AC ↔ test/commit mapping that exists today**:
- `extractTaskAcFiles` (`evidence.ts:652-676`): pulls file paths from
  `task.files` first, then regex-extracts `AC_PATH_TOKEN`
  (`:635-636`) from free-text AC strings. Used ONLY for the T9245
  content-intersect check on the commit atom.
- `gate-runner.ts:81-114` `runGates` executes any `AcceptanceGate`
  objects extracted via `extractTypedGates` (`:764-773`) — but this is
  a SEPARATE machine from the `cleo verify --gate … --evidence` flow.
  Outputs `AcceptanceGateResult[]` keyed by `index` + optional `req`
  (`acceptance-gate.ts:332-338`), recorded in
  `lifecycle_gate_results`.

**Gaps**:
- Free-text ACs (the majority) have NO ID. They are inert until
  someone runs `cleo req migrate`.
- `req:` field is local to one task's array; agents reuse names like
  `TIMER-03` across tasks without conflict.
- `runGates` (AcceptanceGate execution) and `validateGateVerify`
  (evidence-atom verification) are two parallel verification paths
  that do not cross-reference.

### 2.3 Lead-Rollup + Validator Surface

**`lead-rollup.ts` behavior** (`packages/core/src/orchestration/lead-
rollup.ts`):
- `rollupWaveStatus` (`:67-200`): reads `task.verification.gates`,
  reads latest `pipeline_manifest` row per child via
  `loadLatestManifestPerTask` (`:251-277`), optionally enriches from
  `options.conduitMessages` (passed in by caller).
- `rollupEpicStatus` (`:206-233`): composes per-wave rollups.
- **Active or passive?** PASSIVE. No mutation. No spawn. No conduit
  publish. The function is *read-only*. Caller must drain topics and
  re-invoke (`:13-14` comment is explicit: "The function does NOT
  subscribe to topics directly").
- `readyToAdvance` (`:190`) is computed; no side-effect on returning
  `true`.

**Validator subagent type**:
- `DelegateTaskChild.role` (`packages/contracts/src/spawn.ts:69`):
  `'leaf' | 'worker'` ONLY.
- `DelegateTaskParent.role` (`spawn.ts:87`): `'orchestrator' |
  'lead'`.
- `CLEO_AGENT_ROLE` env var (`ivtr-loop.ts:945`,
  `lifecycle/engine-ops.ts`): values seen are `'worker'`, `'lead'`,
  `'subagent'` (in `forbiddenRoles` set).
- Grep `subagent_type` returns 2 hits: `spawn.ts:71` (just a free-form
  string passed to adapter) and `operations/skills.ts:40`
  (`compatible_subagent_types: string[]` on skills). No fixed
  enumeration of validator types.
- The T9216 `audit` phase
  (`packages/core/src/lifecycle/ivtr-loop.ts:45,104,418`) IS the only
  validator-shaped artifact — but it's a phase label, not a distinct
  agent role; the same `IvtrPhaseEntry.agentIdentity` field
  (`ivtr-loop.ts:54`) carries whoever ran that phase.

**`pipeline_manifest` table**
(`packages/core/src/store/schema/manifest.ts:44-69`):
- Columns: `id, session_id, task_id, epic_id, type, content,
  content_hash, status, distilled, brain_obs_id, source_file,
  metadata_json, created_at, archived_at`.
- Writer: `pipelineManifestAppend`
  (`packages/core/src/memory/pipeline-manifest-sqlite.ts:549-606`).
- Reader: `pipelineManifestList` (`:261+`), consumed by `lead-rollup`.
- `agent_type` is on the OTHER manifest table (`manifest_entries`
  `manifest.ts:16-40`) and is required in
  `pipelineManifestAppend` validation (`:563`). Worker writes its own
  manifest entry — no peer-review path exists.

**Gaps**:
- Lead never triggers next wave on `readyToAdvance=true` — orchestrator
  must poll and react.
- No validator agent identity — Worker self-attests `implemented` (T9231
  / FISE-2 blocks Lead self-attest by requiring an upstream
  `delegate_task` event, but doesn't introduce a third reviewer).
- `pipeline_manifest.content_hash` exists but is not cross-referenced
  against gate evidence atoms.

### 2.4 Conduit Topics

**Topic schema**
(`packages/core/src/store/conduit-schema.ts:343-415`):
- `topics(id, name, epic_id, wave_id, created_by, created_at)`.
- `topic_subscriptions(topic_id, agent_id, subscribed_at)`.
- `topic_messages(id, topic_id, from_agent_id, kind, content, payload,
  created_at)`.
- `topic_message_acks(message_id, subscriber_agent_id, delivered_at,
  read_at)`.

**Topic naming convention**
(`packages/core/src/conduit/local-transport.ts:45-58`):
- `epic-T<id>.wave-<n>` → `{epicId, waveId}` parsed.
- `epic-T<id>.coordination` → epic-scoped, wave-less.
- `T<id>.wave-<n>` short form supported.

**Surface API** (`packages/core/src/conduit/conduit-client.ts`):
- `subscribeTopic(name, options)` `:139-146`.
- `publishToTopic(name, content, options)` `:158-169`.
- `onTopic(name, handler)` `:184-190` — real-time handler.
- `unsubscribeTopic(name)` `:200-207`.
- Only `LocalTransport` supports topic ops in this release
  (`conduit-client.ts:131-133` comment).

**Existing canonical topic kinds**: parsing only recognises
`wave-<n>` and `coordination` suffixes. There is no enum like
`worker.complete | lead.rollup | blocker | artifact` (mentioned in
the T10270 brief as T9154-consensus targets) — those topic names
would parse but they're not registered or validated.

**Cursor behavior**: `topic_message_acks` tracks delivery + read per
subscriber. The reading agent ACKs by writing rows. No "topic cursor
position" beyond ack rows. No replay-from-cursor primitive in the
client API; messages are delivered in insertion order via
`topic_handlers` notification (`local-transport.ts:411-433`).

**Gaps**:
- No structured event-kind taxonomy — `topic_messages.kind` defaults to
  `'message'` (`conduit-schema.ts:391`).
- No automatic Lead subscription to `epic-<TID>.wave-<n>` — caller
  must subscribe explicitly.
- `topic_messages.payload` is opaque JSON text — schema-less.

### 2.5 cleo docs canon — Current State (post T9787)

**`.cleo/canon.yml`** (`/mnt/projects/cleocode/.cleo/canon.yml`):
- 9 DocKinds: `adr, spec, research, handoff, note, llm-readme,
  changeset, release-note, plan, rcasd`.
- Each entry has `canonicalHome` (`ssot | ssot-first`), `publishMirror`
  (mirror dir), `rawMdAllowed` (CI-gate flag), optional `rawMdPaths`
  (legacy dirs to scan).
- Schema enforced by `.cleo/canon.schema.json`.

**`BUILTIN_DOC_KINDS`**
(`packages/contracts/src/docs-taxonomy.ts:119-204`): same 9 kinds as
canon.yml but with additional fields: `defaultOwnerKind`, `publishDir`,
`requiresEntityId`, `entityIdPattern`. Extensions via
`DocKindRegistry.from*` factories (`:355-403`).

**CI gate**: `cleo check canon docs` (alluded to in
`docs-canon.ts:5-30` of canon-lint sibling file). Implementation:
`packages/cleo/src/dispatch/domains/check.ts:550` mentions
`cleo docs add ...` as the suggested fix when violations are detected.

**Agent-accountability harness** (`packages/core/src/session/canon-
lint.ts:1-100`): Scans Claude Code session transcripts (`*.jsonl`) for
Write/Edit/MultiEdit calls into `rawMdPaths` where `rawMdAllowed:
false`. Emits `CanonLintViolation` records but does not block any
runtime operation — it's a post-hoc audit.

**llmtxt SDK integration**: The `llmtxt-core` package referenced in
AGENTS.md is NOT a workspace package; `llmtxt` is an external npm
dep (`packages/core/package.json:411`). Used by sentient subsystem
(`packages/core/src/sentient/*.ts`) — NOT by `cleo docs`. The `docs/`
subsystem uses its own attachment store (`store/attachment-store.ts`)
and ships its own `searchDocs` / `mergeDocs` (`docs/docs-ops.ts:201,
475`).

**Is there ANY programmatic validator hook on `cleo docs`?**
- `cleo check canon docs` blocks RAW-MD writes at the FS layer.
- `canon-lint.ts` flags violations in TRANSCRIPTS.
- `validation/docs-sync.ts` exists (`packages/core/src/validation/`).
- **NO** programmatic gate of the form "evidence atom requires a
  published spec doc of kind X to exist". Spec docs are SSoT but they
  cannot CLOSE a gate.

**Gaps**:
- No `doc:<id>` or `spec:<docId>` evidence atom.
- No DocKind → required-by-gate binding (e.g. "documented gate
  REQUIRES a `spec` doc with slug matching task ID").
- `publishMirror` is human-reviewable mirror only — no programmatic
  consumer treats the published mirror as authoritative.

### 2.6 packages/core/src/tools/ — Post T9831 SDK Tools

**Top-level `tools/` barrel** (`packages/core/src/tools/index.ts`):
- BrainTools (Category B): exports `searchBrain, observeBrain,
  fetchBrainEntries, timelineBrain, buildRetrievalBundle`
  (`brain-tools/index.ts:18-22`).
- ProjectTools (Category B): `doctorProject`
  (`tools/doctor-project.ts`), `scaffoldGlobal`
  (`tools/scaffold-global.ts`), `scaffoldProject`
  (`tools/scaffold-project.ts`).
- TaskTools (Category B):
  `buildTaskTree, computeCriticalPath, describeSchema, scoreTask,
  renderTaskTreeText, renderTaskTreeMermaid, defineSdkTool`
  (`tools/task-tools/index.ts:19-25`).
- SDK Tools (Category B):
  `provisionIsolatedShell, validateAbsolutePath, runToolCached,
  acquireGlobalSlot, pipelineManifestAppend, buildAgentEnv,
  buildWorktreeSpawnResult, CANONICAL_TOOLS, resolveToolCommand`
  (`tools/sdk/index.ts:26-61`).
- Domain Utilities (Category C — CAAMP/adapter management): 22
  exports including `toolsAdapter*`, `toolsProvider*`, `toolsSkill*`,
  `toolsIssueDiagnostics` (`tools/engine-ops.ts` via `index.ts:22-53`).

**Tool taxonomy** (declared in `tools/sdk/index.ts:15-19`):
- Category A — Agent Tool (LLM-callable, owned by T1737/T1739, located
  at `packages/core/src/tools/agents/`). **ASSUMED — verify before
  use**: directory does not appear to exist in this branch (no
  `agents/` subdir found under `tools/`).
- Category B — SDK Tool (this barrel, harness-agnostic).
- Category C — Domain Utility (CAAMP/adapter ops via `engine-ops.ts`).

**Discovery mechanism**:
- `defineSdkTool` (`task-tools/sdk-tool.ts:69-78`) wraps `{identity,
  inputSchema, outputSchema, fn}` into a frozen `RegisteredSdkTool`.
- `SdkToolIdentity` shape lives in `@cleocode/contracts`.
- No central registry yet — each barrel exports raw functions
  alongside `defineSdkTool`-wrapped versions. JSON-schema-based
  discovery requires importing the named export.

**CLI/Studio adapter surface**:
- CLI: `packages/cleo/src/dispatch/domains/*` routes `cleo <verb>`
  commands through the dispatch layer to core. No direct re-
  implementation found — CLI is thin adapter to core.
- Studio: `packages/studio/` exists but uses SvelteKit + @cleocode/sdk
  imports (not audited in depth; ASSUMED to consume the same exports
  — verify before use).
- MCP adapter: `@cleocode/mcp-adapter` (per memory) — external bridge,
  consumes core exports.

**Gaps**:
- No central `ToolRegistry.list()` API — tools are discoverable only
  by importing the barrel file.
- `Category A` agents/ directory missing → no LLM-callable tool layer
  yet (the T9831 work landed B and C; A is still future).
- `defineSdkTool` schemas (`JsonSchema` interface, `sdk-tool.ts:16-23`)
  are draft-07-ish subset — no validation runtime, just type hints.

### 2.7 Spawn-Adapter Surface

**Current interface** (`packages/contracts/src/spawn-types.ts:90-123`):
```typescript
interface CLEOSpawnAdapter {
  readonly id: string;
  readonly providerId: string;
  canSpawn(): Promise<boolean>;
  spawn(context: CLEOSpawnContext): Promise<CLEOSpawnResult>;
  listRunning(): Promise<CLEOSpawnResult[]>;
  terminate(instanceId: string): Promise<void>;
}
```

**Registry** (`packages/core/src/spawn/adapter-registry.ts:45-142`):
- `SpawnAdapterRegistry` class — `register/get/getForProvider/list/
  listSpawnCapable/canProviderSpawn/clear`.
- `listSpawnCapable` (`:110-117`) queries CAAMP for spawn-capable
  providers via `getSpawnCapableProviders()` + filters by
  `spawn.supportsSubagents` capability.
- `initializeDefaultAdapters()` registers all default adapters
  (referenced `:111` but body not shown — ASSUMED to wire
  packages/adapters providers — verify before use).

**Provider adapters** (`packages/adapters/src/providers/`):
- `claude-code, claude-sdk, codex, cursor, gemini-cli, kimi,
  openai-sdk, opencode, pi, shared`.

**`ExtendedSpawnAdapter`** (T9154 consensus mention): **DOES NOT
EXIST** in current code. Grep returns no hits across
`packages/contracts/` or `packages/core/`. Only `CLEOSpawnAdapter`
exists. The 6-method surface above does not include hooks for
"validator agent spawn", "structured event publication on completion",
or "AC-bound subagent_type".

**Detached-spawn lifecycle**
(T9154 §2.7, T9545 / Saga T10176):
- `orchestrateSpawn` runs under an `AbortController` budget
  (`SPAWN_BUDGET_MS = 60_000` —
  `packages/core/src/orchestrate/spawn-ops.ts:34-36`).
- On timeout, `destroyWorktree` is invoked with
  `CLEANUP_BUDGET_MS` (T9545 / Saga T10176 / D010 reversed earlier
  "preserve on timeout" semantics — see file docstring `:24-46`).
- Progress logs emit at `validate-readiness, provision-worktree,
  compose-prompt, persist-state`.
- Worktree path under
  `~/.local/share/cleo/worktrees/<projectHash>/<taskId>/` per ADR-055.
- **Status of detached supervisor bug from T9154 §2.7**: **PARTIALLY
  CLOSED**. The hang vector (no subprocess timeout in
  `packages/worktree/src/git.ts:23/40/57`) is fixed. Long-running
  detached spawns that exceed `SPAWN_BUDGET_MS=60s` are now killed +
  cleaned. **Open**: agents that spawn successfully but then hang
  *inside* the worker (e.g. waiting on LLM forever) are NOT covered
  by this supervisor — that's a worker-side concern handled by the
  sentient daemon's runaway detection (T1658 `abortReason`).

**Gaps**:
- `CLEOSpawnAdapter.spawn()` returns `CLEOSpawnResult` once — there's
  no streaming event channel for "validator-spawned",
  "evidence-published", "phase-complete".
- No `subagent_type: 'validator'` discriminator wired into the spawn
  context to route a Validator to a different adapter / prompt.
- `listRunning()` is per-adapter — no cross-adapter view of "all
  validators currently running for epic E".

---

## 3. GAP TABLE

| # | Gap | Improvement Target | Current file:line | Proposed fix scope |
|---|-----|-------------------|---|---|
| G1 | ACs have no stable IDs; free-text strings dominate | AC stable IDs | `packages/contracts/src/task.ts:39` (`AcceptanceItem = string | AcceptanceGate`); `packages/core/src/store/schema/tasks.ts:135` (`acceptance_json`) | module-level (contracts + store + migration) |
| G2 | No atom binds evidence to a specific AC | AC stable IDs + atom grammar | `packages/core/src/tasks/evidence.ts:186-219` (`ParsedAtom` union) | atom-level (add `ac:<id>` atom kind) |
| G3 | `req:` field is opt-in and only enforced within one task array | AC stable IDs | `packages/contracts/src/acceptance-gate.ts:31`; `packages/contracts/src/acceptance-gate-schema.ts:328-342` | function-level (cross-task uniqueness check) |
| G4 | No Validator subagent role; Worker self-attests `implemented` | Independent Validator | `packages/contracts/src/spawn.ts:69` (`role: 'leaf'|'worker'`); `packages/core/src/lifecycle/ivtr-loop.ts:45` (`IvtrPhase` includes `audit` but no agent identity binding) | module-level (contracts + spawn + lifecycle) |
| G5 | `lead-rollup.ts` is passive — never triggers next wave or spawns validator | Independent Validator | `packages/core/src/orchestration/lead-rollup.ts:67-200` (read-only) | function-level (add active rollup with publish/spawn side-effects) |
| G6 | T9216 `audit` phase has no distinct agent identity, prompt template, or skill | Independent Validator | `packages/core/src/lifecycle/ivtr-loop.ts:45,103-104,414-420` | saga-level (new validator skill + adapter wiring) |
| G7 | `cleo docs` SSoT does not gate evidence — no `spec:<docId>` atom | Docs-as-validator | `packages/core/src/tasks/evidence.ts:114-154` (`GATE_EVIDENCE_MINIMUMS`); `.cleo/canon.yml`; `packages/contracts/src/docs-taxonomy.ts:119` | module-level (new atom + DocKind → gate binding registry) |
| G8 | `canon-lint.ts` is post-hoc audit, not pre-commit enforcement | Docs-as-validator | `packages/core/src/session/canon-lint.ts:1-100` | function-level (extend CI gate to consume content, not just file path) |
| G9 | `CLEO_OWNER_OVERRIDE` still bypasses 4 of 6 gates structurally | ADR-051 hardening | `packages/core/src/validation/engine-ops.ts:463-485` (critical-gate-only block) | function-level (extend critical-gate set or remove `{kind: override}` synthetic atom path) |
| G10 | Tool registry has no central `list()` for LLM-callable discovery | CORE tools | `packages/core/src/tools/index.ts:1-66` (barrel exports only); no `agents/` subdir | module-level (add ToolRegistry + Category A agents/) |
| G11 | `CLEOSpawnAdapter` has no streaming event channel for validator handoff | Independent Validator + CORE tools | `packages/contracts/src/spawn-types.ts:90-123` | module-level (extend interface — distinct from T9154's ExtendedSpawnAdapter which never landed) |
| G12 | No `subagent_type: 'validator'` discriminator in spawn dispatch | Independent Validator | `packages/contracts/src/spawn.ts:71` (`subagent_type?: string`); `packages/core/src/orchestrate/spawn-ops.ts` | function-level (add type guard + adapter routing) |
| G13 | Conduit topic `kind` is free-form string; no `worker.complete | lead.rollup | blocker | artifact` taxonomy | Conduit hardening (cross-cutting) | `packages/core/src/store/conduit-schema.ts:391` (`kind: text default 'message'`) | atom-level (enum constraint) + module-level (event-kind contracts) |
| G14 | Lead must drain conduit explicitly — no automatic subscription on spawn | Independent Validator | `packages/core/src/orchestration/lead-rollup.ts:13-14, 173-188` | function-level (auto-subscribe in spawn pipeline) |
| G15 | `pipeline_manifest.content_hash` exists but is never cross-referenced against gate evidence | Independent Validator | `packages/core/src/store/schema/manifest.ts:53`; `packages/core/src/orchestration/lead-rollup.ts:125-141` | function-level (rollup cross-check) |
| G16 | `runGates` (AcceptanceGate machine) and `validateGateVerify` (evidence-atom machine) don't cross-reference | AC stable IDs | `packages/core/src/tasks/gate-runner.ts:81-114` vs `packages/core/src/validation/engine-ops.ts:307-649` | saga-level (unify or formally bridge the two execution paths) |
| G17 | `defineSdkTool` produces schemas but has no runtime input validator | CORE tools | `packages/core/src/tools/task-tools/sdk-tool.ts:69-78` | function-level (add Zod or ajv on `invoke()`) |
| G18 | Lifecycle override bypass (`lifecycle/engine-ops.ts`) is separate from gate override bypass — two override paths | ADR-051 hardening | `packages/core/src/lifecycle/engine-ops.ts` (search `CLEO_OWNER_OVERRIDE`); `packages/core/src/validation/engine-ops.ts:374-415` | module-level (unified override policy) |

---

## 4. Drift From Earlier Memory (T9154 Consensus Assumptions Re-Checked)

| T9154 assumption | Current reality | Drift verdict |
|---|---|---|
| `ExtendedSpawnAdapter` interface exists or is partially built | NOT built; only `CLEOSpawnAdapter` (`spawn-types.ts:90-123`) | DRIFT — proposal still needs to land |
| Detached-spawn lifecycle bug (§2.7) is open | Spawn hang vector FIXED (T9545 / Saga T10176 — `orchestrate/spawn-ops.ts:8-58`). Worker-internal hangs still open | DRIFT — partial close |
| `worker.complete`, `lead.rollup`, `blocker`, `artifact` topic kinds are canonical | Topic naming uses `epic-T<id>.wave-<n>` only; `kind` column defaults to `'message'` (`conduit-schema.ts:391`) | DRIFT — proposed taxonomy never adopted |
| `pipeline_manifest` is Lead's primary write surface | Confirmed (`schema/manifest.ts:44-69` + `pipeline-manifest-sqlite.ts:549-606`) | NO DRIFT |
| ADR-051 atom grammar covers basic evidence kinds | Confirmed + extended: `loc-drop` (T1604), `callsite-coverage` (T1605), `decision` (T1875), `pr` (T9764), `state:MERGED` (T9838) | EXTENDED, no drift |
| `cleo orchestrate ivtr` provides Validator role | Phase machine exists (`ivtr-loop.ts`); `audit` phase added (T9216) — but NO distinct agent role | DRIFT — phase added, agent identity not |
| `cleo docs add` is SSoT for canonical docs | Confirmed (T9787 closed) — `.cleo/canon.yml` + `docs-taxonomy.ts` enforce routing | NO DRIFT |
| ACs are bare strings with no stable IDs | Confirmed — `task.acceptance_json` is `(string | AcceptanceGate)[]` JSON; `req:` only on gate objects | NO DRIFT (still true) |

---

## 5. Cross-Cutting Risks for Future IVTR Shipping Sagas

1. **Schema migration**: Adding stable AC IDs requires either an in-
   place migration of `acceptance_json` (rewriting strings to typed
   objects) or a parallel `acceptance_criteria` table. Existing
   `req:` field could be reused but UPSERTs across the repo need a
   compat shim.

2. **Public API breakage**: `CLEOSpawnAdapter` is in
   `@cleocode/contracts` — any extension (e.g. `subscribeEvents` or
   `validator: Validator`) is a SemVer minor (additive) but
   third-party adapter implementers in `packages/adapters/` (9
   provider dirs) need updates.

3. **`pipeline_manifest` vs `task.verification`**: Two parallel
   write surfaces. If Validator adds a third (e.g. signed peer
   review), the lead-rollup pull logic
   (`lead-rollup.ts:125-141`) becomes a 3-source merge — risk of
   drift.

4. **Override audit-log noise**: `force-bypass.jsonl` already carries
   per-session ordinal (T1501) + shared-evidence flags (T1502). Any
   hardening of the bypass path needs to preserve the audit
   contract for forensic compatibility.

5. **Conduit topic taxonomy**: Adding canonical event kinds
   (`worker.complete`, etc.) is data-only (`topic_messages.kind` text
   column) but cursor/replay semantics aren't designed for
   reordering — Validator events that arrive out-of-order with
   Worker events would need a sequencer.

6. **Boundary registry (T10176)**: New atoms / interfaces must
   register in `packages/contracts/src/boundary.ts` BOUNDARY_REGISTRY
   to pass CI gates. ASSUMED — verify before use.

7. **CLI surface stability**: `cleo verify --evidence` syntax is
   atom-list with `;` separator. Adding `ac:<id>` is additive but
   the parser (`evidence.ts:242-441`) has 11 cases including the
   `state:MERGED` modifier — error-handling needs tested expansion.

8. **IVTR phase backfill**: `IvtrState.schemaVersion` (`ivtr-loop.ts:
   80`) is version 2. Adding a Validator-distinct phase would push
   schema version 3 — existing rows must be migrated forward-only.

---

## Appendix: Quick Reference

| Concept | Canonical file |
|---|---|
| Atom parser + validators | `packages/core/src/tasks/evidence.ts` |
| Gate.set entry | `packages/core/src/validation/engine-ops.ts:307` |
| Override audit | `packages/core/src/tasks/gate-audit.ts` |
| AC type | `packages/contracts/src/task.ts:39`; `acceptance-gate.ts` |
| AC heuristic migrator | `packages/core/src/tasks/req.ts:274` |
| AcceptanceGate runner | `packages/core/src/tasks/gate-runner.ts:81` |
| Lead rollup | `packages/core/src/orchestration/lead-rollup.ts:67` |
| IVTR phase machine | `packages/core/src/lifecycle/ivtr-loop.ts` |
| FISE-2 lead-bypass check | `packages/core/src/lifecycle/ivtr-loop.ts:940` |
| Pipeline manifest table | `packages/core/src/store/schema/manifest.ts:44` |
| Conduit topics schema | `packages/core/src/store/conduit-schema.ts:343-415` |
| Conduit client API | `packages/core/src/conduit/conduit-client.ts:128-207` |
| Canon registry | `.cleo/canon.yml` + `packages/contracts/src/docs-taxonomy.ts:119` |
| Canon-lint (post-hoc) | `packages/core/src/session/canon-lint.ts` |
| SDK tool factory | `packages/core/src/tools/task-tools/sdk-tool.ts` |
| Tool barrel | `packages/core/src/tools/index.ts`; `tools/sdk/index.ts` |
| Spawn adapter contract | `packages/contracts/src/spawn-types.ts:90` |
| Spawn adapter registry | `packages/core/src/spawn/adapter-registry.ts:45` |
| Spawn timeout supervisor | `packages/core/src/orchestrate/spawn-ops.ts:8-58` |
| Provider adapters | `packages/adapters/src/providers/{claude-code,claude-sdk,codex,cursor,gemini-cli,kimi,openai-sdk,opencode,pi,shared}/` |
