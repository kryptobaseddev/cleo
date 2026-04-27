# T1443 Sentient Dispatch OpsFromCore Plan

## Phase 1 Audit

Required grep for command registration returned no lines because `sentient` is wired as a citty command object in `packages/cleo/src/cli/commands/sentient.ts` and registered from `packages/cleo/src/cli/index.ts:290`.

### CLI Surface

| Command | File:line | Flags / args | Action body lines | Current behavior contract | Target |
|---|---:|---|---:|---|---|
| `cleo sentient` | `packages/cleo/src/cli/commands/sentient.ts:797` | `--project`, `--json` | 25 | Prints compact daemon status; JSON emits `{ success, data }`; error code `E_SENTIENT_STATUS`. | Keep CLI rendering and direct Core status call unchanged. |
| `cleo sentient start` | `sentient.ts:89` | `--project`, `--json`, `--dry-run` | 39 | If daemon running prints already-running message; `--dry-run` runs one tick and prints `Dry-run tick: ...`; otherwise spawns daemon. | Keep unchanged; no dispatch op exists for daemon start. |
| `cleo sentient stop` | `sentient.ts:146` | `--project`, `--json`, `--reason` | 13 | Calls Core stop; prints `Sentient stop: <reason>`; error code `E_SENTIENT_STOP`. | Keep unchanged; no dispatch op exists. |
| `cleo sentient status` | `sentient.ts:177` | `--project`, `--json` | 35 | Multi-line daemon status; JSON `{ success, data }`; error code `E_SENTIENT_STATUS`. | Keep unchanged; no dispatch op exists. |
| `cleo sentient resume` | `sentient.ts:224` | `--project`, `--json` | 20 | Clears kill switch; prints fixed resume sentence; error code `E_SENTIENT_RESUME`. | Keep unchanged; no dispatch op exists. |
| `cleo sentient tick` | `sentient.ts:256` | `--project`, `--json`, `--dry-run` | 18 | Runs safe tick and prints `Tick outcome: ...`; error code `E_SENTIENT_TICK`. | Keep unchanged; no dispatch op exists. |
| `cleo sentient propose` | `sentient.ts:549` | `--project`, `--json` | 21 | Reads `sentient-state.json` and prints Tier-2 counters. Parent run currently also fires after subcommands. | Keep unchanged to preserve output. |
| `cleo sentient propose list` | `sentient.ts:292` | `--project`, `--json`, `--limit` | 21 | Attempts SDK dispatch through an optional `dispatch` property and prints `JSON.stringify(data, null, 2)`. Current baseline prints `undefined` plus parent summary. | Keep unchanged in this task to avoid CLI output divergence. |
| `cleo sentient propose accept <id>` | `sentient.ts:324` | `--project`, `--json`, positional `id` | 56 | Inline DB update `proposed -> pending`; increments Tier-2 accepted stat; prints `Proposal <id> accepted -> pending` (unicode arrow in source). | Keep unchanged in CLI; dispatch op already exists and must preserve its result shape. |
| `cleo sentient propose reject <id>` | `sentient.ts:391` | `--project`, `--json`, positional `id`, `--reason` | 57 | Inline DB update `proposed -> cancelled`; current DB invariant can fail with `T877_INVARIANT_VIOLATION`; human errors print `Error: <message>`. | Keep unchanged in CLI; dispatch op already exists and must preserve its result/error shape. |
| `cleo sentient propose diff <id>` | `sentient.ts:460` | `--project`, `--json`, positional `id` | 8 | Tier-3 stub; exact message mentions `T992+T993+T995`. Parent summary also prints after subcommand. | Keep unchanged in CLI; dispatch op must preserve same message except existing Core wording. |
| `cleo sentient propose run` | `sentient.ts:479` | `--project`, `--json` | 17 | Runs propose tick and prints `Propose tick: <kind> (written=<n>, count=<n>) <detail>`. Parent summary also prints. | Keep unchanged in CLI; dispatch op already exists. |
| `cleo sentient propose enable` | `sentient.ts:504` | `--project`, `--json` | 15 | Patches state to enabled; prints `Tier-2 proposals enabled`. Parent summary also prints. | Keep unchanged in CLI; dispatch op must preserve Core result. |
| `cleo sentient propose disable` | `sentient.ts:524` | `--project`, `--json` | 15 | Patches state to disabled; prints `Tier-2 proposals disabled`. Parent summary also prints. | Keep unchanged in CLI; dispatch op must preserve Core result. |
| `cleo sentient baseline` | `sentient.ts:630` | `--project`, `--json` | 11 | Prints `Usage: cleo sentient baseline capture <sha>`. | Keep unchanged; no dispatch op exists. |
| `cleo sentient baseline capture <sha>` | `sentient.ts:591` | `--project`, `--json`, positional `sha` | 18 | Calls Core baseline capture; prints receipt/commit/pub summary; missing key errors print Core KMS message. | Keep unchanged; no dispatch op exists. |
| `cleo sentient allowlist` | `sentient.ts:767` | `--project`, `--json` | 9 | Prints `Usage: cleo sentient allowlist list|add <base64>|remove <base64>`. | Keep unchanged in CLI; dispatch ops exist for list/add/remove. |
| `cleo sentient allowlist list` | `sentient.ts:656` | `--project`, `--json` | 24 | Prints empty message or numbered base64 keys. | Keep unchanged in CLI; dispatch op result shape must match. |
| `cleo sentient allowlist add <pubkey>` | `sentient.ts:688` | `--project`, `--json`, positional `pubkey` | 22 | Calls Core allowlist add; prints first 16 chars with ellipsis. | Keep unchanged in CLI; dispatch op result shape must match. |
| `cleo sentient allowlist remove <pubkey>` | `sentient.ts:725` | `--project`, `--json`, positional `pubkey` | 22 | Calls Core allowlist remove; preserves `E_ALLOWLIST_KEY_NOT_FOUND`. | Keep unchanged in CLI; dispatch op error code must match. |

### Dispatch Handlers

- File: `packages/cleo/src/dispatch/domains/sentient.ts`
- Current LOC: 333
- Current typed ops: `propose.list`, `propose.diff`, `allowlist.list`, `propose.accept`, `propose.reject`, `propose.run`, `propose.enable`, `propose.disable`, `allowlist.add`, `allowlist.remove`
- Current issue: dispatch imports per-op `*Params` and `SentientOps` from `@cleocode/contracts`; T1443 requires `OpsFromCore<typeof coreOps>` inference instead.

### Core Functions

All dispatch-backed Core functions already exist in `packages/core/src/sentient/ops.ts` with ADR-057 D1 shape:

- `sentientProposeList(projectRoot, params)`
- `sentientProposeDiff(projectRoot, params)`
- `sentientAllowlistList(projectRoot, params)`
- `sentientProposeAccept(projectRoot, params)`
- `sentientProposeReject(projectRoot, params)`
- `sentientProposeRun(projectRoot, params)`
- `sentientProposeEnable(projectRoot, params)`
- `sentientProposeDisable(projectRoot, params)`
- `sentientAllowlistAdd(projectRoot, params)`
- `sentientAllowlistRemove(projectRoot, params)`

### Behavior Contracts To Preserve

- CLI flags: every command keeps `--project` and `--json`; command-specific flags/positionals stay unchanged (`--dry-run`, `--reason`, `--limit`, `id`, `sha`, `pubkey`).
- CLI output: human text and current citty parent-subcommand double output are preserved by not changing `packages/cleo/src/cli/commands/sentient.ts` in this task.
- Error exits: `emitFailure()` paths exit 1 for sentient CLI errors; dispatch wrapper keeps existing dispatch error mapping (`E_INVALID_OPERATION` for unsupported ops, Core error codes for known Core failures).
- Edge cases: empty allowlist message, missing KMS key baseline capture error, missing Tier-2 proposal behavior, and disabled propose tick behavior are baseline-smoked under `/tmp/T1443-sentient-baseline`.

### Dispatch-Bypass Paths

All sentient CLI commands currently bypass the generic CLI dispatch adapter except `propose.list`, which attempts an SDK dispatch through an optional untyped property and currently prints `undefined` in the baseline. Because T1443 acceptance is dispatch inference and the user requires full CLI behavior preservation, CLI bypass cleanup is recorded as follow-up scope rather than changed here.

## Phase 2 Migration Plan

### Per-Command Migration Table

| Command group | Current behavior summary | Target Core fn | Stays in CLI | Moves to Core |
|---|---|---|---|---|
| Root/status/start/stop/resume/tick | Daemon lifecycle and tick commands call daemon/tick Core modules directly and render custom human text. | Existing daemon/tick Core APIs, not part of sentient dispatch ops. | All parsing/rendering and direct Core calls. | None in T1443. |
| `propose.*` | Tier-2 CLI commands render custom text; dispatch supports list/diff/accept/reject/run/enable/disable. | Existing `sentientPropose*` Core ops. | CLI remains unchanged for baseline preservation. | Dispatch handler delegates to inferred `coreOps`. |
| `allowlist.*` | Owner pubkey CLI commands render custom text. | Existing `sentientAllowlist*` Core ops. | CLI remains unchanged for baseline preservation. | Dispatch handler delegates to inferred `coreOps`. |
| `baseline.*` | Baseline commands call Core baseline capture directly. | Existing baseline Core API, no dispatch op. | All parsing/rendering. | None in T1443. |

### New Contract Types Needed

None. Existing sentient param/result contract types remain required by `packages/core/src/sentient/ops.ts`. No `*Params` / `*Result` aliases are unreferenced after dispatch stops importing them.

`SentientOps` will become unreferenced by source after dispatch inference. It is not a `*Params` / `*Result` alias and remains exported for public compatibility unless the contract linter requires removal.

### New Core Functions To Author

None. `packages/core/src/sentient/ops.ts` already contains all 10 normalized dispatch-backed functions.

### Implementation Steps

1. In `packages/cleo/src/dispatch/domains/sentient.ts`, replace per-op contract type imports with `OpsFromCore` from `../adapters/typed.js`.
2. Add a `coreOps` record whose values are one-arg dispatch-facing wrappers over the existing `(projectRoot, params)` Core functions.
3. Define `type SentientOps = OpsFromCore<typeof coreOps>`.
4. Update typed handler function params to infer from `SentientOps`; keep existing per-op error handling and `lafsSuccess` operation names.
5. Keep `getSupportedOperations()`, unsupported-op handling, and envelope adaptation behavior unchanged.
6. Update the sentient dispatch unit test documentation away from the old contract-owned `SentientOps` wording.

### Regression Test Plan

- Before/after smoke comparison: rerun the 21 command baseline under `/tmp/T1443-sentient-baseline` against a fresh post-change project and compare exit codes/stdout for all sentient commands.
- Existing dispatch regression: `pnpm exec vitest run packages/cleo/src/dispatch/domains/__tests__/sentient.test.ts`.
- Type/build gates: `pnpm exec tsc -b`, `pnpm biome ci .`, `pnpm run build`, `pnpm run test`, and `node scripts/lint-contracts-core-ssot.mjs --exit-on-fail`.

## Package Boundary Check

Code remains in `packages/cleo/src/dispatch/domains/` for CLI dispatch transport and `packages/core/src/sentient/` for SDK/runtime logic, per Package-Boundary Check — verified against AGENTS.md.
