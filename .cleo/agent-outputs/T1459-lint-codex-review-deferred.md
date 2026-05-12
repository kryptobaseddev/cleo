# T1459 lint script — deferred improvements (codex review 2026-04-26)

The DRAFT lint script (`T1459-lint-contracts-core-ssot-DRAFT.mjs`) was reviewed by codex on 2026-04-26. This session applied **must-fix bugs** (ESM `require` crash, regex over-permissiveness on `Params|Result`/`Params|Options`, grep flag fix). The architectural improvements below are **deferred to T1459 execution** and SHOULD be addressed before the script is moved to `scripts/lint-contracts-core-ssot.mjs` and wired into pre-commit + CI.

## Must-fix bugs APPLIED in this session

- ✅ Line 23: added `import { spawnSync } from 'node:child_process'` (was using `require()` in `.mjs` → runtime crash)
- ✅ Line 93: L2 interface scan tightened from `\w+(?:Params|Result)` to `\w+Params` (ADR-057 D2 only mandates Params, not Result)
- ✅ Line 171: spawnSync replaces `require('node:child_process').spawnSync`; grep uses `-rnE` extended regex with `[[:space:]]+` POSIX classes for portability
- ✅ Line 182: signature regex tightened from `\w+(?:Params|Options)` to `\w+Params\b` (ADR-057 D1 mandates Params only)

## Deferred architectural improvements

### L1 — Core fn signature uniformity

**Gap 1**: only catches `export function fn` and `export async function fn`. Misses `export const fn = async (...) => ...` arrow-export style. Many CLEO Core fns use this pattern.

**Gap 2**: never validates the return type `Promise<<Op>Result>`. ADR-057 D1 mandates BOTH input shape AND return shape. Current script silently passes wrong return types.

**Recommendation**: Replace regex-based signature matching with TypeScript Compiler API or `ts-morph` AST traversal. Walk every exported function/arrow declaration, check first-param type is `string` named `projectRoot`, second-param is `<Op>Params`, return is `Promise<<Op>Result>`.

**Mitigation if AST is too heavy**: extend the grep pattern to also match arrow exports (`^export const \w+ = async`) and add a separate regex check for `Promise<\w+Result>` in the same multi-line chunk.

### L2 — Contract alias detection

**Gap**: only checks 3 hardcoded `KNOWN_ALIAS_PAIRS` (`['parent','parentId']`, `['role','kind']`, `['type','kind']`). Comment claims general `<X>Id`/`<X>` pair detection but implementation does not deliver. New alias pairs (e.g. `workspace`/`workspaceId`) silently pass.

**Recommendation**: For each `<Op>Params` interface, build a Set of declared field names. For each name `X` ending with `Id`, check if the bare form `X.replace(/Id$/, '')` is also declared in the same Set. Flag both.

### L3 — Dispatch normalization detection

**Gap**: regex `params\.(\w+)\s*\?\?\s*params\.(\w+)` would match legitimate distinct-field nullish coalescing (e.g. `params.timeout ?? params.deadline` where both are valid contract fields).

**Recommendation**: Load each domain's `<Op>Params` shapes (or all of `packages/contracts/src/operations/<domain>.ts` exports) and only flag `params.X ?? params.Y` when X and Y are in the same Params interface AND L2 considers them aliases. Otherwise it's legitimate fallback logic that the contract intends.

### L4 — Wildcard re-export shortcut

**Gap**: `if (hasWildcard) return;` (line 207, **1-based after the L2 fix above**) bails entirely if `index.ts` has any `export * from '...'`. Internal helpers within wildcard-exported modules leak unchallenged.

**Recommendation**: When a wildcard re-export is found, parse the target file (`packages/core/src/<X>/index.ts` or similar) to enumerate the actual names being re-exported. Add those to the `reExports` Set. Then continue the dispatch-import check normally. This makes the script SOUND but not COMPLETE — at minimum, it catches direct violations.

### Enumeration filters

**Gap**: `!f.includes('test')` (lines 129, 156, 210) skips any file with "test" anywhere in the name. A legitimate file like `test-utils.ts` or `_internal/test-helpers.ts` could be linted-relevant in some contexts, and `__tests__/foo.ts` is correctly skipped — the current heuristic is too aggressive.

**Recommendation**: Skip only files matching `\.(test|spec)\.tsx?$` or living under `__tests__/`. Use a precise pattern.

### Multi-line signature window

**Gap**: `slice(ln-1, ln+5)` (6 lines) may miss legitimate signatures spanning more lines, especially with generic constraints or JSDoc.

**Recommendation**: Read until the first occurrence of `): Promise<` (signature end marker) or 20 lines, whichever is shorter.

## Verdict

After must-fix bugs applied, the script will RUN without crashing but still has significant SOUNDNESS gaps. Recommended T1459 execution:

1. Move corrected draft to `scripts/lint-contracts-core-ssot.mjs`
2. **Apply at least L1 arrow-export catch + L2 general alias detection** before wiring CI gate
3. Wire to `.husky/pre-commit` AND `.github/workflows/ci.yml`
4. Run locally — should report 0 violations after T1454+T1458 land
5. **Follow-up task**: AST-backed rewrite of L1+L3 + wildcard L4 fix (~2-day effort, file as T149X)

## Live lint output after must-fix bugs (2026-04-26 23:43 UTC)

The corrected script now runs cleanly. Live findings against current main + worktree state:

### Confirmed in-scope for batch 4

T1458 alias-pair violations (Part B scope):
- `tasks.ts:581` — TasksAddParams has both `parent` + `parentId`
- `tasks.ts:594` — TasksAddParams has both `role` + `kind`
- `tasks.ts:617` — TasksUpdateQueryParams has both `parent` + `parentId`

T1458 dispatch normalization violations (handoff explicit):
- `dispatch/domains/tasks.ts:439` — params.parent ?? params.parentId
- `dispatch/domains/tasks.ts:452` — params.role ?? params.kind
- `dispatch/domains/tasks.ts:481` — params.parent ?? params.parentId

### NEW findings (not in original handoff — should be addressed by T1458 worker or filed as follow-up)

- `tasks.ts:586` — TasksAddParams has both `type` + `kind` (3-way alias group with role)
- `dispatch/domains/tasks.ts:473` — params.notes ?? params.note
- `dispatch/domains/tasks.ts:647` — params.relatedId ?? params.targetId

### NEW finding in T1450 (already marked done — for verification, not regression)

- `dispatch/domains/session.ts:246` — params.startTask ?? params.focus

This may be a legitimate distinct-field fallback (T1450 worker validated). Likely a CLI ergonomics intent (two flag spellings for the same param). To resolve cleanly per ADR-057 D2: move the alias to CLI command layer like the tasks ADR pattern.

### Out-of-scope L1 false-positives (codex predicted)

The L1 pass flags ~25 Core fns that aren't dispatch ops at all — utilities like `getProjectRoot`, `getLogger`, `paginate`, `revalidateEvidence`, `validateChain`, ADR fns (`findAdrs`, `listAdrs`, `showAdr`, `syncAdrsToDb`, `validateAllAdrs`), token-service helpers, snapshot helpers, etc. These are imported by dispatch ops but they themselves aren't dispatch handlers. The L1 rule needs a way to distinguish "dispatch operation entry point" from "internal helper used by an entry point". This confirms codex's L1 false-positive risk and **must be fixed before T1459 wires the CI gate** — otherwise CI will reject every PR.

**Suggested L1 fix**: only flag Core fns whose names match the dispatch handler's `coreOps` map (e.g., for `domains/tasks.ts`, only Core fns referenced as values of the `coreOps = { ... } as const` literal). Internal helpers used by those entry points are out of scope.

## Source review

- Codex agent: a61261fb902db0efb (codex-rescue subagent · CLI v0.125.0 · 2026-04-26)
- BRAIN observations: `O-mogex9yg-0` (codex review verdict), pending observation for live findings
- This file: `.cleo/agent-outputs/T1459-lint-codex-review-deferred.md`
