# Doc-Sync Audit — 2026-04-20

Auditor: doc-sync subagent  
Date: 2026-04-20  
Scope: root README, per-package READMEs (14 packages), forge-ts CI gate

---

## Phase 1A — Root README.md Audit

### Build Verification

`pnpm install && pnpm run build` **FAILS** as of HEAD (`ecb9c6926`).

```
[build] ERROR: packages/core/package.json exports has subpaths with no
[build] corresponding esbuild entry point in coreBuildOptions.entryPoints.
```

Root cause: `packages/core/package.json` exports five `nexus/contracts/*`
subpaths (`./nexus/contracts`, `./nexus/contracts/http-extractor.js`,
`./nexus/contracts/grpc-extractor.js`, `./nexus/contracts/topic-extractor.js`,
`./nexus/contracts/matcher.js`). Corresponding entry points ARE in `build.mjs`,
but the source files they reference (`packages/core/src/nexus/contracts/*.ts`)
do not exist on disk. The nexus contract types live in
`packages/contracts/src/nexus-contract-ops.ts` et al, not in core.

**Drift #1 (CRITICAL):** Root README states "pnpm install && pnpm build" works.
It does not. Build is broken at HEAD.

### Package Count Claim

Root README states: "This monorepo contains **12 packages** organized in a 4-layer architecture."

Actual package count: **15**

Packages in README:  
`contracts`, `lafs`, `adapters`, `agents`, `skills`, `cant`, `nexus`, `caamp`,
`runtime`, `core`, `cleo`, `cleo-os`

Packages on disk NOT in README table:
- `packages/brain` — `@cleocode/brain`, a first-class workspace package (T962)
- `packages/playbooks` — `@cleocode/playbooks`, the `.cantbook` runtime
- `packages/studio` — `@cleocode/studio`, the SvelteKit UI (no README at all)

**Drift #2:** Package count is 15, not 12. Three packages are entirely absent from
the README table.

### Feature Bullet Spot-Check (5 claims)

| Claim | Verdict |
|-------|---------|
| "Multi-Provider Support: Works with Claude Code, OpenCode, Cursor, Gemini, Codex, and more" | ACCURATE — all six adapters exist in `packages/adapters/src/providers/` (plus claude-sdk, openai-sdk, pi) |
| "BRAIN-powered knowledge storage with semantic search" | ACCURATE — `@cleocode/brain` package ships the unified-graph substrate |
| "248 total operations (134 queries, 95 mutations, 19 experimental)" | UNVERIFIABLE from static analysis without running `cleo check canon`; value matches memory-bridge record. Not flagged as wrong, but stale risk is high if domains change. |
| "pnpm >= 10.30.0" prerequisite | ACCURATE — matches pnpm-workspace.yaml lockfileVersion |
| "Circle of Eleven — 11 canonical domains" (architecture diagram says "11 domains") | PARTIALLY INACCURATE — diagram header says "11 domains" but root README section is titled "The Circle of Eleven"; the cleo package README diagram shows "12 domain handlers". Count discrepancy between root README, package README, and code. |

**Drift #3:** Domain count is inconsistently stated (11 in root README vs 12 in
cleo package README diagram). Memory records note 11 canonical + `intelligence`
undocumented = 11 public.

**Drift #4:** Root README "Quick Start" uses `npm install -g @cleocode/cleo` but
the project uses pnpm exclusively. Installation via npm/npx is valid for end-users,
but the "Development Setup" section correctly shows `pnpm`. Minor inconsistency but
worth noting since the project convention prohibits npm.

### Summary of Root README Drift

| # | Severity | Item |
|---|----------|------|
| 1 | CRITICAL | `pnpm run build` fails — missing source files for nexus/contracts |
| 2 | HIGH | Package count: claims 12, actual 15 (brain, playbooks, studio missing) |
| 3 | MEDIUM | Domain count: "11 domains" in root README vs "12 domain handlers" in cleo README |
| 4 | LOW | Quick Start uses `npm install -g` where convention is pnpm |

**Total root README drift items: 4**

---

## Phase 1B — Per-Package README Audit

### `@cleocode/adapters`

README claims 3 supported providers: Claude Code, OpenCode, Cursor.

Actual providers on disk (`packages/adapters/src/providers/`):
`claude-code`, `claude-sdk`, `codex`, `cursor`, `gemini-cli`, `kimi`,
`openai-sdk`, `opencode`, `pi`

**DRIFT:** README is missing 6 of 9 providers. `claude-sdk`, `codex`,
`gemini-cli`, `kimi`, `openai-sdk`, and `pi` are all implemented but
not documented.

### `@cleocode/agents`

README describes the LOOM/RCASD lifecycle and `cleo-subagent/AGENT.md`.  
`package.json` has **no exports field** — this package ships markdown
agent protocol files, not TypeScript. README accurately describes the
actual contents. No structural drift.

### `@cleocode/brain`

README accurately describes the unified-graph substrate, five-database
topology, `getAllSubstrates()`, and the `@cleocode/brain/adapters` subpath.  
Package exports match what README documents (`.` and `./adapters`).  
**No drift detected.**

### `@cleocode/caamp`

README states "44 AI coding agents" (badge + text). The provider registry
source (`packages/caamp/src/core/registry/providers.ts`) has no entries
matching the badge count — the registry file appears to import from an
external source or is not in the scanned path. The actual provider list is
not statically verifiable without running the CLI. Treat as **unverified
claim** until count can be confirmed programmatically.

forge-ts reports: **588 symbols checked, 0 errors, 53 warnings** in the
`caamp` package. Coverage is the best-documented package in the repo.

### `@cleocode/cant`

README accurately documents the public API (`parseDocument`,
`validateDocument`, `executePipeline`, etc.), mentions the napi-rs
Rust binding, and notes fallback behavior on unsupported platforms.  
Package exports only `.` (no named subpaths in package.json).  
README accurately reflects exports. **No drift detected.**

### `@cleocode/cleo`

README claims "100+ commands" throughout. Actual operation count per the
canon is 248. "100+" is technically true but significantly understates
reality and diverges from the root README's accurate "248 operations" claim.

README diagram shows "12 domain handlers" while root README shows 11
domains in the architecture table. Inconsistency is unresolved.

**DRIFT:** Command count understated ("100+") vs actual 248. Domain count
inconsistent with root README.

### `@cleocode/cleo-os`

README describes CleoOS as wrapping Pi with CLEO governance. Source code
confirms this (`src/cli.ts` launches Pi with CANT bridge). Five "Named
Powers" table references the five CLEO systems (TASKS, BRAIN, LOOM,
NEXUS, CANT) — consistent with the six-systems canon (CONDUIT is the
sixth, not listed in cleo-os powers).

The README `main` export points to `dist/cli.js` — README discusses the
`cleoos` binary launcher correctly.  
**Minor gap:** README does not mention `@cleocode/cleo-os` also installs
a `cleo` binary alongside `cleoos` and `ct`.  
**No structural drift.**

### `@cleocode/contracts`

README documents Task, Session, DataAccessor, and Memory types.  
Package has **6 subpath exports** beyond `.`:
`nexus-contract-ops`, `nexus-living-brain-ops`, `nexus-query-ops`,
`nexus-route-ops`, `nexus-tasks-bridge-ops`.

README does **not** mention any of these nexus operation subpaths.  
**DRIFT:** Five nexus operation subpaths are undocumented in README.

### `@cleocode/core`

README accurately documents the primary SDK surface, the consumer table
(CLI→internal, Studio→sdk, agents→sdk, type-only→contracts), and the
subpath contract/stability model.

Documented subpaths in README: `.`, `/sdk`, `/internal`, `/contracts`,
`/tasks`, `/memory`, `/sessions`, `/lifecycle`.

Undocumented in README but present in `package.json` exports:
`/conduit`, `/nexus` (+ 20+ nexus/* wildcards), `/sentient` (+
15 sentient/* named entries), `/gc` (+ 4 gc/* named entries),
`/system/platform-paths.js`, and wildcard `./*`.

**DRIFT:** The README consumer table is accurate for the primary stable
subpaths but does not document the conduit, sentient, gc, or system
subpath surfaces. These are real exports consumed by other packages.

### `@cleocode/lafs`

README documents the envelope contract, A2A integration, schemas, and
tooling. Package exports include `./a2a`, `./a2a/bindings`, `./discovery`,
and five JSON schema paths.

README mentions A2A integration prominently and the discovery export is
referenced in the feature table. JSON schema paths are documented in the
"What LAFS provides" table.  
**No structural drift.**

### `@cleocode/nexus`

README documents the basic API (`detectLanguage`, `parseFile`,
`smartSearch`). Package has three subpath exports: `.`, `./internal`,
`./pipeline`.

README does **not** mention `./internal` or `./pipeline` subpaths.  
**DRIFT:** Two non-default subpaths (`/internal`, `/pipeline`) are
undocumented.

### `@cleocode/playbooks`

README accurately reflects the `.cantbook` DSL and the wave-status table.
Importantly, it claims the runtime executor (W4-10) is "pending."

Actual state: `packages/playbooks/src/runtime.ts` exists and is fully
implemented (T930 Playbook Runtime State Machine). The file has a complete
TSDoc header describing the deterministic state machine.

**DRIFT:** README wave status table still marks "State-machine runtime" as
`pending`. It has shipped. This is stale status.

### `@cleocode/runtime`

README accurately documents `createRuntime`, `RuntimeConfig`,
`RuntimeHandle`, and the four service classes. Package exports only `.`.
**No drift detected.**

### `@cleocode/skills`

README lists 20 skills in tables (Core, Research, Documentation, Dev,
Orchestration, Grading). Actual skills on disk: **30**.

Skills on disk NOT in README:
- `ct-adr-recorder`
- `ct-artifact-publisher`
- `ct-consensus-voter`
- `ct-ivt-looper`
- `ct-master-tac`
- `ct-provenance-keeper`
- `ct-release-orchestrator`
- `ct-grade-v2-1` (listed under Grading but no description)
- `signaldock-connect`
- `_shared` (internal, not public-facing)

**DRIFT:** 8-9 skills are undocumented in the README.

### `@cleocode/studio`

**No README exists.** This is a SvelteKit UI package with significant
source code. It is also absent from the root README package table.

**DRIFT:** No README at all. Not referenced from root README.

### Per-Package Drift Summary

| Package | Drift Severity | Issue |
|---------|---------------|-------|
| `adapters` | HIGH | Missing 6 of 9 providers in Supported Providers table |
| `contracts` | MEDIUM | 5 nexus operation subpaths undocumented |
| `core` | MEDIUM | conduit, sentient, gc, system subpaths undocumented |
| `nexus` | LOW | ./internal and ./pipeline subpaths undocumented |
| `playbooks` | MEDIUM | Runtime executor marked "pending" — it has shipped |
| `skills` | MEDIUM | 8+ skills on disk not in README |
| `cleo` | LOW | "100+ commands" understates 248 ops; domain count vs root inconsistency |
| `studio` | HIGH | No README exists; not in root package table |
| `agents` | OK | Accurate |
| `brain` | OK | Accurate |
| `cant` | OK | Accurate |
| `caamp` | OK | Mostly accurate (provider count unverifiable) |
| `cleo-os` | OK | Mostly accurate |
| `lafs` | OK | Accurate |
| `runtime` | OK | Accurate |

**Packages with drift: 8** (adapters, contracts, core, nexus, playbooks, skills, cleo, studio)

---

## Phase 2 — forge-ts Coverage Analysis

### Root forge-ts.config.ts

Location: `/mnt/projects/cleocode/forge-ts.config.ts`

The root config runs against the monorepo tsconfig (`./tsconfig.json`).
When run from the repo root (`pnpm exec forge-ts check --human`), forge-ts
fails immediately with:

```
forge-ts check: FAILED
  2 error(s), 0 warning(s) across 1 file(s) (0 symbols checked)
  E009: tsconfig.json: required flag "strictNullChecks" is missing — expected true
  E009: tsconfig.json: required flag "noImplicitAny" is missing — expected true
```

The root `tsconfig.json` uses `"strict": true` (which implies both flags)
but does not set them explicitly. forge-ts E009 rule requires explicit
presence. **Result: 0 symbols checked at root level.**

### Per-Package forge-ts (caamp — the only configured package)

`packages/caamp/forge-ts.config.ts` is the only per-package config.

Result: **588 symbols checked, 0 errors, 53 warnings** (`forge-ts check` exits 0).

The 53 warnings are primarily `require-remarks` (narrative quality) and
`require-tsdoc-syntax` violations — the rules are set to `warn` so they
do not block CI. `caamp` is the best-documented package.

### Coverage Estimate for Other Packages

No other packages have `forge-ts.config.ts`. Coverage cannot be measured
programmatically without configs. A coarse grep-based estimate of
exported symbols with no TSDoc:

| Package | Exported `export ` statements | Rough undocumented estimate |
|---------|---------|---------|
| `core` | ~4,534 | High — most internal subpath functions lack TSDoc |
| `contracts` | ~1,265 | Medium — many type-only exports, but no function docs |
| `caamp` | ~554 | Low — forge-ts confirms 0 errors in 588 symbols |
| `lafs` | ~293 | Unknown |
| `cant` | ~143 | Unknown |
| `adapters` | ~184 | Unknown |
| `nexus` | ~184 | Unknown |
| `playbooks` | ~51 | Unknown |
| `runtime` | ~21 | Low (README shows good TSDoc on public API) |
| `brain` | ~34 | Unknown |

Estimated **overall TSDoc coverage: below 50%** based on the ratio that
only `caamp` (the largest non-core package) has been audited and passes.
The `core` package alone has ~4,534 exported symbols and no forge-ts config.

### CI Gate Status

The CI job `forge-ts-check` **exists** in `.github/workflows/ci.yml` (lines 328–357).

However, it is **non-blocking**:
- `continue-on-error: true` — job failure does not fail the PR
- Both check and build steps end with `|| true` — failures are silently swallowed

**The forge-ts gate exists but has zero enforcement power.** It is purely
informational.

### forge-ts Configuration Issues

1. **Root config E009 failure** — `strict: true` in tsconfig is not
   recognized by forge-ts. Need explicit `"strictNullChecks": true` and
   `"noImplicitAny": true` in root tsconfig, or forge-ts config must
   point to a per-package tsconfig.

2. **No per-package configs** except caamp — forge-ts cannot measure
   coverage for the other 14 packages without configs.

3. **CI gate is opt-in soft** — `continue-on-error: true` means a
   complete documentation regression would merge silently.

---

## Phase 3 Stub — Proposed forge-ts CI Hardening

For the Phase 3 plan see `docs/plans/README-AUTO-REGEN.md`.

Quick recommendation on CI: remove `continue-on-error: true` and the
`|| true` suffixes once coverage thresholds are established per-package.
Phase in over 3 releases starting at 70%, targeting 95%. The `caamp`
package already passes at 0 errors; it can be the pilot for hard-failing.

---

## Appendix — Evidence

| Fact | Source |
|------|--------|
| Build failure | `pnpm run build` exit 1, esbuild error for nexus/contracts |
| nexus/contracts source missing | `ls packages/core/src/nexus/contracts/` → not found |
| Package count | `ls packages/` → 15 entries |
| Adapters providers | `ls packages/adapters/src/providers/` → 9 dirs |
| Skills count | `ls packages/skills/skills/` → 30 entries |
| forge-ts caamp result | `pnpm exec forge-ts check --human` in packages/caamp → 588 symbols, 0 errors |
| forge-ts root result | `pnpm exec forge-ts check --human` at root → 0 symbols, 2 E009 errors |
| CI gate location | `.github/workflows/ci.yml` lines 328-357, `continue-on-error: true` |
| playbooks runtime.ts shipped | File exists, 100+ lines of TSDoc header referencing T930 |
