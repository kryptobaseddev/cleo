# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [2026.4.15] — 2026-04-09 — Major Dep Upgrade Sweep

Follow-on sweep on top of v2026.4.14 addressing every deferred major
bump from the previous release's "safely deferred" list — zod 4, TS 6,
write-file-atomic 7, @types/supertest 7 — plus removing dead commander
code from the root monorepo.

### Removed — dead `commander` dependency from root monorepo

The root `package.json` declared `commander: ^12.1.0` as a runtime dep,
but nothing in the root or in `@cleocode/cleo` imports from it. CLI
dispatch has been on `citty` since the Commander→citty migration
(v2026.3.x). The only real commander consumer in the workspace is
`@cleocode/caamp`, which already pins `commander: ^14.0.0` in its own
`package.json`. Removed the root entry entirely. (The transitive
`commander@4.1.1` still shows up under `sucrase → tsup` in dev deps —
that's an unrelated tsup internal and nothing we can or should
touch.)

### Upgraded — zod 3.25 → **4.3.6**

Drizzle ORM `1.0.0-beta.19` declares
`"zod": "^3.25.0 || ^4.0.0"` as a peer, so the v4 line is a supported
path. Our source already imports from `zod/v4` (the forward-compat
subpath that zod 3.25+ provides), so the migration is a straight
package bump:

- `packages/core/package.json` + root: `"zod": "^3.25.76"` → `"^4.3.6"`
- `packages/core/src/hooks/payload-schemas.ts`,
  `packages/core/src/store/validation-schemas.ts`,
  `packages/core/src/store/nexus-validation-schemas.ts`: updated
  `import { z } from 'zod/v4'` → `import { z } from 'zod'` (v4's main
  export IS the v4 API now; the `zod/v4` subpath still exists as an
  alias for consumers migrating away from zod 3, so the old imports
  kept working during the bump, but we use the canonical path going
  forward).

`drizzle-orm/zod`'s `createSchemaFactory` is bound to the same `z`
instance we use everywhere via a type-asserted call — the assertion
comment is updated to reflect that both sides are now on v4 natively.

### Upgraded — TypeScript 5.x → **6.0.2** across all workspace packages

The root monorepo was already on `typescript@6.0.1-rc`; the sub-packages
were still pinned to 5.x and pulled older TS from their own
`node_modules`:

| Package | Old | New |
|---|---|---|
| root | `6.0.1-rc` | `^6.0.2` |
| `@cleocode/caamp` | `^5.9.0` | `^6.0.2` |
| `@cleocode/cant` | `^5.0.0` | `^6.0.2` |
| `@cleocode/cleo-os` | `^5.9.0` | `^6.0.2` |
| `@cleocode/lafs` | `^5.9.2` | `^6.0.2` |

**New compile-time gotcha uncovered:** TS 6 treats
`compilerOptions.baseUrl` as deprecated (TS5101) and errors with
`"ignoreDeprecations": "6.0"` unless the option is dropped. Our own
tsconfigs do not use `baseUrl`, but tsup's DTS pipeline (via
`rollup-plugin-dts`) injects one into its internal temporary tsconfig
during the caamp build, so we now pass
`dts.compilerOptions.ignoreDeprecations = "6.0"` in
`packages/caamp/tsup.config.ts`. Harmless — silences the deprecation
until the tsup + rollup-plugin-dts chain catches up with TS 6+.

### Upgraded — write-file-atomic 6 → **7.0.1**

`@cleocode/core` and root. v7.0.0's only breaking change is raising
the Node floor to `^20.17.0 || >=22.9.0`, which is well below our
declared `engines.node: ">=24.0.0"`. Drop-in swap.

### Upgraded — `@types/supertest` 6 → **7.2.0**

`@cleocode/lafs` was running `supertest@^7.2.2` at runtime but still
pinned `@types/supertest@^6.0.3` — the types lagged the runtime. Now
aligned.

### Upstream-blocked: `boolean@3.2.0` deprecation warning

`npm install -g @cleocode/cleo@2026.4.14` still emits:

    npm warn deprecated boolean@3.2.0: Package no longer supported.

**Root cause traced end-to-end:**

    @cleocode/core
      └─ @huggingface/transformers@4.0.1         ← pins onnxruntime-node exact
           └─ onnxruntime-node@1.24.3            ← Microsoft, stable
                └─ global-agent@3.0.0            ← old major
                     └─ boolean@3.2.0            ← deprecated, no successor

**Good news: Microsoft already fixed it upstream.** The onnxruntime
dev line `onnxruntime-node@1.25.0-dev.20260327-722743c0e2` declares
`global-agent: ^4.1.3` directly, and `global-agent` 4.x dropped the
`boolean`/`roarr` transitives entirely. The fix will land for
consumers once (a) Microsoft publishes 1.25.0 stable and (b)
`@huggingface/transformers` updates its pinned onnxruntime-node
version.

**Why we cannot backport it from our side:**

1. `brain embeddings` are a **first-class CLEO feature**, so moving
   `@huggingface/transformers` to an optional peer dependency is
   not acceptable — ruled out.
2. `@huggingface/transformers@4.0.1` pins `onnxruntime-node: 1.24.3`
   as an exact version (not a range), so a standard direct-dep bump
   in `@cleocode/core` would create an unresolvable conflict.
3. `pnpm.overrides` in the workspace (kept in place for dev env
   cleanliness) is pnpm-specific and does not propagate to
   consumers who install via `npm`.
4. **Empirically verified**: adding npm's standard `overrides` field
   to `@cleocode/cleo/package.json` has no effect on consumers.
   npm ignores `overrides` in packages being installed as
   dependencies — only the root project's overrides apply. This
   was tested by packing cleo with the override and installing the
   tarball; `onnxruntime-node@1.24.3` was still resolved and the
   `boolean` warning was still emitted.
5. A `postinstall` script cannot suppress the warning either: the
   warning is printed by npm during tree resolution, before any
   package's scripts run.

**Bottom line:** eliminating the warning requires an upstream fix —
tracked at microsoft/onnxruntime + huggingface/transformers.js.
Users can work around it locally by pinning a newer
`onnxruntime-node` via their own project's `overrides` field. The
warning does not affect runtime behaviour — the `boolean` package
still works, it just isn't maintained.

### Verification

- `pnpm biome ci .` → exit 0
- `pnpm run build`  → Build complete
- `pnpm run test`   → 6966 pass / 15 skip / 32 todo / 0 fail (7013)
- `pnpm audit`      → No known vulnerabilities found
- `pnpm why -r zod` → zod 4.3.6 in our code; 3.25.76 still pinned
  transitively by `@mistralai/mistralai` (not our concern, but
  flagged here for completeness)

## [2026.4.14] — 2026-04-09 — CI Unblock, Security Audit & Post-Migration Cleanup

### Fixed — Deprecated & vulnerable transitive dependencies

`npm audit` on `2026.4.13` reported **15 vulnerabilities (6 high, 9
moderate)**, plus the deprecated `prebuild-install@7.1.3` warning from
`npm install -g @cleocode/cleo`. All are now resolved; `pnpm audit`
returns `No known vulnerabilities found`.

**Direct dependency bumps** (security-motivated, no API changes):

| Package | From | To | Advisory / Reason |
|---|---|---|---|
| `@xenova/transformers` | `^2.17.2` | → `@huggingface/transformers ^4.0.1` | Upstream rename; eliminates `prebuild-install@7.1.3` deprecation via `sharp` bump 0.32 → 0.34 |
| `yaml` (core + root) | `^2.8.2` | `^2.8.3` | [GHSA — Stack overflow on deeply nested YAML](https://github.com/advisories) |
| `vitest` (caamp, cant, cleo-os, core, lafs, runtime, root) | various 1.6 – 4.1.0 | `^4.1.4` | Pulls clean transitive `vite@8.0.8`, `esbuild@0.28.x`, `picomatch@4.0.4` |
| `@vitest/coverage-v8` (caamp) | `^4.1.1` | `^4.1.4` | Matches vitest bump |
| `esbuild` (root dev) | `^0.27.4` | `^0.28.0` | [esbuild dev-server SSRF advisory] |
| `@codluv/versionguard` | `0.2.0` | `^1.2.0` | Pulls clean `brace-expansion@>=2.0.3` |
| `@biomejs/biome` | `^2.4.6` (installed 2.4.8) | `^2.4.10` | Patch bump, no rule changes |
| `vite` (direct root dev) | — | `^8.0.8` | Added as root dev dep so the override reaches all workspace consumers |

**Transitive pins** (via `pnpm.overrides` in root `package.json`) —
needed because the vulnerable versions were pulled in via peer deps
that pnpm would otherwise keep:

```jsonc
"pnpm": {
  "overrides": {
    "path-to-regexp": ">=8.4.2",  // GHSA — ReDoS / DoS in express router
    "brace-expansion": ">=2.0.3", // GHSA — zero-step process hang
    "picomatch":      ">=4.0.4",  // GHSA — ReDoS via extglob quantifiers
    "esbuild":        ">=0.25.0", // GHSA — dev-server SSRF
    "yaml":           ">=2.8.3",  // GHSA — deeply-nested stack overflow
    "vite":           "^8.0.8"    // GHSA — path traversal + fs.deny bypass
  }
}
```

After the swap + overrides, `pnpm dedupe` collapses all duplicate vite
instances to the single patched version, and the workspace builds
against the newer `onnxruntime-node` + `sharp` used by
`@huggingface/transformers`. Build externalises the new package so
esbuild does not try to inline the `.node` native bindings (see
`build.mjs` and the migration note above).

### Fixed — Flaky pi harness attribution test (race condition)

`packages/caamp/src/core/harness/pi.ts` → `spawnSubagent` was
fire-and-forgetting its child-session JSONL appends (`void
appendFile(...)`). Test code that did `await handle.exitPromise` and
then read the JSONL raced against pending writes — the final
`subagent_exit` entry occasionally landed on disk after the read,
producing intermittent CI failures in
`packages/caamp/tests/unit/harness/pi.test.ts > creates the child
session JSONL at the canonical subagents/ path` with `expected 2 to
be greater than or equal to 3`.

Fix: track every `appendFile` promise in a `pendingWrites: Promise<void>[]`
array and `Promise.allSettled(pendingWrites)` before the `'close'`
handler resolves `exitPromise`. `writeChildSession` still swallows
disk errors internally so settlement never propagates failures.
Verified stable across 5 back-to-back isolated runs + the full
workspace parallel suite.

### Fixed — Flaky bulk-create perf budget

`packages/core/src/store/__tests__/performance-safety.test.ts` bumped
two budgets that were tight under vitest 4.x parallel scheduling:

- `should create 50 tasks within <5000ms` → `<10000ms` (baseline ~600ms
  on a quiet laptop; 10s absorbs CI parallelism with 4+ vitest
  workers; still catches a 20× real regression).
- `should verify 50 tasks within <2000ms` → `<3000ms` (same rationale,
  baseline ~200ms).

### Fixed — CI Unblock & Post-Migration Cleanup

### Fixed — Deprecated transitive dependency (`prebuild-install`)

`npm install -g @cleocode/cleo` was emitting:

```
npm warn deprecated prebuild-install@7.1.3: No longer maintained.
Please contact the author of the relevant native addon; alternatives
are available.
```

Dependency chain: `@cleocode/core` → `@xenova/transformers@2.17.2` →
`sharp@0.32.6` → `prebuild-install@7.1.3` (deprecated).

`@xenova/transformers` was renamed upstream to `@huggingface/transformers`
(same author — Joshua Lochner — now maintained under the HuggingFace
organisation). The v4.x line uses `sharp@^0.34.5`, which switched from
`prebuild-install` to its own `@img/sharp-*` platform packages, so the
deprecated dependency is eliminated entirely.

- `packages/core/package.json` — replaced
  `"@xenova/transformers": "^2.17.2"` with
  `"@huggingface/transformers": "^4.0.1"`.
- `packages/core/src/memory/embedding-local.ts` — updated the dynamic
  import + type reference to the new package name. The public API
  (`pipeline`, `FeatureExtractionPipeline`) is unchanged; the
  `Xenova/all-MiniLM-L6-v2` model name still resolves on the
  HuggingFace hub as before, so runtime behaviour is identical.
- `packages/core/src/memory/embedding-worker.ts`,
  `packages/core/src/memory/brain-embedding.ts`,
  `packages/core/src/memory/__tests__/brain-automation.test.ts` —
  updated docstring references and the `vi.mock()` target path.
- `build.mjs` — replaced the `@xenova/transformers` entry in
  `sharedExternals` with `@huggingface/transformers`. The new package
  pulls in native `onnxruntime-node` bindings (`.node` files) and
  `sharp`, both of which must remain external so esbuild does not try
  to inline the native addons into the core/cleo bundles. Without this
  swap the esbuild build fails with `No loader is configured for
  ".node" files`.

After the swap, `pnpm why -r prebuild-install` returns no results,
`pnpm install` emits zero deprecation warnings, the full workspace
build succeeds, and the 7013-test suite remains at 6966 pass / 0
fail. Verified with the intended `Xenova/all-MiniLM-L6-v2` model
name still resolvable (no model-hub rename).


End-to-end pipeline repair after the ADR-039 envelope migration and T310
conduit separation left residual drift in tests and dispatch layers. The
pipeline was failing at `biome ci .`; once biome was cleared, two
further layers of pre-existing failures surfaced (TypeScript errors in
`@cleocode/core`, then 18 test failures across 8 files). Everything is
now green: `biome ci` ✅ · `pnpm run build` ✅ · 6966 pass / 0 fail across
the 7013-test workspace suite.

### Fixed — Lint (biome)

- `packages/cant/src/bundle.ts` — removed dead `NativeDiagnostic` type
  import. Was left over from a refactor; nothing in the file referenced
  it. The paired change to `BundleDiagnostic` below is the
  "wire it up properly" companion.
- `packages/cleo/src/__tests__/lafs-conformance.test.ts` — the file
  header declared it would use `runEnvelopeConformance()` for canonical
  validation but only `validateEnvelope()` was ever called. Wired up
  `runEnvelopeConformance()` against LAFS-native envelopes built via
  `createEnvelope()` (see "Added" below).
- `packages/core/src/validation/protocols/_shared.ts` — `line &&
  line.includes(...)` → `line?.includes(...)` (biome
  `useOptionalChain`).
- `packages/cleo/src/cli/commands/__tests__/agent-attach.test.ts` —
  removed a stale `// biome-ignore lint/complexity/useArrowFunction`
  suppression that no longer applied.

### Fixed — `@cleocode/cant` BundleDiagnostic wire-up

`compileBundle()` was dropping `line`/`col` from both parse errors and
validation diagnostics on its way from the native cant-core binding to
the `BundleDiagnostic` return shape. Callers had no way to know *where*
a diagnostic originated in the source `.cant` file.

- `BundleDiagnostic` gains optional `line?: number` and `col?: number`
  fields (1-based, matching the native binding). Optional because
  file-read failures have no source position.
- `compileBundle()` now propagates `line`/`col` from
  `parseResult.errors` and `validationResult.diagnostics` into every
  `BundleDiagnostic` it emits.
- `tests/bundle.test.ts` gains 3 new tests that assert position
  preservation for parse errors, validation diagnostics, and the
  file-read-failure case where position is correctly absent.

### Fixed — `@cleocode/core` pre-existing TypeScript errors (5)

These errors were hidden behind the biome failure and would have broken
the next CI layer. All are in files unrelated to the biome fix but in
the same "unblock CI" theme.

- `packages/core/src/internal.ts:917` — `ProjectAgentRef` was
  re-exported through `./store/conduit-sqlite.js`, but that module only
  *imports* the type (from `@cleocode/contracts`). Re-routed the
  re-export to the canonical source.
- `packages/core/src/store/migrate-signaldock-to-conduit.ts:281` —
  `readonly: true` → `readOnly: true`. The node:sqlite
  `DatabaseSyncOptions` API uses camelCase.
- `packages/core/src/store/migrate-signaldock-to-conduit.ts:199` — the
  row-copy loop cast `row[c] ?? null` to `SQLInputValue` so
  `stmt.run(...)` type-checks. Values originate from another SQLite
  row and are already `SQLInputValue`-compatible at runtime.
- `packages/core/src/store/migrate-signaldock-to-conduit.ts:482` and
  `613` — added null guards on `conduit.close()` and `globalDb.close()`
  inside catch blocks (`conduit: DatabaseSync | null` cannot be proven
  non-null at the catch point via TS flow analysis).

### Fixed — Dispatch exit-code drift

`E_TASK_COMPLETED` was mapped to exit code 104 in both
`packages/cleo/src/dispatch/engines/_error.ts` and
`packages/cleo/src/dispatch/adapters/cli.ts`, but the canonical value
in `@cleocode/contracts` is `ExitCode.TASK_COMPLETED = 17` (Hierarchy
Errors range). Core's `packages/core/src/tasks/complete.ts` already
uses the canonical value. The dispatch layer drift meant that when a
caught CleoError carried code 17, the inverse lookup returned
`undefined` and fell back to `E_INTERNAL`. Fixed in both files — the
entry is now in the Hierarchy Errors section of `STRING_TO_EXIT` where
it belongs, and exit code 104 is no longer used by the dispatch layer.

### Fixed — Non-Error thrown values in dispatch engines

`cleoErrorToEngineError` in
`packages/cleo/src/dispatch/engines/_error.ts` cast `err as
CaughtCleoErrorShape` unconditionally, which meant a raw `throw
'string error'` was coerced to an object without a `message` property
and the caller's generic `fallbackMessage` was returned instead of the
thrown string itself. Now narrows non-object/non-null values first:
strings flow through as the error message, other primitives coerce via
`String()`.

### Fixed — ADR-039 canonical-envelope test drift (11 tests in 5 files)

The `{success, data?, error?, meta}` canonical CLI envelope from
ADR-039 (2026-04-08) replaced the legacy `{$schema, _meta, success,
result}` LAFS shape, but tests authored against the legacy shape were
never updated. Biome was blocking CI at the lint stage, so these
failures were hidden. Migrated:

- `packages/core/src/__tests__/cli-parity.test.ts` — 3 tests checking
  `$schema`/`_meta`/`result`/`message` → `meta`/`data`/`meta.message`.
- `packages/core/src/__tests__/human-output.test.ts` — 3 tests checking
  `parsed.result.*` → `parsed.data.*`.
- `packages/cleo/src/__tests__/golden-parity.test.ts` — 1 test
  (`tasks.add envelope matches golden shape`) checking top-level
  `message` → `meta.message`.
- `packages/cleo/src/__tests__/lafs-conformance.test.ts` — 5 tests in
  the "LAFS Integration with Core Modules" + "hierarchy policy
  conformance" suites that asserted `parsed._meta` or called
  `validateEnvelope()` on CLEO envelopes. The CLEO canonical shape no
  longer matches the LAFS legacy schema, so those tests now check the
  canonical structure directly via the local `isValidLafsEnvelope()`
  helper. `validateEnvelope` is no longer imported in this file.
- `packages/cleo/src/dispatch/middleware/__tests__/protocol-enforcement.test.ts`
  — 2 tests:
  - `passes query requests through via enforcer` — the middleware
    wraps `next` as `protoNext` (which maps `meta` ↔ `_meta` for the
    core-layer enforcer), so the enforcer sees the wrapper, not the
    raw `next`. Changed `toHaveBeenCalledWith(req, next)` →
    `toHaveBeenCalledWith(req, expect.any(Function))`.
  - `preserves full response when _meta already has source and
    requestId` — the middleware always constructs a new return object
    (no identity short-circuit exists), so
    `expect(result).toBe(fullResponse)` never held. Replaced with
    structural assertions on `result.success` / `result.data` /
    `result.meta.{source,requestId,operation,duration_ms,timestamp}`.

### Fixed — T310 conduit migration test drift (6 tests)

`packages/runtime/src/__tests__/lifecycle-e2e.test.ts` called
`ensureSignaldockDb(cwd)` at the project tier, which was removed in
T310 (v2026.4.12) when project-tier messaging moved to
`conduit.db`. Rewrote the E2E suite to use `ensureConduitDb()` +
`getConduitDbPath()` + `checkConduitDbHealth()`. Removed inserts into
the project-tier `agents` table (that table is global-only now per
T346) — tests now exercise the message flow directly (the
`messages`/`conversations`/`messages_fts` tables have no FK to
`agents`) plus `project_agent_refs` for the identity-reference case.
Added `closeConduitDb` to the `@cleocode/core/internal` barrel to
support proper between-test cleanup.

### Added — runEnvelopeConformance test suite

New `describe` block in `lafs-conformance.test.ts` exercises
`runEnvelopeConformance()` end-to-end against LAFS-native envelopes:
5 per-operation success cases, 1 error case (using
`E_NOT_FOUND_RESOURCE` — a code registered in
`packages/lafs/schemas/v1/error-registry.json`), 1 check-set assertion
that verifies the `core` tier includes the expected check names, 1
default-tier smoke test, and 1 negative test for a malformed envelope.

### Notes

- ES2025 target in `tsconfig.json` is **correct** as of TypeScript 6.0
  (shipped 2026-03-23) — ES2025 is the new default target
  (`ScriptTarget.LatestStandard`). Verified via
  [devblogs.microsoft.com TypeScript 7 progress post](https://devblogs.microsoft.com/typescript/progress-on-typescript-7-december-2025/).
  The `▲ [WARNING] Unrecognized target environment "ES2025"` line in
  the build output comes from esbuild, which had not yet added ES2025
  support at the time of this commit (tracked upstream at
  `evanw/esbuild#4432`). It is a harmless warning and does not affect
  emitted output.
- Biome `@biomejs/biome` is pinned at `^2.4.6`; installed 2.4.8, latest
  npm at time of writing is 2.4.10. No rule semantics have changed
  across the 2.4.6–2.4.10 range, so no upgrade is needed for this fix.
- One pre-existing flaky test observed under parallel runs in
  `packages/caamp/tests/unit/harness/pi.test.ts` (`creates the child
  session JSONL at the canonical subagents/ path`) — passes in
  isolation and in the most recent full runs. Not addressed in this
  commit; opportunistic flakiness triage is a separate task.

## [2026.4.13] — 2026-04-08

### T311 — Cross-Machine Backup Portability (15 tasks, 7 waves)

Adds portable `.cleobundle.tar.gz` export/import on top of the v2026.4.10
VACUUM INTO backup mechanism. Implements ADR-038. Enables cross-machine
CleoOS migration with intelligent A/B regenerate-and-compare for JSON
restore + conflict report for manual review.

**Wave 0 — Foundational modules**
- `t310-readiness.ts` (T342) — assertT310Ready gate for T311 commands;
  throws `T310MigrationRequiredError` with actionable message if a project
  is still on the pre-T310 topology
- `backup-manifest.ts` + `schemas/manifest-v1.json` (T343) — BackupManifest
  type + JSON Schema Draft 2020-12 (bundled inside .cleobundle for offline
  validation)
- `backup-crypto.ts` (T345) — AES-256-GCM + scrypt KDF (N=2^15, r=8, p=1)
  for `.enc.cleobundle.tar.gz` opt-in encryption. Uses Node built-in
  crypto only (no native bindings per ADR-010). Magic header CLEOENC1 +
  version byte + salt + nonce + ciphertext + auth tag.

**Wave 1 — Packer + Unpacker**
- `backup-pack.ts` (T347) — `packBundle({scope, projectRoot, outputPath,
  encrypt, passphrase, projectName})` writes a portable bundle with
  VACUUM INTO snapshots + SHA-256 checksums + manifest + optional
  encryption. tar.gz format via Node `tar` package (added as dependency).
- `backup-unpack.ts` (T350) — `unpackBundle({bundlePath, passphrase})`
  extracts + verifies 6 integrity layers (encryption auth, manifest schema,
  checksums, SQLite integrity, schema compat warnings). Returns a staging
  dir + manifest + warnings. Callers clean up via `cleanupStaging()`.

**Wave 2 — Dry-run regenerators**
- `regenerators.ts` (T352) — `regenerateConfigJson`, `regenerateProjectInfoJson`,
  `regenerateProjectContextJson` — pure functions returning what `cleo init`
  WOULD write fresh on the target machine. Powers the "A" side of A/B
  regenerate-and-compare.

**Wave 3 — A/B engine + conflict report**
- `restore-json-merge.ts` (T354) — `regenerateAndCompare` engine with
  4-way classification (identical, machine-local, user-intent,
  project-identity, auto-detect, unknown) and dot-path walking. Produces
  `JsonRestoreReport` with classifications and merged result.
- `restore-conflict-report.ts` (T357) — markdown formatter for the
  `.cleo/restore-conflicts.md` report. Handles resolved + manual-review
  sections, reauth warnings, schema warnings.

**Wave 4 — CLI verbs**
- `cleo backup export <name> [--scope project|global|all] [--encrypt]
  [--out <path>]` (T359) — writes a `.cleobundle.tar.gz`
- `cleo backup import <bundle> [--force]` (T361) — full import pipeline:
  pre-check for existing data (abort without --force), unpack + verify,
  atomic DB restore, A/B classification for JSON files, conflict report
  generation, raw imported files preserved under `.cleo/restore-imported/`
- `cleo backup inspect <bundle>` (T363) — stream-extract manifest.json
  only; no full unpack. Safe for agent-driven inspection.
- `cleo restore finalize` (T365) — parse `.cleo/restore-conflicts.md`,
  apply any manually-resolved fields to on-disk JSON files, archive the
  report.

**Wave 5 — Integration verification + documentation**
- `t311-integration.test.ts` (T367) — 14 end-to-end scenarios covering
  round-trip, encryption, tampering, schema compat, staging cleanup,
  and A/B merge correctness. All passing.
- TSDoc provenance + README backup portability section (T368)

### Statistics
- 15 implementation subtasks shipped
- 165 new tests across unit + integration (8 test files)
- 4 new CLI verbs
- 1 new archive format (.cleobundle.tar.gz + .enc.cleobundle.tar.gz)
- 1 new JSON Schema for portable manifests
- 0 new pre-existing failures introduced

### Migration notes
- T310 (v2026.4.12) is a hard dependency: a project still on pre-T310
  topology (legacy `.cleo/signaldock.db` without `conduit.db`) will fail
  `assertT310Ready` and get a clear error directing the user to run any
  `cleo` command first to trigger the T310 auto-migration.
- Encrypted backups require a passphrase; agents should set
  `CLEO_BACKUP_PASSPHRASE` env var; interactive users are prompted.
- After import, review `.cleo/restore-conflicts.md` for any manual-review
  fields and run `cleo restore finalize` to apply resolutions.

### Next
- Open: future waves may add merge mode for restore, redaction mode,
  cloud-based backup sync, differential/incremental bundles.

[Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>]

---

## [2026.4.12] - 2026-04-08

### Highlights

This release closes the T310 epic (Conduit + Signaldock Separation) across 6
waves. It establishes a hard split between the two formerly-conflated agent
databases: `conduit.db` is the new project-tier transport store (replacing
the old project-level `signaldock.db`), while `signaldock.db` is promoted to
a dedicated global-tier registry at `$XDG_DATA_HOME/cleo/signaldock.db`. The
KDF has been upgraded from `(machine-key, project-path)` to
`(machine-key, global-salt, agent-id)`, making agent keys portable across
project relocations. New `project_agent_refs` override table enables
per-project agent configuration without polluting the global registry. Full
automatic first-run migration with `.pre-t310.bak` preservation, new
attach/detach/remove-global CLI verbs, and a 12-scenario integration test
suite. **16 tasks shipped, zero pre-existing test failures introduced.**

### Added

- **`ADR-037` + `ADR-038` — Conduit/Signaldock split + KDF upgrade.** ADR-037
  documents the project-tier → conduit.db rename decision and the rationale
  for separating project transport from global agent registry. ADR-038
  specifies the new `(machine-key, global-salt, agent-id)` KDF that replaces
  the path-coupled `(machine-key, project-path)` scheme, enabling key
  portability across project relocations
  ([`4a180554`](https://github.com/kryptobaseddev/cleo/commit/4a180554)).

- **`ADR-039` — Wave 4 envelope unification.** Records the decision to
  unify request/response envelopes across transport layers
  ([`74bb8b12`](https://github.com/kryptobaseddev/cleo/commit/74bb8b12)).

- **T310 Wave 0 — schemas + primitive modules** (T344). New
  `conduit-core` crate and `signaldock-core` global-registry module
  established. Zod schemas and TypeScript contracts for conduit messages
  and global agent descriptors added to `packages/contracts/src/`
  ([`67f71260`](https://github.com/kryptobaseddev/cleo/commit/67f71260)).

- **`packages/core/src/store/project-agent-refs.ts` — per-project agent
  override table** (T353). New `project_agent_refs` SQLite table in
  `conduit.db` provides CRUD accessors (`upsertProjectAgentRef`,
  `getProjectAgentRef`, `listProjectAgentRefs`, `deleteProjectAgentRef`)
  for per-project agent configuration overrides without touching the global
  registry
  ([`55c5faf7`](https://github.com/kryptobaseddev/cleo/commit/55c5faf7)).

- **`packages/core/src/store/local-transport.ts` — LocalTransport migrated
  to conduit.db** (T356). LocalTransport now opens `conduit.db` instead of
  the project-scoped `signaldock.db`, completing the project-tier rename
  ([`3276cfe3`](https://github.com/kryptobaseddev/cleo/commit/3276cfe3)).

- **Cross-DB agent registry accessor refactor** (T355). `AgentRegistry`
  accessors split across conduit (project-tier) and global signaldock (global
  tier) with clean interface boundaries. No cross-DB leakage
  ([`69fb6df1`](https://github.com/kryptobaseddev/cleo/commit/69fb6df1)).

- **`packages/core/src/store/migrate-signaldock-to-conduit.ts` — migration
  executor** (T358). Idempotent `migrateSignaldockToConduit()` reads the old
  project-scoped `signaldock.db`, writes entries to `conduit.db`, and
  preserves the original as `signaldock.db.pre-t310.bak`. Detects already-
  migrated projects and is a no-op on fresh installs
  ([`13c861fb`](https://github.com/kryptobaseddev/cleo/commit/13c861fb)).

- **Auto-migration wired into CLI startup** (T360). `cleo` CLI startup now
  calls `migrateSignaldockToConduit()` before any command dispatch, ensuring
  all existing projects are migrated transparently on first run after upgrade
  ([`f38fc7e3`](https://github.com/kryptobaseddev/cleo/commit/f38fc7e3)).

- **`cleo agent list --global` + `--include-disabled`** (T362). New
  `--global` flag lists agents from the global signaldock registry rather than
  the project-tier conduit registry. `--include-disabled` surfaces disabled
  agent registrations for diagnostics
  ([`28b449d3`](https://github.com/kryptobaseddev/cleo/commit/28b449d3)).

- **`cleo agent attach` + `cleo agent detach`** (T364). Two new CLI verbs:
  `attach` creates a `project_agent_refs` override linking a global agent into
  the current project; `detach` removes the override. Both honour the
  three-tier scope hierarchy
  ([`f773fd57`](https://github.com/kryptobaseddev/cleo/commit/f773fd57)).

- **`cleo agent remove --global`** (T366). New `--global` flag on
  `cleo agent remove` deletes an agent from the global signaldock registry
  with a safety scan that warns if the agent is still attached to any project
  via `project_agent_refs`
  ([`dd5a70fb`](https://github.com/kryptobaseddev/cleo/commit/dd5a70fb)).

- **Backup registry extended for conduit + global signaldock + global-salt**
  (T369). `vacuumIntoBackupAll` now snapshots `conduit.db` and the global
  `signaldock.db` alongside the existing `tasks.db` / `brain.db` pair. The
  global-salt value is preserved in JSON backups
  ([`ef7f58f6`](https://github.com/kryptobaseddev/cleo/commit/ef7f58f6)).

- **12-scenario T310 integration test suite** (T371). New
  `packages/core/src/store/__tests__/conduit-signaldock-integration.test.ts`
  covers: fresh conduit init, project_agent_refs CRUD, migration idempotency,
  global registry isolation, attach/detach round-trip, KDF key portability
  across project rename, auto-migration on startup, backup/restore of both
  DBs, `--global` list accuracy, safety-scan on remove, concurrent access,
  and `.pre-t310.bak` preservation. 12/12 passing
  ([`7d531e82`](https://github.com/kryptobaseddev/cleo/commit/7d531e82)).

- **TSDoc provenance + docs drift resolution** (T372). All new exported
  symbols in `project-agent-refs.ts`, `migrate-signaldock-to-conduit.ts`, and
  the conduit accessor layer carry `/** ... */` TSDoc comments. Stale
  architecture diagrams updated to reflect conduit.db and global signaldock.db
  paths
  ([`d135a6aa`](https://github.com/kryptobaseddev/cleo/commit/d135a6aa)).

### Statistics

- **16 tasks shipped** across 6 waves (Wave 0: ADRs + schemas, Wave 1:
  primitive modules + project_agent_refs, Wave 2: LocalTransport + registry
  refactor, Wave 3: migration executor + auto-startup wire, Wave 4: CLI
  verbs + envelope unification, Wave 5: backup extension + integration tests +
  TSDoc)
- **16 commits** on main since v2026.4.11
- **~2400 LOC** across implementation + tests
- **12 new integration tests** in `conduit-signaldock-integration.test.ts`
- **3 new ADRs** (ADR-037, ADR-038, ADR-039)
- **0 pre-existing test failures** introduced

### Follow-on Epics

- **T311** — Cross-Machine Backup Export/Import (targets v2026.4.13+)

---

## [2026.4.11] - 2026-04-08

### Highlights

This release closes the T299 epic (Database Topology + Lifecycle) across 4
waves. It establishes the full CleoOS database topology (4 DBs × 2 tiers)
as a first-class architectural concern, anchored by ADR-036. Key deliveries:
walk-up `getProjectRoot()` that never auto-creates nested `.cleo/`,
idempotent legacy file cleanup wired into CLI startup, global-tier VACUUM
INTO backup for `nexus.db`, a runtime guard preventing stray `nexus.db`
files outside `getCleoHome()`, and a 9-scenario integration test suite
that validates the full topology contract. **9 tasks shipped in 8 commits,
42 new tests, ~2000 LOC. Zero pre-existing test failures introduced.**

### Added

- **`ADR-036` — `.cleo/adrs/ADR-036-cleoos-database-topology.md` (454
  lines).** Documents the 4-DB × 2-tier topology contract (project-tier:
  `tasks.db`, `nexus.db`; global-tier: `brain.db`, `nexus.db`), the
  walk-up scaffolding rule, `VACUUM INTO` backup mechanism with rotation
  policy, and forward references to T310 (Conduit + Signaldock separation)
  and T311 (cross-machine backup portability)
  ([`1f560327`](https://github.com/kryptobaseddev/cleo/commit/1f560327),
  +454 lines).

- **`packages/core/src/paths.ts` — walk-up `getProjectRoot()` rewrite**
  (T301). Walks ancestor directories looking for `.cleo/` or `.git/`,
  stops at first hit, never auto-creates nested `.cleo/`. `CLEO_ROOT`
  env variable overrides walk-up for CI / Docker. 13 new unit tests in
  `paths-walkup.test.ts` covering clean roots, nested dirs, symlinks,
  env override, and edge cases
  ([`30dde2ab`](https://github.com/kryptobaseddev/cleo/commit/30dde2ab),
  +105 LOC `paths.ts`, +305 LOC test).

- **`packages/core/src/paths.ts` — XDG comment fix** (T303). Top-of-file
  comment updated to list per-OS resolution examples for Linux
  (`~/.local/share/cleo`), macOS (`~/Library/Application Support/cleo`),
  and Windows (`%APPDATA%\cleo`) so engineers can orient without
  reading XDG spec
  ([`b1323b70`](https://github.com/kryptobaseddev/cleo/commit/b1323b70)).

- **`packages/core/src/store/cleanup-legacy.ts` — idempotent legacy
  global file cleanup** (T304). New `detectAndRemoveLegacyGlobalFiles()`
  detects and removes `workspace.db` and `*-pre-cleo.db.bak` files left
  over from pre-CLEO global paths. Wired into CLI startup via
  `packages/cleo/src/cli/index.ts`. 11 unit tests covering detection,
  removal, idempotency, and no-op when files are absent
  ([`bc0cfe50`](https://github.com/kryptobaseddev/cleo/commit/bc0cfe50),
  +208 LOC `cleanup-legacy.ts`, +268 LOC test).

- **Nested `.cleo/` untrack** (T302). Removed 20 files across 6 nested
  `.cleo/` dirs (`packages/cleo`, `packages/contracts`, `packages/lafs`,
  `packages/runtime`, `packages/skills`, `packages/skills/skills/ct-skill-creator`).
  Pre-untrack snapshots written to `.cleo/backups/legacy-nested/`.
  All 7 `.db` files passed `PRAGMA integrity_check` before removal.
  Root `.gitignore` extended with `packages/**/.cleo/` rule
  ([`49f602e4`](https://github.com/kryptobaseddev/cleo/commit/49f602e4)).

- **`packages/core/src/store/sqlite-backup.ts` — global-tier backup
  mechanism** (T306). New `vacuumIntoGlobalBackup()` writes `nexus.db`
  snapshots to `$XDG_DATA_HOME/cleo/backups/sqlite/`. New CLI flags:
  `cleo backup add --global`, `cleo backup list --scope project|global|all`,
  `cleo restore backup --scope global`. 9 new tests in
  `sqlite-backup-global.test.ts`
  ([`e09a4a2d`](https://github.com/kryptobaseddev/cleo/commit/e09a4a2d),
  +172 LOC `sqlite-backup.ts`, +281 LOC test).

- **`packages/core/src/store/nexus-sqlite.ts` — stray `nexus.db` cleanup
  + guard** (T307). `getNexusDbPath()` runtime guard fails fast if
  resolved path is not under `getCleoHome()`. New
  `detectAndRemoveStrayProjectNexus()` for one-time cleanup of
  incorrectly-placed `nexus.db` files. 9 new tests covering guard
  assertion, stray detection, and no-op cases
  ([`545d7537`](https://github.com/kryptobaseddev/cleo/commit/545d7537),
  +35 LOC `nexus-sqlite.ts`).

- **9-scenario database topology integration test suite** (T308). New
  `packages/core/src/store/__tests__/database-topology-integration.test.ts`
  (504 lines) covers: fresh init, walk-up discovery, anti-drift
  (project-tier never bleeds into global-tier), backup/restore round-trip,
  cleanup idempotency, no-auto-create enforcement, stray nexus guard,
  `CLEO_ROOT` override, and concurrent access. 9/9 passing in ~527ms
  ([`9d8ab9e4`](https://github.com/kryptobaseddev/cleo/commit/9d8ab9e4),
  +504 LOC test).

### Statistics

- **9 tasks shipped** across 4 waves (Wave 0: ADR, Wave 1: scaffolding +
  cleanup, Wave 2: backup + guards, Wave 3: integration verification)
- **8 commits** on main since v2026.4.10
- **~2000 LOC** across implementation + tests (2480 insertions total,
  154 deletions, 38 files changed)
- **42 new tests** across `paths-walkup.test.ts` (13),
  `cleanup-legacy.test.ts` (11), `sqlite-backup-global.test.ts` (9),
  `database-topology-integration.test.ts` (9)
- **1 new ADR** (ADR-036)
- **0 pre-existing test failures** introduced

### Follow-on Epics

- **T310** — Conduit + Signaldock Separation (RCASD-IVTR, targets v2026.4.12+)
- **T311** — Cross-Machine Backup Export/Import (RCASD-IVTR, targets v2026.4.13+)

---

## [2026.4.10] - 2026-04-07

### Highlights

This is a housekeeping and hardening release covering three independent
workstreams that landed after the v2026.4.9 hotfix: (1) deterministic
`events.rs` generation that eliminates rustfmt drift on every `cargo build`,
(2) untracking the four `.cleo/` runtime files from git with a full
`VACUUM INTO` backup mechanism replacing the data-loss-prone git checkpoint
pattern (ADR-013 §9 resolution, closes T5158), and (3) regenerating
`packages/caamp/docs/API-REFERENCE.md` from source via `forge-ts` to
eliminate 3470 lines of drifted hand-maintained prose. Plus a small
fix to unblock the `@cleocode/runtime` tsup DTS build under the
TypeScript 6.x peer that landed transitively with `@forge-ts/cli`.
**No user-facing feature changes. Zero regressions across 6375+ tests.**

### Added

- **`crates/cant-core/build.rs` — `write_if_changed` helper + rustfmt
  pipeline.** The build script now pipes generated Rust source through
  `rustfmt --edition 2024 --emit stdout` via stdin before writing, and
  the `write_if_changed` helper skips writes when on-disk content is
  byte-identical (preserves mtimes, avoids spurious downstream rebuilds).
  Adds `cargo:rerun-if-changed=build.rs` so touching the generator forces
  a regen, and a graceful `cargo:warning=...` fallback to unformatted
  output if `rustfmt` is missing from PATH so the build never hard-fails.
  Generated file header now embeds the drift-check one-liner:
  `cargo build -p cant-core && git diff --exit-code crates/cant-core/src/generated/events.rs`
  ([`d242effb`](https://github.com/kryptobaseddev/cleo/commit/d242effb),
  +120 LOC `build.rs`).

- **`packages/core/src/store/sqlite-backup.ts` — prefix-based backup API
  for multi-DB snapshots.** New exports `vacuumIntoBackupAll`,
  `listBrainBackups`, and `listSqliteBackupsAll` extend the existing
  `tasks.db` snapshot tooling to also handle `brain.db` via SQLite
  `VACUUM INTO`. Both databases share the same rotation policy and
  integrity-check verification path. The new helpers accept a
  `{ force?: boolean }` option that bypasses the rotation min-interval,
  used by the auto-snapshot session-end hook. Backed by 128 LOC of new
  test coverage in `sqlite-backup.test.ts`
  ([`233017f7`](https://github.com/kryptobaseddev/cleo/commit/233017f7),
  +239 LOC `sqlite-backup.ts`).

- **`backup-session-end` hook (priority 10).** New hook handler in
  [`packages/core/src/hooks/handlers/session-hooks.ts`](packages/core/src/hooks/handlers/session-hooks.ts)
  that calls `vacuumIntoBackupAll({ force: true })` after every `cleo
  session end`. Runs at priority 10 — after the existing
  `brain-session-end` handler at priority 100 — so the snapshot includes
  the just-written `SessionEnd` observation row. Failures are non-fatal
  and surfaced as warnings only (the session-end command still succeeds).
  Auto-captures `tasks.db` and `brain.db` to `.cleo/backups/` with
  rotating retention
  ([`545fec86`](https://github.com/kryptobaseddev/cleo/commit/545fec86),
  +42 LOC).

- **TSDoc coverage on 46 previously-undocumented exports.** Hand-written
  TSDoc blocks added to: 26 `PiHarness` method summaries (replacing the
  cascading `{@inheritDoc Harness.*}` references with explicit prose),
  18 `@example` blocks on the `mcp/*` and `pi/*` command helpers, and
  10 `@remarks` blocks on the command-registration functions in
  `commands/{mcp,pi}/common.ts`. W006 syntax fixes applied throughout.
  Drove caamp TSDoc coverage from **54 errors + 679 warnings** down to
  **0 errors + 46 warnings** (the remaining warnings are W013
  false-positives on TypeScript optional parameters and are not
  blockers)
  ([`80138557`](https://github.com/kryptobaseddev/cleo/commit/80138557)).

- **`packages/caamp/forge-ts.config.ts` — full enforcement config (21 →
  65 LOC).** Rewritten with explicit `enforce` rules, a `gen` section
  pointing at `docs/generated/`, and a narrative header explaining the
  build gate. New `pnpm --filter @cleocode/caamp run docs` script (full
  check + generate) and `docs:check` script (coverage gate only, no
  filesystem writes). Adds `@forge-ts/cli@0.23.0` as a pinned devDep —
  no global dependency required
  ([`67df4208`](https://github.com/kryptobaseddev/cleo/commit/67df4208)).

- **`packages/caamp/docs/generated/` — full forge-ts API reference
  output.** Every public export, regenerated from TSDoc on every doc
  build:
  - `api-reference.md` — 16710 lines, every public export from TSDoc.
  - `llms.txt` (48 KB) + `llms-full.txt` (325 KB) — agent digests
    consumed by `@cleocode/cleo`.
  - `SKILL-caamp/` — full skill-package scaffolding with
    `references/API-REFERENCE.md` (8428 lines) and `references/CONFIGURATION.md`.
  - `concepts.mdx`, `guides/{configuration,error-handling,getting-started}.mdx`,
    `packages/api/{functions,types,examples,index}.mdx` — full reference
    docs and how-to guides
    ([`e33059c6`](https://github.com/kryptobaseddev/cleo/commit/e33059c6),
    [`e4df49a3`](https://github.com/kryptobaseddev/cleo/commit/e4df49a3)).

- **`AGENTS.md` — "Runtime Data Safety (ADR-013 §9)" section.** Root
  AGENTS.md now documents the backup/restore workflow, the four
  untracked files, and why the legacy git-checkpoint pattern was
  retired. Cross-machine sync is no longer supported via git — use
  `cleo observe` + `cleo memory find` for memory portability or the
  `cleo backup` family for full DB transfer
  ([`1c407eb1`](https://github.com/kryptobaseddev/cleo/commit/1c407eb1),
  +25 LOC).

- **`packages/caamp/AGENTS.md` — "Documentation (forge-ts — Generated
  from Source)" section.** New rules and a four-step "adding a new
  export" workflow that requires every new export to ship with a
  complete TSDoc block + `pnpm run docs:check` + `pnpm run docs`
  before commit. Marks `docs/generated/*` as never-edit-by-hand
  ([`67df4208`](https://github.com/kryptobaseddev/cleo/commit/67df4208),
  +56 LOC).

### Changed

- **`packages/core/src/system/backup.ts` — switched from
  `readFileSync`/`writeFileSync` to `VACUUM INTO` for all SQLite
  files.** The previous implementation used unsafe synchronous binary
  copies to back up `tasks.db` and `brain.db`. This had been silently
  wrong since v2026.4.6 — copying a live SQLite file with a hot WAL
  sidecar can produce a torn snapshot or include uncommitted writes,
  which is exactly the failure mode ADR-013 §1-§4 was written to
  prevent. The new implementation routes through
  `getNativeDb()`/`getBrainNativeDb()` and issues a proper
  `VACUUM INTO <tmp>` followed by an atomic `rename`, matching the
  ADR-013 §6 contract. JSON files (`config.json`, `project-info.json`)
  use atomic tmp-then-rename. The function is now `async`, and all
  callers in `dispatch/domains/admin.ts`, `system-engine.ts`, and the
  three test suites have been updated
  ([`233017f7`](https://github.com/kryptobaseddev/cleo/commit/233017f7),
  +212 LOC `backup.ts`).

- **`packages/core/src/store/sqlite.ts` — runtime warning rewritten.**
  The warning that fires when a tracked SQLite file is detected on
  disk no longer instructs users to run `git rm --cached`. It now
  points at the new `cleo backup add` workflow and references the
  ADR-013 §9 resolution. The warning is silenced once the file is
  untracked
  ([`233017f7`](https://github.com/kryptobaseddev/cleo/commit/233017f7),
  +22 LOC).

- **`packages/caamp/docs/API-REFERENCE.md` — replaced 3470 lines of
  drifted hand-prose with a 69-line pointer file.** The previous
  hand-maintained API reference contained 61 references to MCP APIs
  that had been deleted in the April 3 commit
  [`480fa01a`](https://github.com/kryptobaseddev/cleo/commit/480fa01a),
  plus stale type signatures, removed exports, and ad-hoc examples.
  The replacement is a short redirect that points at
  `docs/generated/api-reference.md` and documents the regeneration
  workflow. **The doc itself is now a pointer; the canonical source
  is `docs/generated/`, regenerated from TSDoc on every `pnpm run docs`**
  ([`e33059c6`](https://github.com/kryptobaseddev/cleo/commit/e33059c6),
  3470 → 69 LOC).

- **`PiHarness` TSDoc — replaced `@inheritDoc` cascades with explicit
  prose.** 26 method summaries that previously delegated documentation
  to the `Harness` base class via `{@inheritDoc Harness.*}` now have
  explicit summaries written for the Pi-specific behaviour. This was
  required by forge-ts because the `@inheritDoc` resolver does not
  cross package boundaries. The result is that every PiHarness method
  has its own readable doc block in the generated API reference
  ([`80138557`](https://github.com/kryptobaseddev/cleo/commit/80138557),
  `packages/caamp/src/core/harness/pi.ts` +132 LOC).

- **`.gitignore` (root + nested `.cleo/.gitignore` + template +
  scaffold fallback) — runtime DB exclusion hardened.** The previous
  rules included `!config.json` / `!project-info.json` re-include
  exceptions inside `.cleo/.gitignore`, which was the T5158 vector:
  nested gitignore re-includes silently overrode the parent allow-list
  rules and re-tracked the runtime DBs on every fresh checkout. Both
  re-include rules removed. Explicit deny lines added for the four
  paths plus their `*.db-shm` / `*.db-wal` sidecars. The same change
  applied to `packages/core/templates/cleo-gitignore` (used by
  `cleo init`) and the scaffold fallback in
  [`packages/core/src/scaffold.ts`](packages/core/src/scaffold.ts) so
  new projects never re-introduce the bug
  ([`233017f7`](https://github.com/kryptobaseddev/cleo/commit/233017f7),
  [`59f1ea3b`](https://github.com/kryptobaseddev/cleo/commit/59f1ea3b)).

### Fixed

- **`packages/runtime/tsconfig.json` — added `ignoreDeprecations: "6.0"`
  to unblock tsup DTS build under TypeScript 6.x.** The
  [`67df4208`](https://github.com/kryptobaseddev/cleo/commit/67df4208)
  forge-ts addition transitively pulled in TypeScript 6.0.2 as a peer
  of `tsup@8.5.1`, which made tsup's DTS-generation step fail with
  `TS5101: Option 'baseUrl' is deprecated and will stop functioning in
  TypeScript 7.0`. tsup unconditionally injects `baseUrl: "."` into the
  compiler options it forwards to TypeScript, even when the user
  tsconfig has none — and TypeScript 6.x errors on bare `baseUrl`
  unless `ignoreDeprecations: "6.0"` is set. caamp's tsup build is
  unaffected because its `module: "nodenext"` / `moduleResolution:
  "nodenext"` settings take a different code path; runtime uses the
  legacy `bundler` resolver and was the only failing package. The
  one-line addition unblocks the release without changing module
  resolution semantics. **Verified by full `pnpm run build` cold
  rebuild succeeding end-to-end.**

- **`crates/cant-core/src/generated/events.rs` rustfmt drift —
  eliminated.** The build.rs generator hand-concatenated Rust source
  via `String::push_str` / `format!` and wrote directly to disk without
  ever running `rustfmt`. The committed copy had been rustfmt-ed once
  manually, so every subsequent `cargo build` produced drift: a blank
  line after `pub enum CanonicalEvent {`, long match arms emitted on
  one line instead of being wrapped, and unwrapped method chains.
  Release agents were forced to `git checkout
  crates/cant-core/src/generated/events.rs` on every build. **Verified
  idempotent over three sequential forced rebuilds** (including
  `touch crates/cant-core/build.rs` reruns) — `git status --short
  crates/cant-core/` is empty after each rebuild. 509 `cant-core` unit
  tests + 4 doctests pass; `cargo fmt --check -p cant-core` clean;
  full `cargo build` workspace-wide clean
  ([`d242effb`](https://github.com/kryptobaseddev/cleo/commit/d242effb),
  [`b966fe4e`](https://github.com/kryptobaseddev/cleo/commit/b966fe4e)).

- **`.cleo/` runtime DB git tracking — closed via T5158 / ADR-013 §9.**
  The four files `.cleo/tasks.db`, `.cleo/brain.db`, `.cleo/config.json`,
  and `.cleo/project-info.json` were tracked in the project git
  repository. Per ADR-013 and T5158, this caused intermittent SQLite
  WAL corruption on branch switches: git overwrote the live `.db` file
  while a `*-wal` / `*-shm` sidecar was still in use, leaving the
  database in an inconsistent state on the next open. A runtime
  warning fired on every `cleo` command. **Resolution**:
  1. **Safety snapshots captured first** via the new
     `vacuumIntoBackupAll` helper plus atomic file copies for the
     JSON files. All four passed `PRAGMA integrity_check`:
     - `.cleo/backups/safety/tasks.db.pre-untrack-2026-04-07T23-13-56-164Z` (4.83 MB)
     - `.cleo/backups/safety/brain.db.pre-untrack-2026-04-07T23-13-56-164Z` (586 KB)
     - `.cleo/backups/safety/config.json.pre-untrack-2026-04-07T23-13-56-164Z` (404 B)
     - `.cleo/backups/safety/project-info.json.pre-untrack-2026-04-07T23-13-56-164Z` (613 B)
  2. **`git rm --cached`** the four files (preserving the on-disk
     copies for the live working tree).
  3. **`.gitignore` hardened** at four locations (root, nested,
     template, scaffold fallback) so re-tracking is impossible.
  4. **Runtime warning** updated to point at the new backup workflow.
  Local files preserved on disk after untrack: `tasks.db` 6.6 MB,
  `brain.db` 598 KB, `config.json` 404 B, `project-info.json` 613 B.
  No data loss
  ([`233017f7`](https://github.com/kryptobaseddev/cleo/commit/233017f7),
  [`59f1ea3b`](https://github.com/kryptobaseddev/cleo/commit/59f1ea3b),
  [`1c407eb1`](https://github.com/kryptobaseddev/cleo/commit/1c407eb1)).

- **`packages/core/src/system/backup.ts` ADR-013 violation — fixed
  retroactively.** The `BackupManager` had been using
  `fs.readFileSync` / `fs.writeFileSync` on `*.db` files since
  v2026.4.6 — a silent ADR-013 violation that produced potentially
  torn snapshots. Replaced with `VACUUM INTO` via the new
  `getNativeDb` / `getBrainNativeDb` helpers exported from
  [`packages/core/src/internal.ts`](packages/core/src/internal.ts).
  237 LOC of new test coverage in
  [`packages/core/src/system/__tests__/backup.test.ts`](packages/core/src/system/__tests__/backup.test.ts)
  ([`233017f7`](https://github.com/kryptobaseddev/cleo/commit/233017f7)).

### Removed

- **`!config.json` / `!project-info.json` re-include rules in
  `.cleo/.gitignore`** — these were the T5158 vector. Removed from
  all four gitignore locations (root, nested, template, scaffold
  fallback). See "Changed" above.

### Architecture decisions

- **ADR-013 §9 — Runtime DB Untrack — closed.** New section appended
  to
  [`.cleo/adrs/ADR-013-data-integrity-checkpoint-architecture.md`](.cleo/adrs/ADR-013-data-integrity-checkpoint-architecture.md)
  documenting the resolution: `.cleo/` runtime databases are no
  longer tracked in git. Per-file recovery table maps each of the
  four files to its safety snapshot location and restore command.
  Cross-machine sync via git is no longer supported — use `cleo
  observe` + `cleo memory find` for memory portability or `cleo
  backup add` + `cleo restore backup` for full DB transfer. Backup
  workflow documented in root `AGENTS.md` "Runtime Data Safety"
  section
  ([`1c407eb1`](https://github.com/kryptobaseddev/cleo/commit/1c407eb1),
  +70 LOC ADR / +25 LOC AGENTS.md).

- **`docs/API-REFERENCE.md` is no longer hand-maintained in caamp.**
  Establishes the precedent that API reference documentation is
  generated from TSDoc on every `pnpm run docs` and committed
  alongside source changes. The hand-maintained pointer file is the
  only document allowed at the canonical path; the actual API
  surface lives in `docs/generated/api-reference.md`. Build gate:
  `forge-ts check` must pass before any release. This pattern is
  expected to roll out to other packages in subsequent releases.

### Stats

- **10 commits** since v2026.4.9 (`ecb42e05`):
  - 2 events.rs gen (`d242effb`, `b966fe4e`)
  - 4 db-tracking (`233017f7`, `545fec86`, `59f1ea3b`, `1c407eb1`)
  - 4 forge-ts (`80138557`, `67df4208`, `e33059c6`, `e4df49a3`)
- **caamp tests**: 1501 passing (unchanged from v2026.4.9 — workstreams
  targeted non-caamp areas)
- **cant-core tests**: 509 unit tests + 4 doctests passing
- **Full monorepo**: 6375+ tests passing, 0 failures, 0 regressions
- **events.rs drift**: eliminated. `cargo build -p cant-core && git
  status --short crates/cant-core/` is empty. Verified idempotent
  over 3 sequential forced rebuilds.
- **TSDoc coverage in caamp**: **0 errors** (down from 54), 46
  warnings (W013 false-positives on optional params, not blockers)
- **Net LOC delta**: significant additions in `forge-ts` generated
  docs (~50k LOC across `docs/generated/`) + `cant-core/build.rs` +
  `sqlite-backup.ts` + new tests. The `docs/API-REFERENCE.md`
  pointer file replaces 3470 hand-maintained lines with 69.

### Closes

- **T5158** — `.cleo/` runtime DB untrack
- **ADR-013 §9** — runtime DB tracking resolution
- `packages/caamp/docs/API-REFERENCE.md` drift (3470 hand-maintained
  lines including 61 stale MCP references)
- `crates/cant-core/src/generated/events.rs` rustfmt drift (every
  `cargo build` produced uncommitted changes)

## [2026.4.9] - 2026-04-07

### Fixed

- **`build.mjs` build order — caamp now builds AFTER cant** ([`build.mjs`](build.mjs)).
  v2026.4.8's release workflow run [`24108196937`](https://github.com/kryptobaseddev/cleo/actions/runs/24108196937)
  failed at the Build step with `TS2307: Cannot find module '@cleocode/cant'`
  because caamp's tsup DTS step couldn't resolve `@cleocode/cant` types — caamp had
  grown a `validateDocument`/`parseDocument` import in `pi.ts:41` (T276 / `caamp pi
  cant *` verbs) but `build.mjs` still built caamp before cant, so the cant `.d.ts`
  files weren't on disk yet when caamp's DTS resolver ran. Local builds masked the
  bug because `dist/` and `tsbuildinfo` files persisted between invocations.
  Reordered the build chain to strict topological order: lafs → contracts → cant
  → caamp → core → runtime → adapters → cleo. **Verified by cold rebuild**:
  `rm -rf packages/*/dist packages/*/tsconfig.tsbuildinfo && node build.mjs`
  succeeds end-to-end. v2026.4.8 source code (T276 + T277 + T278) is unchanged
  — only the build pipeline that ships it is fixed.

- **Root `package.json` version drift — root is now the source of truth**
  ([`package.json`](package.json)). The root `package.json` had been stuck at
  2026.4.5 since v2026.4.5 because the release workflow's `Sync package versions
  from tag` step only walked `packages/*/package.json`, never the root. The root
  is now bumped to match every release, and the release workflow has been updated
  ([`.github/workflows/release.yml`](.github/workflows/release.yml)) to sync the
  root in the same step it syncs the workspace packages. The git tag remains the
  canonical source of truth for the version; the root and every workspace
  `package.json` are derived from the tag at release time and cannot drift again.

- **CI cold-build gate — defensive cleanup before `node build.mjs`**
  ([`.github/workflows/ci.yml`](.github/workflows/ci.yml)). The Build & Verify
  job now `rm -rf packages/*/dist packages/*/tsconfig.tsbuildinfo` immediately
  before running `node build.mjs`. CI checkouts are already fresh, so this is
  belt-and-braces — but it guarantees the build runs from zero state regardless
  of any future caching changes to `actions/checkout` or `actions/cache`. If
  someone reorders `build.mjs` incorrectly again, this step fails and blocks the
  merge instead of failing only at release time. The step has a self-documenting
  name and a 16-line inline comment that records the v2026.4.8 incident as the
  reason it exists.

- **T261 acceptance criterion #2 corrected** to record the ADR-035 §D4 Option Y
  decision. The original AC read "v2: Full MCP-as-Pi-extension bridge with real
  JSON-RPC client (not scaffold)" — which was inverted by the architecture decision
  ratified in v2026.4.7 (MCP is legacy interop only, not a first-class CleoOS
  primitive; T268-T272 archived; `installMcpAsExtension` removed from PiHarness).
  AC now reads: "v2: MCP-as-Pi-extension bridge REJECTED per ADR-035 §D4 Option Y
  — MCP is legacy interop only…". AC #5 also rewritten to match the actual T278
  deliverable (`caamp.exclusivityMode` setting) instead of the original generic
  phrasing.

### Added

- **`packages/cant/README.md`** — first README for `@cleocode/cant`. Documents
  the public API (`parseDocument`, `validateDocument`, `executePipeline`,
  `migrateMarkdown`, `parseCANTMessage`), the napi-rs architecture, the two
  CANT execution paths (cant-bridge.ts vs deterministic pipelines), and the
  ADR-035 §D5 single-engine boundary. Closes a gap where a published-to-npm
  package shipped without any README on the registry page.

- **`packages/runtime/README.md`** — first README for `@cleocode/runtime`.
  Documents `createRuntime`, the four resident services (`AgentPoller`,
  `HeartbeatService`, `KeyRotationService`, `SseConnectionService`), the
  transport-agnostic architecture, and the runtime-vs-Pi boundary set by
  ADR-035 §D5. Closes a gap where a published-to-npm package shipped without
  any README on the registry page.

### Background — why v2026.4.9 exists at all

v2026.4.8 was tagged and pushed but its release workflow failed at the Build
step (above). The published packages on npm were stuck at v2026.4.7 even
though the v2026.4.8 git tag exists. Rather than force-move the v2026.4.8 tag
(destructive on an already-pushed tag), v2026.4.9 takes the v2026.4.8 source
code unchanged and adds the four fixes above. The result is that all of
v2026.4.8's intended deliverables (T276 `caamp pi cant *` verbs, T277
`PiHarness.spawnSubagent` v2, T278 `caamp.exclusivityMode` setting) ship in
v2026.4.9 alongside the build/CI/version/AC/README fixes.

## [2026.4.8] - 2026-04-07

### Highlights

This release **closes the T261 epic** by completing the three remaining Pi v2+v3 workstreams that v2026.4.7 left for follow-up: T276 ships the missing `caamp pi cant install/remove/list/validate` verb subgroup, T277 upgrades `PiHarness.spawnSubagent` from the v1 minimal shape to the canonical ADR-035 D6 contract (line-buffered streaming, session attribution, idempotent SIGTERM/SIGKILL cleanup, concurrency helpers), and T278 adds the explicit `caamp.exclusivityMode` setting (ADR-035 D7) to govern Pi-vs-legacy runtime dispatch. All thirteen non-deleted T261 children are now done. Net change: +4083 LOC added across 14 files (5 new, 9 modified), zero LOC removed, +73 caamp tests (1428 → 1501), zero regressions.

### Added

#### CAAMP Wave 2 — `caamp pi cant *` verb subgroup (T276, ADR-035 D1)

Completes the Pi verb surface that v2026.4.7 left out. `caamp pi cant` manages `.cant` profile files across the three-tier scope (project > user > global). Thin wrapper around the `@cleocode/cant` napi parser/validator — installed profiles are consumed at runtime by the `cant-bridge.ts` Pi extension via `/cant:load <file>`.

- **4 new `caamp pi cant <verb>` commands** ([`packages/caamp/src/commands/pi/cant.ts`](packages/caamp/src/commands/pi/cant.ts), +482 LOC):
  - `caamp pi cant install <file>` — validates the profile via `validateCantProfile` first and rejects invalid files with the cant-core 42-rule error IDs plus line/col coordinates. On success, copies into the resolved tier's `.cant/` directory. Conflict-on-write with `--force`.
  - `caamp pi cant remove <name>` — three-tier scope-aware removal, idempotent.
  - `caamp pi cant list` — lists installed profiles across all three tiers with shadow flagging when the same profile name exists at multiple tiers.
  - `caamp pi cant validate <file>` — runs the validator without installing; returns a structured diagnostics envelope with severity-tagged findings.
- **4 new `PiHarness` methods** ([`packages/caamp/src/core/harness/pi.ts`](packages/caamp/src/core/harness/pi.ts)): `installCantProfile`, `removeCantProfile`, `listCantProfiles`, `validateCantProfile`. All honour `requirePiHarness()` Pi-absent guard returning `E_NOT_FOUND_RESOURCE`.
- **2 new module-level helpers** in `pi.ts`: `extractCantCounts` (totals statements, hooks, agents from a parsed profile), `normaliseSeverity` (clamps cant-core diagnostic severities to a stable enum).
- **4 new exported types** in [`packages/caamp/src/core/harness/types.ts`](packages/caamp/src/core/harness/types.ts): `CantProfileCounts`, `CantProfileEntry`, `CantValidationDiagnostic`, `ValidateCantProfileResult`.
- **New caamp dep** — `@cleocode/cant: workspace:*` (pulls `cant-napi` transitively).
- **40 new tests** across 2 files: `tests/unit/harness/pi.test.ts` (+24 unit tests on the new harness methods, against real seed-agent fixtures), `tests/unit/commands/pi/cant-commands.test.ts` (+16 integration tests driving each verb through Commander `parseAsync`, +536 LOC). Covers happy paths, validator-rejection on install, three-tier shadow detection, missing-file branches, and Pi-absent fallback per ADR-035 D1.

#### `PiHarness.spawnSubagent` v2 — canonical spawn path (T277, ADR-035 D6)

Full upgrade from the v1 minimal shape (basic spawn + result promise) to the ADR-035 D6 contract. `spawnSubagent` is now the **single canonical subagent spawn path** for the entire CleoOS runtime, with line-buffered streaming, session attribution, exit propagation, idempotent cleanup, and concurrency helpers. Maps directly to CANT `parallel: race` / `parallel: settle` semantics.

- **Line-buffered stdout streaming** ([`packages/caamp/src/core/harness/pi.ts`](packages/caamp/src/core/harness/pi.ts)) — `onStream` callback receives `{ kind: 'message', subagentId, lineNumber, payload }` for each parsed JSON line. Partial lines buffered until newline arrives; malformed JSON surfaces as a `{ kind: 'parse_error' }` event without crashing the consumer.
- **Stderr buffering** — line-buffered, emitted as `{ kind: 'stderr', payload: { line } }` via `onStream`, **and** pushed into a 100-line ring buffer exposed via `SubagentHandle.recentStderr()`. Per ADR-035 D6: stderr is for operator diagnostics only and is **never routed to parent LLM context**.
- **Exit propagation** — new `exitPromise` resolves **once** on child `'close'` with `{ code, signal, childSessionPath, durationMs }`. **Never rejects** — failure is encoded by non-zero `code`, non-null `signal`, or partial output in the session file. Legacy `result` promise preserved for back-compat with v1 consumers.
- **Idempotent cleanup** — new `terminate(reason?)` is idempotent across multiple calls. Sends `SIGTERM`, polls every `min(25ms, graceMs)`, then escalates to `SIGKILL` after grace expires. Grace resolves from per-call `opts.terminateGraceMs` → `settings.json:pi.subagent.terminateGraceMs` → `DEFAULT_TERMINATE_GRACE_MS=5000`. Writes `{type:'subagent_exit', reason:'terminated'}` to the child session file before exit so postmortems can distinguish caller-terminated from naturally-completed runs.
- **Session attribution** — child session JSONL written to `~/.pi/agent/sessions/subagents/subagent-{parentSessionId}-{taskId}.jsonl`. Header `{type:'header', subagentId, taskId, parentSessionId, startedAt}` written at spawn time. When `task.parentSessionPath` is supplied, a `{type:'custom', subtype:'subagent_link', subagentId, taskId, childSessionPath, startedAt}` line is appended to the parent session file so the parent transcript hyperlinks to the child.
- **Concurrency helpers** — static `PiHarness.raceSubagents(handles[])` (Promise.race over `exitPromise[]`, terminates losers via the idempotent `terminate()` path) and static `PiHarness.settleAllSubagents(handles[])` (Promise.allSettled wrapper). These map 1:1 to CANT `parallel: race` and `parallel: settle` mode tokens.
- **Orphan handling** — module-level `Set<ActiveSubagent>` plus an idempotent `process.on('exit', ...)` handler that SIGTERMs every outstanding subagent on parent process exit. Prevents zombies on `Ctrl+C` and crashed parents.
- **New types in [`packages/caamp/src/core/harness/types.ts`](packages/caamp/src/core/harness/types.ts)** (+550 LOC across the file): `SubagentTask` (updated with `parentSessionPath`, `taskId` fields), `SubagentSpawnOptions` (`onStream`, `terminateGraceMs`, `signal`), `SubagentStreamEvent` (`message` | `stderr` | `parse_error`), `SubagentExitResult` (`code`, `signal`, `childSessionPath`, `durationMs`), `SubagentHandle` (updated with `exitPromise`, `terminate()`, `recentStderr()`), `SubagentLinkEntry`.
- **16 new tests** in `tests/unit/harness/pi.test.ts` covering: stdout streaming with `onStream` callback ordering, stderr buffering and ring-buffer cap at 100 lines, session-file header + parent link write, exit propagation on natural close, exit propagation on caller-terminate, idempotent `terminate()` re-entry, SIGTERM grace then SIGKILL escalation, concurrency `raceSubagents` (winner + loser termination), `settleAllSubagents` ordering preservation, orphan-handler cleanup on parent exit.
- **Legacy v1 API preserved** — the existing `result` promise and `abort()` method on `SubagentHandle` are still emitted unchanged. Existing v1 consumers (Conductor Loop, dispatch handlers) work without modification; v2 features are strictly additive.

#### `caamp.exclusivityMode` setting — v3 exclusivity layer (T278, ADR-035 D7)

70% of the v3 exclusivity layer was already shipped in v2026.4.5 (Pi registered with `priority: "primary"`, `resolveDefaultTargetProviders()` prefers Pi when installed). T278 adds the remaining 30% — an explicit mode setting that controls runtime dispatch behaviour and surfaces deprecation warnings.

- **New `ExclusivityMode` type** ([`packages/caamp/src/core/config/caamp-config.ts`](packages/caamp/src/core/config/caamp-config.ts), new file +300 LOC): `'auto' | 'force-pi' | 'legacy'`, default `'auto'`. Dedicated config module with one-time warning latches, accessor/mutator API (`getExclusivityMode`, `setExclusivityMode`, `resetExclusivityModeOverride`, `isExclusivityMode`), and a reset helper for tests.
- **New `PiRequiredError` class** with literal `code: 'E_NOT_FOUND_RESOURCE' as const` so `runLafsCommand` propagates it without rewriting to `E_INTERNAL_UNEXPECTED`.
- **`resolveDefaultTargetProviders()` honours the mode** ([`packages/caamp/src/core/harness/index.ts`](packages/caamp/src/core/harness/index.ts), +168 LOC):
  - `auto` + Pi installed → returns `[piProvider]` (v2026.4.7 behaviour, **bit-identical**, no warning).
  - `auto` + Pi absent → legacy fallback list, one-time boot warning.
  - `auto` + explicit non-Pi providers passed while Pi installed → returns the explicit list with a one-time deprecation warning.
  - `force-pi` + Pi installed → returns `[piProvider]` (no warning).
  - `force-pi` + Pi absent → **throws `PiRequiredError`** with `E_NOT_FOUND_RESOURCE`.
  - `legacy` → pre-exclusivity behaviour, returns all installed providers in priority order.
- **Install paths UNAFFECTED per ADR-035 D7** — `dispatchInstallSkillAcrossProviders()` and the other multi-provider install fan-outs continue to target every requested provider regardless of `exclusivityMode`. Only **runtime invocation** is gated by the mode. This is an explicit non-goal: CAAMP must remain a usable installer for non-Pi providers even on Pi-first systems.
- **Env var override** — `CAAMP_EXCLUSIVITY_MODE` env var overrides the config setting at boot via the exported `EXCLUSIVITY_MODE_ENV_VAR` constant.
- **New public exports** in [`packages/caamp/src/index.ts`](packages/caamp/src/index.ts): `ExclusivityMode`, `ResolveDefaultTargetProvidersOptions`, `DEFAULT_EXCLUSIVITY_MODE`, `EXCLUSIVITY_MODE_ENV_VAR`, `getExclusivityMode`, `setExclusivityMode`, `resetExclusivityModeOverride`, `isExclusivityMode`, `PiRequiredError`.
- **17 new tests** in `tests/unit/core/harness/exclusivity-mode.test.ts` (+314 LOC) covering the full 3-mode × Pi-installed/absent matrix, warning latches (one-shot per process), env-var precedence, install-path unaffected verification, and `PiRequiredError` shape.
- **Documentation** — README and `caamp.md` updated with the new setting, the three mode semantics, and the `CAAMP_EXCLUSIVITY_MODE` env override ([`packages/caamp/caamp.md`](packages/caamp/caamp.md) +35 LOC).

### Changed

- **`PiHarness.spawnSubagent` is now the single canonical subagent spawn path.** The v1 minimal shape is preserved for back-compat (consumers using `result` and `abort()` work unchanged), but new code paths (Conductor Loop subagent fan-out, CANT `parallel:` workflow nodes) should adopt `exitPromise`, `onStream`, and the static `PiHarness.raceSubagents` / `PiHarness.settleAllSubagents` helpers.
- **`@cleocode/caamp` now depends on `@cleocode/cant`** as a workspace package — required by the T276 `caamp pi cant validate` pipeline. Pulls `cant-napi` transitively.

### Architecture decisions

See [ADR-035](.cleo/adrs/ADR-035-pi-v2-v3-harness.md) for the full audit trail. v2026.4.8 closes:

- **D1** — three-tier scope (project > user > global) for `caamp pi cant *` verbs (T276).
- **D6** — canonical subagent spawn contract: line-buffered streaming, session attribution, idempotent SIGTERM/SIGKILL cleanup, concurrency helpers, orphan handling, no rejects from `exitPromise` (T277).
- **D7** — `caamp.exclusivityMode` setting governs runtime dispatch (`auto` / `force-pi` / `legacy`); install paths remain unaffected so CAAMP stays a usable installer for non-Pi providers (T278).

With T276–T278 landed, the **T261 epic closes**. All thirteen non-deleted children are done: T262, T263, T264, T265, T266, T267, T273, T274, T275, T276, T277, T278, T279. (T268–T272 were deleted as MCP-bridge-as-Pi-extension was rejected per ADR-035 D4.)

### Stats

- **10 commits** since v2026.4.7 (`d765ac29`): `9bb03149`, `2a66f4fb`, `c7533da3`, `1ae20b9a` (T276 + merge), `36ca547e`, `da02ca97`, `6ab01046` (T277 + merge), `6427eb6d`, `87e1677b`, `217b88f9`, `f61f5910` (T278 + merge).
- **Net LOC**: +4083 added, −80 removed (the −80 are localised refactors inside `pi.ts` and `harness/index.ts`; no files deleted).
- **Files touched**: 14 total — 5 new (`commands/pi/cant.ts`, `core/config/caamp-config.ts`, `tests/unit/commands/pi/cant-commands.test.ts`, `tests/unit/core/harness/exclusivity-mode.test.ts`, plus the new harness method test additions in `tests/unit/harness/pi.test.ts`), 9 modified.
- **Tests**: caamp **1428 → 1501** (+73). Breakdown: T276 +40 (24 unit + 16 integration), T277 +16, T278 +17.
- **Zero regressions**, zero new stubs, zero `any`/`unknown`, full biome + typecheck + build + test gates passing.

## [2026.4.7] - 2026-04-07

### Highlights

This release ships the Wave 1 `caamp pi *` verb surface (19 verbs across 5 subgroups, backed by 14 new `PiHarness` methods), rebuilds the `caamp mcp *` command group that was accidentally swept up in the April 3 CLI-only migration (4 verbs covering 44 MCP-capable providers across JSON/JSONC/YAML/TOML), and collapses CANT runtime execution to a single canonical engine (the `cant-bridge.ts` Pi extension) by deleting ~1594 LOC of dead `@cleocode/core/cant` duplicate code. Net change across the release: roughly +5000 LOC added, −1594 LOC removed, +203 new tests, zero regressions.

### Added

#### CAAMP Wave 1 — `caamp pi *` verb surface (T263–T267, ADR-035 D1–D3)

- **19 new `caamp pi <verb>` commands** across five subgroups, wired through `runLafsCommand` so every output is a LAFS envelope with canonical error codes ([`packages/caamp/src/commands/pi/`](packages/caamp/src/commands/pi/)):
  - `caamp pi extensions list|install|remove` (T263) — install supports local file paths, raw HTTPS URLs, GitHub/GitLab shorthand, and URL forms. Conflict-on-write with `--force`, `--scope project|user|global`, `--name` override, shadow-flag reporting on list.
  - `caamp pi sessions list|show|export|resume` (T264) — list reads line 1 only per ADR-035 D2. Export streams line-by-line with optional Markdown transcription. Resume shells out to `pi --session <id>` (never reimplements Pi's lifecycle).
  - `caamp pi models list|add|remove|enable|disable|default` (T265) — strict dual-file authority per ADR-035 D3: `add`/`remove` mutate `models.json`, `enable`/`disable` mutate `settings.json:enabledModels`, `default` mutates `defaultModel` + `defaultProvider`. Numeric flag validation for `--context-window` and `--max-tokens`.
  - `caamp pi prompts install|list|remove` (T266) — directory-based install (requires `prompt.md`), token-efficient list (directory listing only).
  - `caamp pi themes install|list|remove` (T267) — single-file install accepting `.ts`/`.tsx`/`.mts`/`.json`, cross-extension conflict handling.
- **14 new `PiHarness` methods** ([`packages/caamp/src/core/harness/pi.ts`](packages/caamp/src/core/harness/pi.ts), +569 LOC): `installExtension`, `removeExtension`, `listExtensions`, `listSessions`, `showSession`, `readModelsConfig`, `writeModelsConfig`, `listModels`, `installPrompt`, `listPrompts`, `removePrompt`, `installTheme`, `listThemes`, `removeTheme`. `listSessions` reads ONLY line 1 of each `*.jsonl` via a buffered file handle — never loads full session bodies for listings.
- **Three-tier scope resolver** at [`packages/caamp/src/core/harness/scope.ts`](packages/caamp/src/core/harness/scope.ts) (+278 LOC) — single source of truth for project > user > global path resolution. Exports `resolveTierDir`, `resolveAllTiers`, `TIER_PRECEDENCE`. Honours `$PI_CODING_AGENT_DIR` and `$CLEO_HOME` with XDG/Windows/darwin platform fallbacks.
- **New type exports** in [`packages/caamp/src/core/harness/types.ts`](packages/caamp/src/core/harness/types.ts): `ExtensionEntry`, `PromptEntry`, `ThemeEntry`, `HarnessInstallOptions`, `SessionSummary`, `SessionDocument`, `PiModelDefinition`, `PiModelProvider`, `PiModelsConfig`, `ModelListEntry`, `HarnessTier`. Legacy `HarnessScope` preserved for back-compat.
- **Pi-absent fallback** per ADR-035: every verb calls `requirePiHarness()` in [`packages/caamp/src/commands/pi/common.ts`](packages/caamp/src/commands/pi/common.ts), which throws `E_NOT_FOUND_RESOURCE` with "Pi is not installed. Run: caamp providers install pi" when Pi is absent.
- **Error-code hygiene** — `PI_ERROR_CODES` constants map in `common.ts` registers `E_VALIDATION_SCHEMA` (caller input), `E_NOT_FOUND_RESOURCE` (missing resources), and `E_TRANSIENT_UPSTREAM` (network/resume failures) so `runLafsCommand` never rewrites them to `E_INTERNAL_UNEXPECTED`.
- **154 new unit tests** across 3 files: `harness/pi.test.ts` (+103 harness tests, now 911 LOC total), `commands/pi/common.test.ts` (8 tests), `commands/pi/commands.test.ts` (43 integration-style tests driving each verb through Commander `parseAsync`). Covers every verb's happy path plus input-rejection branches, three-tier shadow detection, malformed session headers, models round-trip + default fallthrough, prompt rejection on missing `prompt.md`, theme cross-extension conflicts, and platform-specific Windows/darwin branches via `process.platform` stub.

#### CAAMP `caamp mcp *` commands restored (Option C)

CAAMP's original design promise was *"a unified provider registry and package manager for AI coding agents. It replaces the need to manually configure each agent's MCP servers, skills, and instruction files individually — handling the differences in config formats (JSON, JSONC, YAML, TOML), config keys (`mcpServers`, `mcp_servers`, `extensions`, `mcp`, `servers`, `context_servers`), and file paths across all supported providers."* This feature was deleted in `480fa01a` during the CLI-only migration. Option C rebuilds it lean on top of the still-existing `core/formats/*`, `core/paths/agents.ts`, and `core/registry/types.ts` infrastructure.

- **4 new `caamp mcp <verb>` commands** ([`packages/caamp/src/commands/mcp/`](packages/caamp/src/commands/mcp/), 14 files, +2661 LOC):
  - `caamp mcp list [--provider <id>]` — enumerate installed MCP servers (format-agnostic read through `core/formats/*`).
  - `caamp mcp install --provider <id> <name> -- <command> [args...]` — writes MCP server config into the provider's native config file. Conflict-on-write; supports `--scope project|user|global`, `--env KEY=VAL` (repeatable), `--force`.
  - `caamp mcp remove --provider <id> <name>` (single provider) or `--all-providers <name>` (idempotent removal across every MCP-capable provider).
  - `caamp mcp detect` — lightweight filesystem probe of every MCP-capable provider, reporting installed servers per provider.
- **Library API** — 7 new functions + 6 new types exported from `@cleocode/caamp`:
  - `core/mcp/reader.ts` (+274 LOC): `readMcpServers`, `readAllMcpServers`, plus `McpServerRecord` and `ProviderMcpReadResult` types.
  - `core/mcp/installer.ts` (+138 LOC): `installMcpServer` with options-object signature (`{ provider, name, command, args, env, scope, projectDir, force }`).
  - `core/mcp/remover.ts` (+164 LOC): `removeMcpServer`, `removeMcpServerFromAll`.
  - `core/mcp/index.ts` (+37 LOC): package barrel re-exports.
- **Provider coverage** — 44 of 45 providers in [`providers/registry.json`](packages/caamp/providers/registry.json) enumerated (all except `pi`, which has no `capabilities.mcp`).
- **Format coverage** — JSON (41 providers), JSONC (1 — `zed` at `context_servers`), YAML (2 — `goose` at `extensions`, `swe-agent`), TOML (1 — `codex` at `mcp_servers`). Dot-notation key paths exercised: `mcpServers`, `mcp_servers`, `extensions`, `mcp`, `servers`, `context_servers`, `amp.mcpServers`.
- **49 new tests** across 4 files: `tests/unit/commands/mcp/commands.test.ts` (22 Commander-drive integration tests, +707 LOC), `tests/unit/mcp-reader.test.ts` (+188 LOC), `tests/unit/mcp-installer.test.ts` (+187 LOC), `tests/unit/mcp-remover.test.ts` (+146 LOC). Covers happy paths, conflict-on-write, idempotency, and JSON/JSONC/TOML format round-trips through the format-agnostic substrate.
- **Docs refreshed** — [`packages/caamp/README.md`](packages/caamp/README.md), [`packages/caamp/caamp.md`](packages/caamp/caamp.md), [`packages/caamp/docs/ADVANCED-RECIPES.md`](packages/caamp/docs/ADVANCED-RECIPES.md) updated for the new `--provider <id> -- <command>` shape and the options-object `installMcpServer` signature.
- **Zero new external dependencies** — `@modelcontextprotocol/sdk` is NOT added. CAAMP treats MCP server configs as plain data records and doesn't speak MCP itself.

#### ADR-035 — Pi v2+v3 harness architecture decision record

- **[ADR-035](.cleo/adrs/ADR-035-pi-v2-v3-harness.md)** (+373 LOC) — complete audit trail for the Pi harness architecture, including decisions D1 (three-tier scope project > user > global), D2 (line-1-only session JSONL listing for token efficiency), D3 (dual-file models authority — `models.json` for definitions + `settings.json:enabledModels` for selection), D4 (MCP-as-Pi-extension rejected; config-file management for non-Pi providers remains a first-class CAAMP concern), D5 (single CANT execution engine via `cant-bridge.ts`, `@cleocode/core/cant` deleted).
- Manifest updated: [`.cleo/adrs/MANIFEST.jsonl`](.cleo/adrs/MANIFEST.jsonl).

### Changed

- **`cleo agent start` profile handling documented as Pi-independent** — the `cleo agent start` daemon polls SignalDock for messages and never executes the `.cant` profile internally. Profile-driven workflow execution lives entirely inside Pi sessions via the `cant-bridge.ts` extension. The daemon's profile read is a fail-fast guard plus an operator-visible status string, not an execution step. A comprehensive block comment above the start verb explains the daemon vs. Pi-session split and points operators at `/cant:load` and `/cant:run` for profile execution ([`packages/cleo/src/cli/commands/agent.ts`](packages/cleo/src/cli/commands/agent.ts)).
- **`agent-profile-status.ts` extracted** as a pure helper ([`packages/cleo/src/cli/commands/agent-profile-status.ts`](packages/cleo/src/cli/commands/agent-profile-status.ts), +112 LOC) computing the four-state status string (`none` / `loaded (unvalidated)` / `validated` / `invalid (N errors)`) without spinning up `createRuntime`, the registry, or `fetch`. Plus 8 unit tests covering all four status branches and edge cases.

### Removed

- **`packages/core/src/cant/*`** (−1574 LOC across 7 files) — dead `@cleocode/core/cant` `WorkflowExecutor` namespace with zero production callers. Strictly duplicate with the `cant-bridge.ts` Pi extension shipped in v2026.4.6, which already implements all 16 workflow statement types via shell-out to `cleo cant parse/validate/execute`. Deletes `approval.ts`, `context-builder.ts`, `discretion.ts`, `index.ts`, `parallel-runner.ts`, `types.ts`, and `workflow-executor.ts` (618 LOC alone). On-disk `.cant` agent fixture validation tests moved from `packages/core/src/cant/__tests__/` to `packages/cant/tests/` since they exercise grammar fixtures, not the deleted namespace. See ADR-035 D5.
- **MCP bridge placeholder** at `packages/caamp/src/core/harness/mcp/index.ts` (−53 LOC). The placeholder was a one-day stopgap that unblocked the `tsup` build when a stale `tsup.config.ts` entry point referenced a file that had never been created on disk (causing `pnpm run build` to fail on fresh checkouts). Replaced by actual deletion of both the stale entry point and the placeholder.
- **`installMcpAsExtension` scaffold** and its private `extensionsDir` helper from `PiHarness` (−79 LOC).
- **`McpServerSpec` type** from `harness/types.ts` and its re-exports from `harness/index.ts` and `src/index.ts` (−68 LOC).
- **`installMcpAsExtension` method** from the `Harness` interface.
- **`mcp` keyword** from [`packages/caamp/package.json`](packages/caamp/package.json) — positioning statement; MCP config-file management for non-Pi providers remains a first-class CAAMP concern, but MCP itself is not a first-class CleoOS primitive.
- **`@modelcontextprotocol/sdk`** from `build.mjs` externals (was prep for the never-shipped bridge; no source actually imports it).
- **MCP scaffold tests** and the Wave 1 `isBridgeAvailable` smoke test from `tests/unit/harness/pi.test.ts` (−65 LOC). See ADR-035 D4 for rationale: Pi extensions strictly dominate MCP tools on every axis (hooks, slash commands, prompt injection, blocking/rewriting, renderers, providers, keybindings, direct TS calls vs JSON-RPC framing). MCP solves multi-client coordination — CleoOS is single-client (Pi).

### Fixed

- **Broken main build on fresh checkouts** — the pre-existing botched commit `3deba942 fix(caamp): add MCP bridge placeholder so build resolves harness/mcp entry` added a placeholder to unblock a `tsup.config.ts` entry point that referenced a file never added to any commit. Fresh checkouts between `b57eb74e` and `3deba942` failed `pnpm run build`. The Wave 1 merge and the subsequent Option Y cleanup (commit `96d6a1ae`) resolve this by deleting both the stale `tsup` entry and the placeholder file.

### Architecture decisions

See [ADR-035](.cleo/adrs/ADR-035-pi-v2-v3-harness.md) for the full audit trail, especially:

- **D4 Option Y collapse** — MCP is legacy interop only for Pi harness; CAAMP's config-file management for the 44 non-Pi MCP-capable providers remains a first-class concern (hence the restored `caamp mcp *` surface).
- **D5 Option Y collapse** — Single CANT execution engine lives in `cant-bridge.ts`; `@cleocode/core/cant` has been deleted.

### Stats

- **15 commits** since v2026.4.6 (`b57eb74e`): `b71c77eb`, `3deba942`, `c49bbccf`, `d1d2466d`, `9b2e9ddc`, `3fc5ff28`, `b46a7a1b`, `55f56a06`, `96d6a1ae`, `d952db8e`, `cd1a1a4e`, `0f5719e0`, `af5b2501`, `9fbb026b`, `ebd1ac93`.
- **Net LOC**: ~+5000 added, −1594 removed.
- **Tests**: caamp 1379 → 1428 (+49 MCP tests; +154 Pi Wave 1 tests offset by −65 scaffold test deletions). Full monorepo test count increases by +203 from Wave 1 + MCP + `agent-profile-status` additions.
- **Zero regressions**, zero new stubs, zero `any`/`unknown`, full biome + typecheck + build + test gates passing.

## [2026.4.6] - 2026-04-07

### CleoOS — autonomous orchestration is now real

This release closes the autonomous-orchestration gap identified in the v2026.4.x system assessment. CLEO + Pi now form a functional CleoOS: a unified, cross-project agentic operating system with a Conductor Loop, skill-backed stage guidance, a CANT runtime bridge, and a global hub of recipes/extensions/agents that ships with `npm install`.

This release builds on top of the v2026.4.5 Pi-as-primary harness work and the T260 dedicated-protocols/skills epic. It fills in the runtime, distribution, and validation layers.

### Added

#### CleoOS hub (Phase 1) — `$CLEO_HOME/{global-recipes,pi-extensions,cant-workflows,agents}`

- **`getCleoGlobalRecipesDir/getCleoPiExtensionsDir/getCleoCantWorkflowsDir/getCleoGlobalAgentsDir`** path resolvers in `@cleocode/core` ([`packages/core/src/paths.ts`](packages/core/src/paths.ts)). All four hub subdirectories live under the existing XDG-compliant `getCleoHome()` (Linux: `~/.local/share/cleo/`).
- **`ensureCleoOsHub()`** scaffolding entry point in [`packages/core/src/scaffold.ts`](packages/core/src/scaffold.ts). Idempotent, copies templates from the bundled `@cleocode/cleo` package, never overwrites operator/agent edits.
- **`cleo admin paths`** query — reports all CleoOS paths and per-component scaffolding status as a LAFS envelope.
- **`cleo admin scaffold-hub`** mutation — explicit hub provisioning command for operators.
- **`packages/cleo/templates/cleoos-hub/`** bundle — ships with the `@cleocode/cleo` npm tarball. Contains `pi-extensions/{orchestrator,stage-guide,cant-bridge}.ts`, `global-recipes/{justfile,README.md}`, plus a top-level `README.md`.
- **Global Justfile Hub** seeded with cross-project recipes (`bootstrap`, `stage-guidance <stage>`, `skills`, `skill-info <name>`, `lint`, `test`, `recipes`) — every recipe wraps `cleo` CLI invocations rather than re-encoding protocol text.

#### Pi as the exclusive CAAMP harness (Phase 2)

- **Pi registered** as the 45th CAAMP provider (`packages/caamp/providers/registry.json`) with full harness capability metadata (`role: "primary-orchestrator"`, `conductorLoopHost: true`, `stageGuidanceInjection: true`, `cantBridgeHost: true`, `globalExtensionsHub: $CLEO_HOME/pi-extensions`). Pi sits alongside the v2026.4.5 priority `"primary"` tier introduced for the Pi-first reshape.
- **`buildStageGuidance(stage, cwd?)`** in [`packages/core/src/lifecycle/stage-guidance.ts`](packages/core/src/lifecycle/stage-guidance.ts) — thin loader that maps each pipeline stage to its dedicated SKILL.md via `STAGE_SKILL_MAP` (rewired in T260 to ct-consensus-voter, ct-adr-recorder, ct-ivt-looper, ct-release-orchestrator) and composes Tier-0 + stage-specific skills via the existing `prepareSpawnMulti()` helper. **Source: `skills` (real `SKILL.md` files), never hand-authored.**
- **`renderStageGuidance(stage)`**, **`formatStageGuidance(g)`**, **`STAGE_SKILL_MAP`**, **`TIER_0_SKILLS`** exports for downstream consumers.
- **`cleo lifecycle guidance [stage]`** CLI command — Pi extensions shell out to this on `before_agent_start` to inject the stage-aware system prompt. Resolves stage from `--epicId <id>` automatically when omitted.
- **`pipeline.stage.guidance`** dispatch operation in `@cleocode/cleo` (registered in `dispatch/registry.ts` and routed in `dispatch/domains/pipeline.ts`).
- **`stage-guide.ts` Pi extension** — `before_agent_start` hook that calls `cleo lifecycle guidance --epicId` and returns `{ systemPrompt }` to enrich the LLM's effective prompt with skill-backed protocol text.

#### Conductor Loop (Phase 3)

- **`orchestrator.ts` Pi extension** (~624 lines) — registers `/cleo:auto <epicId>`, `/cleo:stop`, `/cleo:status` commands. The loop polls CLEO for ready tasks, queries the active stage, fetches stage guidance, spawns subagents via the CLEO orchestrate engine, monitors completion, and validates output. Includes mock mode (`CLEOOS_MOCK=1`) for CI, safety cap of 100 iterations, and graceful `ctx.signal` cancellation. Loads ct-orchestrator + ct-cleo (Tier 0) into the LLM system prompt on every turn so even sessions without an active epic operate under the skill-backed protocol.
- **`cleo agent work --execute`** flag in [`packages/cleo/src/cli/commands/agent.ts`](packages/cleo/src/cli/commands/agent.ts) — fills the documented gap at line 791. The work loop now actually spawns ready tasks via `orchestrate.spawn.execute` instead of merely advertising them. New `--adapter <id>` and `--epic <id>` flags scope execution.

#### CANT runtime bridge via napi-rs (Phase 4)

- **`cant-napi` extended** with async `cant_execute_pipeline(file, name)` exposing `cant-runtime::execute_pipeline` to Node ([`crates/cant-napi/src/lib.rs`](crates/cant-napi/src/lib.rs)). Returns structured `JsPipelineResult` with per-step exit codes, stdout/stderr lengths, and timing.
- **`@cleocode/cant` migrated to napi-rs**: `executePipeline(filePath, pipelineName)` async TS API in `packages/cant/src/index.ts` calls into the native binding. **The legacy WASM bundle is gone** (see Removed below).
- **`cant-bridge.ts` Pi extension** (~989 lines) — registers `/cant:load <file>`, `/cant:run <file> <workflow>`, `/cant:execute-pipeline <file> --name <pipeline>`, `/cant:info`. Parses .cant files via `cleo cant parse`, delegates deterministic pipelines to the napi binding, interprets workflow constructs (Session, Parallel race/settle, Conditional with Expression+Discretion, ApprovalGate, Repeat, ForLoop, LoopUntil, TryCatch) in TypeScript using Pi's native subagent spawning. When `/cant:load` reads an Agent definition, the bridge captures its declared `skills:` list and the `before_agent_start` hook fetches each skill's metadata via `cleo skills info` to compose a system-prompt prefix at every LLM turn. Mock mode and `ctx.signal` cancellation supported throughout.
- **`cleo cant parse|validate|list|execute`** CLI commands in [`packages/cleo/src/cli/commands/cant.ts`](packages/cleo/src/cli/commands/cant.ts) — call directly into the @cleocode/cant napi-backed TS API, no shell-out to a standalone binary.
- **6 canonical seed agents bundled** in [`packages/agents/seed-agents/`](packages/agents/seed-agents/): `cleo-prime`, `cleo-dev`, `cleo-historian`, `cleo-rust-lead`, `cleo-db-lead`, `cleoos-opus-orchestrator`. Pre-existing T01 `persist` boolean errors fixed in the seeds before bundling.
- **`cleo init --install-seed-agents`** flag — opt-in installer for the canonical seeds into the project's `.cleo/agents/` directory.

#### Greenfield/brownfield bootstrap (Phase 5)

- **`classifyProject(directory?)`** in [`packages/core/src/discovery.ts`](packages/core/src/discovery.ts) — read-only classifier that detects `greenfield` (empty/new) vs `brownfield` (existing codebase) by checking `.git/`, source dirs, package manifests, and docs presence. Returns a `ProjectClassification` with signal list and metadata.
- **`cleo init`** now classifies the directory BEFORE creating files and emits `classification: { kind, signalCount, topLevelFileCount, hasGit }` in the LAFS envelope.
- **`nextSteps: Array<{action, command}>`** field in init output — different recommendations for greenfield (start session, seed Vision epic, run Conductor Loop) vs brownfield (anchor codebase in BRAIN, review project context, start scoped session).
- **Brownfield warning** — when a brownfield project is initialized without `--map-codebase`, init emits a warning recommending `cleo init --map-codebase` to anchor the existing codebase as BRAIN baseline (Phase 5 context anchoring).
- **`ensureCleoOsHub()` invoked from `cleo init`** — every new project gets the CleoOS hub provisioned automatically.

#### LAFS validator middleware (Phase 6)

- **`packages/cleo/src/cli/renderers/lafs-validator.ts`** — middleware that validates every CLI envelope before stdout. Full envelopes (`{$schema, _meta, success, result}`) delegate to the canonical `validateEnvelope()` from `@cleocode/lafs` (which uses `lafs-napi` Rust + AJV fallback against `packages/lafs/schemas/v1/envelope.schema.json`). Minimal envelopes (`{ok, r, _m}`) are checked against a local shape invariant since the canonical schema doesn't cover the agent-optimized format.
- **`ExitCode.LAFS_VIOLATION = 104`** — emitted when a CLEO-internal envelope fails the shape contract. Wraps the malformed output in a valid error envelope on stderr and sets `process.exitCode`.
- **`CLEO_LAFS_VALIDATE=off` env opt-out** — disables the validator middleware for performance-sensitive scripted use.

### Changed

- **`packages/core/schemas/` reduced from 43 → 10 files.** 33 orphan schemas deleted (audit confirmed zero AJV consumers in source code; only cosmetic comment/URL references remained).
- **`STAGE_SKILL_MAP` rewired** in [`packages/core/src/lifecycle/stage-guidance.ts`](packages/core/src/lifecycle/stage-guidance.ts) (T260, shipped via this release): consensus → ct-consensus-voter, architecture_decision → ct-adr-recorder, testing → ct-ivt-looper, release → ct-release-orchestrator, validation → ct-validator (kept). Each pipeline stage now owns exactly one dedicated skill — no more overloaded ct-validator/ct-dev-workflow assignments.
- **`packages/cant/package.json` files array**: `"wasm/"` removed, `"napi/"` added.
- **`packages/cleo/package.json` files array**: `"templates"` added so the cleoos-hub bundle ships in the npm tarball.
- **`@cleocode/cant` runtime path**: every consumer now goes through the napi-rs binding. The TypeScript `native-loader.ts` no longer falls back to WASM.
- **`cleo init` LAFS output shape extended** with `classification` and `nextSteps` fields. Existing fields (`initialized`, `directory`, `created`, `skipped`, `warnings`) unchanged.
- **`cleo cant migrate` and other cant subcommands** route through the napi binding instead of the WASM fallback.

### Removed

- **`packages/cant/wasm/`** — entire WASM bundle deleted (`cant_core.{js,d.ts,_bg.wasm,_bg.wasm.d.ts}` + `package.json`). The `build:wasm` script removed from `packages/cant/package.json`.
- **`packages/cant/src/wasm-loader.ts`** — superseded by the napi-only `native-loader.ts`.
- **`crates/cant-runtime/src/bin/cant-cli.rs`** — standalone binary deleted now that `cant-napi` exposes `execute_pipeline` directly. One less artifact to ship, no per-platform binary distribution complexity.
- **`packages/core/src/conduit/__tests__/dual-api-e2e.test.ts`** — deleted entirely. The test suite was a transitional E2E that exercised both the canonical `api.signaldock.io` and the legacy `api.clawmsgr.com` against real network endpoints. Per the v2026.4.5 deprecation, ClawMsgr is no longer a supported backend, and network-dependent E2E tests are an anti-pattern in the unit test runner. Removed along with the generated `.d.ts`/`.js`/`.js.map` files. SignalDock health and messaging are exercised by the existing in-process LocalTransport unit tests and the live `cleo admin smoke` probes.
- **33 orphan JSON schemas** in `packages/core/schemas/`: `agent-configs`, `agent-registry`, `archive`, `brain-{decision,learning,pattern}`, `critical-path`, `deps-cache`, `doctor-output`, `error`, `global-config`, `grade`, `log`, `metrics`, `migrations`, `nexus-registry`, `operation-constitution`, `output`, `projects-registry`, `protocol-frontmatter`, all 9 `rcasd-*` schemas, `releases`, `skills-manifest`, `spec-index`, `system-flow-atlas`. None had any AJV consumers; deleted with no runtime impact.

### Fixed

- **`agent.ts:791` Conductor Loop gap** — `cleo agent work` now actually spawns tasks via the orchestrate engine when `--execute` is passed (was: prints "Task available. Run: cleo start <id> to begin." and exits). The legacy watch-only mode is preserved as the default for backwards compatibility.
- **Pre-existing T01 errors** in 6 `.cant` seed agent files — `persist: project` (string) → `persist: true` (boolean) per the .cant grammar contract. All 6 seeds now validate clean via `cleo cant validate`.
- **`getSupportedOperations()` drift** in `AdminHandler` — `paths` (query) and `scaffold-hub` (mutate) added to the explicit operation list to keep `alias-detection.test.ts` and `admin.test.ts` in sync with the registry.
- **Operation count drift** in `parity.test.ts` — registry now exposes 130 query + 98 mutate = 228 total operations (was: 128/97/225). Test expectations updated.

### Acknowledgements

This release stacks on top of:

- **v2026.4.5 (BREAKING)** — Pi as primary CAAMP harness, registry v3 schema, harness layer abstraction, default-resolution to primary harness across CAAMP commands. The harness contract `PiHarness` introduced there is what makes the CleoOS Conductor Loop possible.
- **T260 epic (committed in v2026.4.5)** — 12 dedicated protocols + 6 new v2-compliant skills (`ct-adr-recorder`, `ct-ivt-looper`, `ct-consensus-voter`, `ct-release-orchestrator`, `ct-artifact-publisher`, `ct-provenance-keeper`) + project-agnostic IVT loop in `testing.md` + composition pipeline in `release.md`. The CleoOS stage-guidance loader points at these skills.

### Migration

No public API removed beyond the WASM path in `@cleocode/cant`. If you imported from `@cleocode/cant/wasm-loader` directly (unlikely — it was internal), switch to the public TS API:

```diff
- import { initWasm, cantParseWasm } from '@cleocode/cant/wasm-loader';
- await initWasm();
- const result = cantParseWasm(content);
+ import { parseCANTMessage } from '@cleocode/cant';
+ const result = parseCANTMessage(content);
```

The napi binding loads synchronously on first use; no `await initWasm()` ceremony.

If you depended on the standalone `cant-cli` Rust binary that briefly existed in `crates/cant-runtime/src/bin/`, switch to the napi-backed TS API or shell out to `cleo cant parse|validate|list|execute` (which now wraps the napi binding internally).

## [2026.4.5] - 2026-04-06

### ⚠ BREAKING CHANGES — v3 harness architecture

The CAAMP provider model has been generalised so that Pi (`@mariozechner/pi-coding-agent`) is the first-class primary harness CLEO is built around and optimises for. Other providers continue to work as spawn targets, but MCP-as-config-file is no longer the load-bearing assumption.

**Registry schema v2.0.0** — all provider data reshaped. If you consume `@cleocode/caamp` as a library and read the resolved `Provider` type, you MUST update your code:

- The six top-level MCP fields (`configKey`, `configFormat`, `configPathGlobal`, `configPathProject`, `supportedTransports`, `supportsHeaders`) have been **removed from `Provider`**. They now live under `provider.capabilities.mcp`, which is `ProviderMcpCapability | null`. Providers without MCP integration (Pi) have `capabilities.mcp === null`.
- `ProviderPriority` gained `'primary'` as a new tier above `'high'`. Exactly one provider per registry may have priority `'primary'` (today: Pi).
- New optional `provider.capabilities.harness: ProviderHarnessCapability | null` — populated for first-class harnesses (today: Pi). Describes the harness kind (`orchestrator` / `standalone`), spawn targets, extension paths, and CLEO-integration flags.
- `RegistrySpawnCapability.spawnMechanism` gained `'native-child-process'`. New optional `spawnCommand: string[] | null` captures the literal invocation (Pi: `["pi", "--mode", "json", "-p", "--no-session"]`).
- `RegistryHooksCapability.hookFormat` gained `'typescript-directory'`. New fields: `hookConfigPathProject`, `nativeEventCatalog` (`'canonical' | 'pi'`), `canInjectSystemPrompt`, `canBlockTools`.
- Pi's hook events use a separate `pi` catalog in `providers/hook-mappings.json` (sibling of the existing `canonicalEvents` map) since Pi's native event names don't map cleanly to the canonical catalog.

### Added

- **Pi harness layer** ([`packages/caamp/src/core/harness/`](packages/caamp/src/core/harness/)): new abstraction for first-class harnesses. Exports `Harness` interface, `getHarnessFor(provider)`, `getPrimaryHarness()`, `getAllHarnesses()`, `PiHarness` class, and `resolveDefaultTargetProviders()` helper. `PiHarness` implements the full contract against `~/.pi/agent/` and `.pi/` — skills install via copy (not symlink), instructions injected into `AGENTS.md` with marker blocks, settings managed atomically, MCP servers can be scaffolded as Pi extensions, and subagents are spawned via `child_process.spawn('pi', ...)`. 37 new unit tests cover the roundtrip.
- **`getPrimaryProvider()`** query function in the registry, returning the provider with `priority === 'primary'`.
- **Registry migration script** (`packages/caamp/scripts/migrate-registry-v2.mjs`): idempotent, ES-module, zero-dep migrator that moved 264 MCP fields (44 providers × 6 fields) into `capabilities.mcp`, bumped registry to v2.0.0, and rewrote Pi's entry with the harness capability block.
- **Pi-primary default resolution** across all CAAMP commands: when no `--agent` flag is given, commands target the primary harness if installed, falling back to the high-priority installed set. Applies to `caamp skills install|remove|update|list`, `caamp instructions inject|check|update`, and `caamp advanced` operations.
- **Harness dispatch** in `skills install/remove/update` and `instructions inject/update`: if the target provider has a harness, the command calls the harness method directly (bypassing the generic MCP-config-file path). Generic providers continue to use the existing code paths unchanged.
- **`$CLEO_HOME` template variable** support in registry path resolution, honouring `CLEO_HOME` env var with XDG/macOS/Windows fallbacks to support Pi's `globalExtensionsHub`.

### Changed

- **`registry.json` version bumped `1.1.0` → `2.0.0`.** All 44 non-Pi providers migrated to the new capability shape. Pi entry rewritten with `priority: "primary"`, no `capabilities.mcp`, full `capabilities.harness` populated.
- **`hook-mappings.json` version bumped `1.0.0` → `2.0.0`.** Added 22-entry `piEventCatalog` sibling key mapping Pi's native events (`session_start`, `before_agent_start`, `tool_execution_start`, …) to their canonical equivalents where they exist.
- **`doctor` command**: now treats missing `capabilities.mcp` as "valid, extension-based harness" rather than a validation failure. Config-file checks emit a pass for harness-based providers.
- **`providers show`** and **`config show`**: gracefully render `(none — extension-based harness)` for providers without an `mcp` capability.
- **CLEO consumers** (`packages/core/src/metrics/__tests__/provider-detection.test.ts`): updated provider-detection test fixture to the new capability shape.

### Fixed

- **Pre-existing `admin.test.ts` drift** in `packages/cleo/src/dispatch/domains/__tests__/`: `initProject` mock was missing `skipped` and `warnings` fields required by the current return type.
- **Pre-existing Rust formatting drift** in `crates/cant-core/src/generated/events.rs` surfaced by `cargo fmt` gate; reformatted.

### Migration for library consumers

If you import `Provider` from `@cleocode/caamp`:

```diff
- const key = provider.configKey;
- const fmt = provider.configFormat;
- const path = provider.configPathGlobal;
+ const mcp = provider.capabilities.mcp;
+ if (!mcp) { /* provider has no MCP integration (e.g. Pi) */ return; }
+ const { configKey, configFormat, configPathGlobal } = mcp;
```

The old top-level fields are **gone**, not deprecated. There is no compat shim — this is a straight v3 move.

## [2026.4.4] - 2026-04-06

### Fixed
- **`@cleocode/cant` and `@cleocode/runtime` npm publish**: added missing `repository.url` field to `packages/cant/package.json` and `packages/runtime/package.json`. Without it, npm sigstore provenance verification rejected publishes with `422 Unprocessable Entity — Error verifying sigstore provenance bundle: "repository.url" is "", expected to match "https://github.com/kryptobaseddev/cleo"`. These two packages were stuck on npm at 2026.4.1 (cant) and 2026.4.0 (runtime) for this reason. v2026.4.4 brings them current alongside the rest of the workspace.
- **`@cleocode/cant` publishConfig**: added explicit `publishConfig.access = public` so the scoped package always publishes publicly regardless of npm CLI defaults.

## [2026.4.3] - 2026-04-06

### Added
- **LAFS native Rust validation** ([cbe235d5](https://github.com/kryptobaseddev/cleo/commit/cbe235d5)): replaces AJV with `jsonschema` crate via napi-rs binding (`crates/lafs-napi`); embedded schema cached in `OnceLock`, transparent AJV fallback when native binding unavailable
- **CAAMP doctor lock-file diagnostics**: restored `Lock File` section reporting orphaned skill entries, untracked skills on disk, and lock-vs-symlink agent-list mismatches (uses `core/lock-utils.js` after MCP cleanup)

### Fixed
- **CI unit-test failures** ([91a7f480](https://github.com/kryptobaseddev/cleo/commit/91a7f480)): caamp `tests/unit/` was pulled into root vitest by `cbe235d5` for the first time, exposing 11 stale `doctor.test.ts` failures (referencing the lock-file section removed in `480fa01a`) and 1 flaky `core-coverage-gaps.test.ts` GitLab test that hit real `gitlab.com` and got the sign-in HTML on a non-existent repo. Doctor checks restored, GitLab fetch mocked.
- **LAFS schema loading** ([22e0ad98](https://github.com/kryptobaseddev/cleo/commit/22e0ad98)): lazy-load envelope schema JSON, AJV-specific TSDoc cleaned up
- **Pipeline lifecycle** ([fde8c401](https://github.com/kryptobaseddev/cleo/commit/fde8c401)): enforce forward-only RCASD-IVTR stage transitions
- **Status transitions and gate enforcement** ([7f5be7d3](https://github.com/kryptobaseddev/cleo/commit/7f5be7d3)): config-aware verification gates, session-end memory bridge auto-refresh
- **Lint** ([a137fc14](https://github.com/kryptobaseddev/cleo/commit/a137fc14)): sort `internal.ts` exports for biome compliance

### Changed
- **LAFS docs audit** ([db53dee2](https://github.com/kryptobaseddev/cleo/commit/db53dee2)): comprehensive cleanup of stale documentation
- **LAFS cleanup** ([1b714b08](https://github.com/kryptobaseddev/cleo/commit/1b714b08)): removed ~6k lines of cruft from pre-monorepo era

## [2026.4.2] - 2026-04-05

### Fixed
- **`cleo inject` MCP purge**: replaced all `ct` prefix commands with `cleo`, removed `orchestrate.bootstrap` and `query({...})` MCP syntax from injection template
- **`cleo memory fetch` broken**: variadic `<ids...>` args not parsed by citty shim — switched to comma-split single positional arg
- **`cleo add --desc` silent failure**: `--desc` flag not recognized, causing description to default to title and trigger anti-hallucination rule — added `--desc` as explicit alias
- **Root version mismatch**: root `package.json` was 2026.3.76, all packages were 2026.4.1
- **Help text `ct` prefix**: system-engine.ts help topics used deprecated `ct` prefix instead of `cleo`
- **ct-cleo skill stale references**: 2 `ct find` references updated to `cleo find`

### Changed
- **CLEO-INJECTION.md optimized**: 133 → 72 lines (v2.4.0), CLI-only dispatch, all `cleo` prefix, no MCP syntax
- **Injection template tests**: updated for v2.4.0 structure (19 tests passing)
- **All 15 ct-* skills synced**: deployed from repo sources with MCP references removed
- **signaldock-runtime**: enhanced provider detection, generic provider support, cleaner adapter init

## [2026.4.0] - 2026-04-01

### Added
- **T234 Agent Domain Unification**: Complete separation of concerns — signaldock.db owns ALL agent data, tasks.db owns tasks only
- **AgentRegistryAccessor rewrite**: Reads/writes signaldock.db exclusively (no dual-write, no cache)
- **agent_connections table**: SSE/WebSocket lifecycle tracking with heartbeat monitoring
- **agent_credentials migration**: api_key_encrypted, transport_config, classification in signaldock.db
- **LocalTransport proven**: E2E lifecycle test (6 tests) — register, start, send, receive, stop
- **TransportFactory wiring**: createRuntime() auto-selects Local > SSE > HTTP
- **cleo agent start**: Full transport stack working with LocalTransport auto-selection
- **.cant scaffold on register**: T240 — generates valid CANT v2 persona file on agent registration
- **CANT v2 ProseBlock**: AST node for multi-line prose in .cant files
- **DieselStore message traits**: count_unread, unread_by_conversation, online agent listing
- **Cross-DB write-guards**: agentExistsInSignaldockDb() validation before cross-DB references
- **Junction table sync**: capabilities/skills synced to signaldock.db on register/update
- **cleo-prime**: Registered on api.signaldock.io as primary orchestrator identity

### Removed
- 12 sqlx adapter files (102 queries eliminated) — Diesel is sole Rust ORM
- agent_credentials dual-write pattern (was writing to both tasks.db and signaldock.db)
- Backfill code from upgrade.ts

### Fixed
- Drizzle migration FK ordering (lifecycle_evidence created before lifecycle_stages)
- Peek SQL timestamp filtering (was returning all messages from epoch)
- 3 CRITICAL security vulnerabilities on api.signaldock.io (AnyAuth bypass, message leakage, impersonation)
- ClawMsgr worker: 4-track message discovery, --agent flag, cursor stall fix
- ClawMsgr daemon: full message delivery (was count-only)
- signaldock.db embedded migrations work outside monorepo

### Changed
- Database separation: tasks.db=tasks, signaldock.db=agents, brain.db=memory, nexus.db=collab
- SignalDock is primary communication channel (ClawMsgr is legacy backup)
- All agent configs updated with groupConversationIds + correct API URLs
- 5 agent personas updated with --agent polling standard

### Added (T158 CAAMP 1.9.1 Integration)
- CAAMP ^1.9.1 with 16-event canonical hook taxonomy (T159)
- Hook types migrated to canonical names with backward compat (T160)
- Gemini CLI adapter: 10/16 hooks, getTranscript, install (T161)
- Codex adapter: 3/16 hooks, getTranscript, install (T162)
- Kimi adapter: install-only, no native hooks (T163)
- Claude Code adapter: 9→14 hooks via CAAMP normalizer (T164)
- OpenCode adapter: 6→10 hooks via CAAMP normalizer (T164)
- Cursor adapter: 0→10 hooks, fully implemented (T165)
- Brain automation handlers for SubagentStart/Stop, PreCompact (T166)
- `cleo doctor --hooks` provider hook matrix diagnostic (T167)
- E2E hook automation tests (T168)

## [2026.3.76] - 2026-03-28

### Added
- **Agent Unification (T170)**: Unified `cleo agent` CLI with 10 subcommands (register, list, get, remove, rotate-key, claim-code, watch, poll, send, health)
- **Agent Registry**: `agent_credentials` table with AES-256-GCM encrypted API keys (machine-key bound, per-project derived)
- **Conduit Architecture**: ConduitClient + HttpTransport + factory (2-layer Transport/Conduit pattern)
- **Transport interface**: connect/disconnect/push/poll/ack/subscribe in @cleocode/contracts
- **AgentCredential + AgentRegistryAPI contracts**: typed CRUD for credential management
- **@cleocode/runtime**: AgentPoller with group @mention support (fixes peek blind spot)
- **5 Rust crates migrated**: signaldock-protocol, signaldock-storage, signaldock-transport, signaldock-sdk, signaldock-payments (5→13 workspace crates)
- Diesel ORM foundation for signaldock-storage (schema.rs, models, consolidated migration)
- diesel-async 0.8 with SyncConnectionWrapper for unified SQLite + Postgres adapter
- Conduit dispatch domain (5 operations: status, peek, start, stop, send)
- cleo agent watch command for continuous message polling
- cleo agent claim-code command for ownership verification
- cleo agent health command (merged from deprecated `cleo agents`)
- TypedDb pattern with drizzle-orm/zod validation schemas
- **CANT DSL epic complete (T202)**: 694 tests, 17K Rust + 3.8K TS, 3 new crates (cant-napi, cant-lsp, cant-runtime)
- Crypto hardening: version byte in ciphertext (F-006), HOME validation (F-002), key length check (F-004)

### Fixed
- E-FIND-004: ACL denial now audited + projectPath redacted in nexus/workspace.ts
- AgentRegistryAccessor: pre-flight checks on update/remove (C1/C2), deterministic getActive ordering (H3)
- HttpTransport: `since` param now passed to peek endpoint (H5)
- ConduitClient: connect() transitions to error state on failure (H6)
- CLI agent key redaction safe on short keys (H1)
- CAAMP library-loader.ts TS2352 type cast fix
- workflow-executor.ts unused variable build errors
- Test assertions updated for conduit transport layer (Circle of Ten remains 10 domains)
- Audit test mock updated for agentCredentials schema export
- Message dedup P0 fixed server-side by signaldock-core-agent
- Biome lint: 24 errors resolved (all types from @cleocode/contracts, zero any)
- Ferrous Forge: 4 violations resolved (cant-core file splits)
- CI pipeline: 5 layers of failures fixed (lint, lockfile, build order)
- AgentRegistryAccessor drizzle type mismatch (8 TS errors eliminated)

### Changed
- Default API URL: `api.clawmsgr.com` → `api.signaldock.io` (legacy endpoint stays in parallel)
- `packages/core/src/signaldock/` removed — replaced by `conduit/` directory
- `cleo agents` deprecated — health monitoring moved to `cleo agent health`
- Conduit JSDoc updated: removed ClawMsgr references, documented Transport implementations
- DATABASE-ARCHITECTURE.md updated for Diesel as sole Rust ORM
- signaldock-storage traits split from monolithic mod.rs (432 lines) to 7 focused files
- Rust workspace version aligned to CalVer 2026.3.76

## [2026.3.70] - 2026-03-23

### Added
- **Brain Memory Automation** (T134 epic, 12 tasks):
  - `BrainConfig` typed configuration section with defaults and templates (T135)
  - Local embedding provider via `@xenova/transformers` all-MiniLM-L6-v2, dynamic import (T136)
  - Embedding worker thread + async queue for non-blocking processing (T137)
  - Memory bridge refresh wired to lifecycle hooks with 30s debounce (T138)
  - Context-aware memory bridge generation using `hybridSearch()` + token budget (T139)
  - Session summarization: dual-mode prompt + structured `SessionSummaryInput` response (T140)
  - Auto-link observations to focused task via `brain_memory_links` (T141)
  - Embedding backfill with progress reporting: `cleo backfill --embeddings` (T142)
  - Brain maintenance command: `cleo brain maintenance` with `--skip-decay`, `--skip-consolidation`, `--skip-embeddings` (T143)
  - Cross-provider transcript hook on `AdapterHookProvider` + Claude Code adapter implementation (T144)
  - Updated CLEO-INJECTION.md templates with Memory Automation section (T145)
  - Updated CLEO-BRAIN-SPECIFICATION.md to v2.0.0 (T146)

### Dependencies
- Added `@xenova/transformers` ^2.17.2 to `@cleocode/core` (external, dynamic import)

## [2026.3.69] - 2026-03-23

### Fixed
- **npm install**: Use `pnpm publish` to resolve `workspace:*` protocol — `npm publish` leaked workspace references making `npm install -g` fail with EUNSUPPORTEDPROTOCOL

## [2026.3.68] - 2026-03-23

### Added
- **`cleo check` command group**: `cleo check schema|coherence|task` — domain-prefix CLI access to check operations
- **`cleo admin` command group**: `cleo admin version|health|stats|runtime|smoke` — domain-prefix CLI access to admin operations
- **`cleo pipeline` alias**: Routes to existing `phase` command group

### Fixed
- **`cleo add --dry-run` session bypass**: Dry-run no longer requires active session, orphan prevention, or acceptance criteria — no data is written
- **Domain-prefix CLI routing**: `cleo check schema`, `cleo pipeline list`, `cleo admin version` now route correctly instead of showing root help

## [2026.3.67] - 2026-03-23

### Added
- **`cleo doctor --full` (#79, T130)**: Operational smoke test — 13 probes exercise one read-only query per domain through the full dispatch pipeline, plus tasks.db integrity, brain.db connectivity, and migration state validation. ~100ms runtime, exit code 0/1
- **`cleo upgrade --diagnose` (#80, T131)**: Deep read-only inspection of schema and migration state — validates required columns, migration journal entries, SQLite integrity, brain.db tables. Skipped steps now explain WHY with `reason` field

### Changed
- **Unified migration system (#82, T132)**: Shared `migration-manager.ts` consolidates duplicated reconciliation, bootstrap, retry, and column-safety logic from `sqlite.ts` and `brain-sqlite.ts` — ~170 lines dedup
- **Upgrade output**: `UpgradeResult` now includes `summary` (checked/applied/skipped/errors) and `reason` on skipped actions
- **Admin domain**: New `admin.smoke` query operation (tier 0)

### Fixed
- **Doctor/upgrade opts merging**: citty-parsed command-specific flags (`--full`, `--diagnose`, `--detailed`, etc.) were silently ignored because action handlers called `parseGlobalFlagsFromArgv()` which only extracts global flags. Now merges both sources

## [2026.3.66] - 2026-03-23

### Changed
- **Config type safety (T128)**: `EnforcementConfig` + `VerificationConfig` interfaces wired into `CleoConfig` — eliminates untyped `getRawConfigValue` dot-path access in enforcement.ts, complete.ts, add.ts
- **Retry dedup (T129)**: `agents/retry.ts withRetry` delegates to `lib/retry.ts` — single backoff implementation, dead `sleep()` removed

### Fixed
- **Facade domain count**: Updated from "10 domains" to "12 domain getter properties" (agents + intelligence added in v2026.3.60)
- **Missing barrel exports**: Added `AgentsAPI`, `IntelligenceAPI`, `getCleoTemplatesTildePath`, `updateProjectName` to public barrel

## [2026.3.65] - 2026-03-23

### Fixed
- **Phases crash (#77)**: Full null guard in `queryPhase()` — `listData.phases` and `listData.summary` now use `??` fallbacks
- **detect-drift user projects (#78)**: Detects CLEO source repo vs user projects. User projects get applicable checks only (injection template) instead of CLEO-internal source structure checks

## [2026.3.64] - 2026-03-23

### Fixed
- **Phases crash (#77)**: `paginate()` now guards against undefined/null/empty input arrays
- **detect-drift false errors (#78)**: Uses `process.cwd()` as project root instead of walking up from the CLI bundle file location

## [2026.3.63] - 2026-03-23

### Fixed
- **brain.db migration (#65, #71)**: Journal reconciliation now correctly applied — was lost in v2026.3.62 due to git stash conflict
- **--dryRun on cleo add (#66)**: `dryRun` flag now passed through dispatch domain → engine → `addTask()` core — previously silently dropped
- **backup list side effect (#74)**: Query gateway handler now properly included in build — read-only `listSystemBackups()` prevents snapshot creation
- **Help text leak regression (#76)**: Parent command `run()` now detects subcommand in `rawArgs` before showing help — prevents `showUsage()` from firing after valid subcommand output

### Added
- **session find CLI (#75)**: Re-added after loss in v2026.3.62 — dispatches to existing `query:session.find` MCP operation

## [2026.3.62] - 2026-03-23

### Fixed
- **Migration journal reconciliation (#63, #65)**: `runMigrations()` in tasks.db and brain.db now detects stale `__drizzle_migrations` entries from older CLEO versions (hash mismatch), clears them, and marks local migrations as applied
- **Defensive column safety net (#63)**: `ensureRequiredColumns()` runs after every migration — uses `PRAGMA table_info` to detect and add missing columns via `ALTER TABLE`
- **Issue command routing (#64)**: `cleo issue bug/feature/help` calls `addIssue()` from core directly instead of dispatching to removed MCP operations
- **brain.db migration (#65, #71)**: Same journal reconciliation pattern applied to brain.db — unblocks `memory find`, `observe`, `sticky`, `refresh-memory`, and `reason similar`
- **--dryRun flag (#66)**: `cleo add --dryRun` now returns preview with `id: T???` before sequence allocation — no DB writes or counter advancement
- **Labels empty output (#67)**: `labels list` marked as `isDefault` subcommand — bare `cleo labels` now invokes list
- **Exists routing (#68)**: `cleo exists` calls `getTask()` from core directly instead of unregistered `query:tasks.exists`
- **Critical-path routing (#69)**: `cleo deps critical-path` calls `depsCriticalPath()` from core directly instead of unregistered `query:orchestrate.critical.path`
- **Silent empty commands (#70)**: Parent commands without subcommand now show help text via citty `showUsage()` — fixes 21 commands that returned zero output
- **Sequence padding (#72)**: `nextId` in `showSequence()` uses `padStart(3, '0')` — returns `T012` not `T12`
- **Stats contradiction (#73)**: `totalCompleted` now uses audit log as SSoT (same source as `completedInPeriod`) for consistent metrics
- **Backup list side effect (#74)**: Changed `backup list` from `mutate` to `query` gateway with new read-only `listSystemBackups()` function

### Added
- **`session find` CLI subcommand (#75)**: MCP operation already existed — added CLI registration with `--status`, `--scope`, `--query`, `--limit` options
- **`repairMissingColumns()`**: New repair function in `cleo upgrade` that reports missing column detection/fix

### Changed
- **Injection template**: `session find` reference clarified to `cleo session find`

## [2026.3.60] - 2026-03-22

### Fixed
- **Bootstrap injection chain (T124)**: Legacy `~/.cleo/templates/` now synced on every install — fixes stale injection for projects referencing old path
- **CAAMP corruption**: `sanitizeCaampFile()` cleans orphaned fragments and duplicate markers from `~/.agents/AGENTS.md` before inject()
- **Post-bootstrap health check**: `verifyBootstrapHealth()` Step 7 validates injection chain integrity
- **`checkGlobalTemplates`**: Now checks version sync between XDG and legacy template paths

### Added
- **Facade: `sessions.start({ startTask })` (T125)**: Bind session + task in one call for CleoOS
- **Facade: `tasks.start/stop/current` (T126)**: TasksAPI exposes task-work methods via facade
- **Facade: `cleo.agents` getter (T127)**: AgentsAPI with 8 methods (register, deregister, health, detectCrashed, recordHeartbeat, capacity, isOverloaded, list)
- **Facade: `cleo.intelligence` getter (T127)**: IntelligenceAPI with 2 methods (predictImpact, blastRadius)

## [2026.3.59] - 2026-03-22

### Added
- **Agent health monitoring**: `cleo agents health` — heartbeat, stale/crash detection (T039, 25 tests)
- **Retry utility**: `withRetry()` exponential backoff in `lib/retry.ts` (T040, 16 tests)
- **Agent registry**: Capacity tracking, specializations, performance recording (T041, 21 tests)
- **Impact prediction**: `cleo reason impact --change <text>` — dependency analysis (T043)
- **Reasoning CLI**: `cleo reason why|similar|impact|timeline` — CLI parity (T044)
- **SharingStatus**: Git sync fields for Nexus visibility (T110)

### Changed
- **Config vaporware audit (T101)**: Removed ~170 dead config fields across schema/templates/presets
- **Strictness presets**: Fixed phantom `hierarchy.requireAcceptanceCriteria` key (T107)

### Assessed
- **Nexus**: Zero production usage — deferred to Phase 3 (T045)

## [2026.3.58] - 2026-03-22

### Added
- **Enforcement gates**: Session required for mutations, AC required on creation (min 3), verification gates required for completion, orphan tasks blocked (must have parent epic) — all in strict mode
- **Pipeline stage binding**: RCASD-IVTR+C auto-assignment, forward-only transitions (T060)
- **Verification gate auto-init**: Tasks get verification metadata on creation (T061)
- **Epic lifecycle enforcement**: Min 5 AC, child stage ceiling, advancement gates (T062)
- **Workflow compliance telemetry**: `cleo stats compliance` dashboard (T065)
- **Task backfill**: `cleo backfill [--dry-run]` for existing tasks (T066)
- **Strictness presets**: `cleo config set-preset strict|standard|minimal` (T067)
- **Agent dimension**: Execution learning, self-healing patterns (T034)
- **Intelligence dimension**: Adaptive validation, confidence scoring (T035)
- **ERD diagrams**: Mermaid ERDs for all 3 databases (T036)
- **Skills updated**: Mandatory workflow rules WF-001 through WF-005 (T063)
- **ct-validator skill**: Gate enforcement skill (T064)
- **Agent code quality rules**: Added to AGENTS.md for all subagents

### Fixed
- CTE column mismatch (#61): Rewritten to column-independent ID-only pattern
- Table constraint loss (#62): Migration uses proper CREATE TABLE with constraints
- Session FK ordering: Insert new session before updating predecessor.nextSessionId
- `closeDb()` production bug: Now resets `_initPromise` to prevent stale connections
- `tasks.add` dispatch: acceptance, phase, size, notes, files params now passed through
- `--acceptance` delimiter: Changed from comma to pipe for AC items with commas
- Config templates: enforcement/verification/lifecycle fields added with strict defaults
- `complete.ts` defaults: Corrected from warn→block, off→strict
- Test infrastructure: 141→0 test failures via centralized VITEST enforcement bypass
- Schema hardening: 9 composite indexes, 17 soft FKs hardened, PRAGMA foreign_keys=ON

### Changed
- Config templates ship with 100% strict enforcement defaults
- `loadCompletionEnforcement` honors explicit config values in test mode

## [2026.3.57] (2026-03-21)

### Fixed
- Remove install-global hints from self-update (postinstall handles bootstrap)
- Template version bumped to 2.2.0 for refresh verification
- Remove packageRoot override from install-global and postinstall

## [2026.3.56] (2026-03-21)

### Fixed
- **Template refresh on install**: install-global and postinstall were passing packageRoot pointing to @cleocode/cleo, but templates live in @cleocode/core. Bootstrap now resolves from core getPackageRoot() without override.

## [2026.3.55] (2026-03-21)

### Fixed
- **CRITICAL: CLEO-INJECTION.md template was stale in npm package** — agents received old MCP-first template with deprecated `memory brain.search` operations. Template now correctly shows CLI-first, `memory find`, Runtime Environment section, and actual CLI command syntax.
- **CLI command syntax in template** — changed from wrong `cleo <domain> <operation>` to actual flat commands (`cleo find`, `cleo current`, `cleo dash`, etc.)
- **Session quick reference** — now shows CLI as primary with MCP fallback
- **Memory examples** — CLI-first (`cleo memory find "auth"` not MCP query)

## [2026.3.54] (2026-03-21)

### Changed
- **Dynamic template paths**: All `@` references in AGENTS.md now use `getCleoTemplatesTildePath()` — resolves to OS-appropriate XDG path (`~/.local/share/cleo/templates` on Linux, `~/Library/Application Support/cleo/templates` on macOS). No more hardcoded `~/.cleo/templates/`.
- **`getCleoTemplatesTildePath()`**: New path function that returns the templates dir as a `~`-prefixed string for cross-platform `@` references.

### Fixed
- **Template path mismatch**: AGENTS.md referenced `~/.cleo/templates/` but templates live at XDG path (`~/.local/share/cleo/templates/`). Now both reference and storage use the same dynamic path.

## [2026.3.53] (2026-03-21)

### Fixed
- **Global config.json**: Created from `global-config.template.json` during `ensureGlobalHome()` if missing.
- **Stale `templates/templates` symlink**: Added to STALE_GLOBAL_ENTRIES — was pointing to dev source in old installs.
- **Stale `.install-state/`**: Added to cleanup list.

## [2026.3.52] (2026-03-21)

### Fixed
- **Global scaffold cleanup works**: Was cleaning XDG path (`~/.local/share/cleo/`) but stale dirs were at legacy `~/.cleo/` path. Now cleans both locations.
- **CAAMP ^1.8.1**: Consolidates pre-existing duplicate blocks natively. Removed workaround that stripped all CAAMP blocks before inject.

## [2026.3.51] (2026-03-21)

### Fixed
- **Postinstall bootstrap import**: Fall back from `@cleocode/core/internal` (multi-file) to `@cleocode/core` (esbuild bundle) — `dist/internal.js` doesn't exist in published package.
- **bootstrapGlobalCleo exported from public barrel**: Now available via `@cleocode/core` import, not just `@cleocode/core/internal`.

## [2026.3.50] (2026-03-21)

### Fixed
- **Postinstall detection**: Replaced broken `process.argv[1]` check with `npm_config_global`, `lib/node_modules` path check, and pnpm workspace marker detection.
- **Postinstall import path**: Changed from broken `../dist/core/bootstrap.js` to `@cleocode/core/internal` which resolves correctly in published package.
- **esbuild bundle dynamic import**: Changed `ensureGlobalHome()` from dynamic import to static import so esbuild includes it in the single-file bundle.
- **Global scaffold cleanup**: Now actually runs during bootstrap — removes stale project-level dirs from `~/.cleo/`.

## [2026.3.49] (2026-03-20)

### Fixed
- **CAAMP block duplication**: Strip ALL existing CAAMP blocks before inject() — workaround for CAAMP not consolidating pre-existing duplicates (CAAMP issue #48)
- **Global scaffold cleanup**: Bootstrap now calls `ensureGlobalHome()` which removes stale project-level dirs from `~/.cleo/`
- **Stale cleo-subagent symlink**: Now detects symlinks pointing to wrong target and recreates them pointing to the npm package path

## [2026.3.48] (2026-03-20)

### Added
- **`cleo detect` command**: Standalone lightweight re-detection of project type. Updates project-context.json without full init or upgrade.
- **`cleo upgrade --detect`**: Force re-detection ignoring staleness schedule.
- **`cleo upgrade --map-codebase`**: Run full codebase analysis and store findings to brain.db.
- **`cleo upgrade --name <name>`**: Programmatically update project name in project-info.json and nexus registry.
- **`updateProjectName()`**: Core function in project-info.ts (SSoT for project name updates).

### Changed
- **init/upgrade boundary**: `--update-docs` removed from init. All maintenance goes through `cleo upgrade`.
- **`--refresh` alias removed** from init (keep flags simple, `--detect` only).
- **Fix hints** across injection.ts and doctor/checks.ts now say `cleo upgrade` instead of `cleo init --update-docs`.

### Fixed
- **CLI version**: Now reads from package.json at runtime instead of build-time constant.
- **stripCLEOBlocks**: Handles versioned legacy markers (`<!-- CLEO:START v0.53.4 -->`).
- **Global scaffold cleanup**: Removes stale project-level dirs from `~/.cleo/` on bootstrap.
- **cleo-subagent symlink**: Installed via `bootstrapGlobalCleo` using `require.resolve` for npm package path.

## [2026.3.47] (2026-03-20)

### Fixed
- **CLI version** reports runtime package.json version instead of build-time constant
- **stripCLEOBlocks** handles versioned legacy markers (`<!-- CLEO:START v0.53.4 -->`)
- **Global scaffold cleanup** removes stale project-level dirs from `~/.cleo/` on bootstrap (adrs, rcasd, agent-outputs, backups, sandbox, tasks.db, schemas, bin)
- **cleo-subagent symlink** installed via `bootstrapGlobalCleo` using `require.resolve` for npm package path
- **Bootstrap regex** fixed in both inline copies in bootstrap.ts

## [2026.3.46] (2026-03-20)

### Fixed
- **MCP `tasks.find` E_NOT_INITIALIZED** (T073): All 10 domain handlers deferred `getProjectRoot()` from constructor to request time, fixing initialization failures in MCP transport.
- **MCP `session.start --scope global` rejected** (T074): Fixed broken regex in `operation-gate-validators.ts` that required `global:` (with colon) instead of accepting bare `"global"`.
- **Bare catch blocks in task-engine.ts** (T073): `taskFind` and `taskList` now properly distinguish `E_NOT_FOUND`, `E_INVALID_INPUT`, and `E_NOT_INITIALIZED` errors instead of masking all as initialization failure.
- **681 duplicate CAAMP blocks in `~/.agents/AGENTS.md`** (T084): Upgraded to CAAMP v1.8.0 with native idempotent `inject()`. Removed workaround guards.
- **skill-paths.ts CAAMP path bug** (T085): Was using `getAgentsHome()` instead of `getCanonicalSkillsDir()`, causing skill resolution to look in wrong directory.
- **Broken cleo-subagent symlink**: Fixed stale symlink pointing to dev source path.

### Changed
- **CLI-First Pivot** (T078): All skills (ct-cleo, ct-orchestrator, ct-memory) now show CLI as primary channel, MCP as fallback.
- **Dependency Consolidation**: `@cleocode/core` now bundles adapters, skills, and agents as workspace deps. `@cleocode/cleo` slimmed to core + MCP SDK + citty only.
- **CAAMP ^1.8.0**: Idempotent `inject()`, `ensureProviderInstructionFile()` API, skill lock file support.
- **LAFS ^1.8.0**: Updated protocol dependency.
- **Templates/schemas moved into `packages/core/`**: No longer symlinked from root. Shipped in npm package via `getPackageRoot()`.
- **Global scaffold cleanup**: Removed project-level dirs (`adrs/`, `rcasd/`, `agent-outputs/`, `backups/`, `tasks.db`) from `~/.cleo/`. Schemas read from npm binary at runtime.
- **Skills install global-only**: Skills installation moved from project `init` to global bootstrap only.
- **Windows symlink support**: Directory symlinks use `junction` type on Windows.
- **Injection chain**: Project AGENTS.md now references `@~/.agents/AGENTS.md` (global hub) instead of template directly.
- **CleoOS detection**: CLEO-INJECTION.md includes `${CLEO_RUNTIME:-standalone}` mode with channel routing table.

### Added
- **Skills-registry validator** (T079): `packages/skills/scripts/validate-operations.ts` — automated drift detection between skills and canonical registry.
- **Capability matrix SSoT** (T076): Merged `capability-matrix.ts` + `routing-table.ts` into single source with 211 operations, required `preferredChannel` field.

### Removed
- `cleoctl` binary alias (stale separation-era artifact).
- `injection-legacy.ts` and its test (mapped CLAUDE.md/GEMINI.md — no longer valid).
- Root `templates/` and `schemas/` directories (moved into `packages/core/`).
- 30+ deprecated operation references across skills (`research` domain, `memory.brain.*`, `system` domain, `tasks.exists`, `admin.grade`).

## [2026.3.45] (2026-03-20)

### Added
- **Nexus Task Transfer** (T046): Cross-project task transfer with `nexus.transfer` (mutate) and `nexus.transfer.preview` (query) operations. Supports copy/move modes, subtree/single scope, bidirectional `external_task_links` with `'transferred'` link type, brain observation transfer, provenance tracking, and conflict resolution strategies.
- `importFromPackage()` — extracted from `importTasksPackage()` for in-memory ExportPackage import without file I/O.
- 19 new transfer test cases covering copy/move modes, ID remapping, hierarchy/dependency preservation, link creation, conflict resolution, and error handling.
- `transfer` verb added to VERB-STANDARDS.md deferred verbs table.

### Fixed
- **Migration path resolution**: `resolveMigrationsFolder()`, `resolveBrainMigrationsFolder()`, and `resolveNexusMigrationsFolder()` now correctly detect bundled (`dist/`) vs source (`src/store/`) context when resolving migration paths. Previously, esbuild-bundled builds would resolve to wrong directory (2 levels up from `dist/` instead of 1).

## [2026.3.44] (2026-03-20)

### Added
- **Agent Dimension** (100%): Agent registry, health monitoring (30s crash detection), self-healing with exponential backoff, capacity tracking and load balancing. New `agent_instances` and `agent_error_log` tables.
- **Intelligence Dimension** (100%): Quality prediction (4-factor risk scoring), pattern extraction from brain.db, impact analysis with BFS/DFS graph traversal and blast radius calculation.
- **Validation Contracts**: 36 canonical Zod enum schemas backed by `as const` constants. 13 table schemas with business logic refinements. 14 hook payload Zod schemas with `validatePayload()` dispatcher.
- **Nexus E2E Tests**: 89 integration tests covering registry, audit, health, permissions, cross-project refs, orphan detection, and discovery. Fixed `extractKeywords()` case handling bug.
- **Schema Integrity**: 3 hard foreign keys (warp_chain_instances CASCADE, sessions prev/next SET NULL), 16 indexes, 1 UNIQUE constraint on external_task_links.
- **Database ERDs**: Mermaid diagrams for all 3 databases (tasks.db, brain.db, nexus.db).
- **Type Contracts Documentation**: Full public API surface (43 namespaces) documented.

### Changed
- **BREAKING**: `TaskFile` interface removed from `@cleocode/contracts`. Use `Task[]` from `DataAccessor.queryTasks()` directly.
- **BREAKING**: `TaskFileExt`, `TaskFileTaskEntry`, `TaskFileMetaExt`, `toTaskFileExt()` removed from sessions module.
- **BREAKING**: `buildPrompt()`, `spawn()`, `spawnBatch()`, `canParallelize()`, `orchestratorSpawnSkill()`, `injectProtocol()`, `buildTaskContext()`, `validateOrchestratorCompliance()`, `validateContributionTask()` are now async. Add `await` at call sites.
- **BREAKING**: `buildExportPackage()`, `exportSingle()`, `exportSubtree()` signatures changed — pass `projectName` in options instead of `TaskFile`.
- Public barrel now exports 43 namespaces (added `agents`, `intelligence`).
- CORE-PACKAGE-SPEC updated to v3.0.0 with section 15.5 documenting all breaking changes.
- Facade API (`Cleo.init()`) is unchanged — no impact on facade consumers.

### Fixed
- **ADR-006 Compliance**: All task/session/focus JSON file reads replaced with DataAccessor → SQLite queries across 7 files (12 functions).
- **Focus Meta Key**: Unified from split `'focus'`/`'focus_state'` to `'focus_state'` everywhere.
- **Pipeline Stage Source**: `computePipelineStage` now queries `lifecycle_pipelines` table directly instead of `file_meta` KV store.
- **Inline Enum Drift**: 4 hardcoded Zod enum arrays extracted to `as const` constants (TASK_RELATION_TYPES, LIFECYCLE_TRANSITION_TYPES, EXTERNAL_LINK_TYPES, SYNC_DIRECTIONS).
- **Type Safety**: `as unknown as` casts reduced from 9 to 4 (remaining are node:sqlite and drizzle-orm library boundaries).
- **Agent Suppressions**: 5 underscore-prefixed params introduced by agents wired into real implementations.

### Removed
- `tasks/reparent.ts` — dead code; `task-ops.ts` has the DataAccessor-based implementation.
- `getSessionsPath()` — zero callers remaining (sessions are in SQLite).
- All `sessions.json`, `tasks.json`, `focus.json` file reads from non-migration code.

## [2026.3.43] (2026-03-19)

### Fixed
- **Build**: Generate `.d.ts` type declarations in `build.mjs` via `tsc --emitDeclarationOnly` after esbuild bundling. esbuild produces single-file `.js` bundles but doesn't emit TypeScript declarations, so consumers of `@cleocode/core` and `@cleocode/adapters` were getting packages with no type information.

## [2026.3.42] (2026-03-19)

### Fixed
- **npm Publish**: Add `.npmignore` to all publishable packages. Root `.gitignore` had `dist/` which caused pnpm publish to exclude the entire `dist/` directory (including all `.d.ts` type declarations and sub-module `.js` files) from published tarballs. Consumers got packages with `types` pointing to non-existent files. This was broken since the first publish.

## [2026.3.41] (2026-03-19)

### Fixed
- **Release Workflow**: Fix `cd` navigation bug in npm publish step that caused all packages after the first to fail. Use `pushd`/`popd` for reliable directory handling and tolerate "already published" errors.

## [2026.3.40] (2026-03-19)

### Added
- **Task Reconciliation Engine**: Provider-agnostic external task sync system in `@cleocode/core`. Consumers implement `ExternalTaskProvider` to sync any issue tracker (Linear, Jira, GitHub, GitLab) with CLEO as SSoT.
- **External Task Links**: New `external_task_links` table in tasks.db for DB-backed bidirectional traceability between CLEO tasks and external system tasks.
- **Link Store API**: `createLink`, `getLinksByProvider`, `getLinksByTaskId`, `getLinkByExternalId`, `touchLink`, `removeLinksByProvider` in `@cleocode/core`.
- **Cleo Facade SyncAPI**: `cleo.sync.reconcile()`, `cleo.sync.getLinks()`, `cleo.sync.getTaskLinks()`, `cleo.sync.removeProviderLinks()`.
- **Dispatch Operations**: `tasks.sync.reconcile` (mutate), `tasks.sync.links` (query), `tasks.sync.links.remove` (mutate) — wired through registry, capability matrix, task engine, and domain handler.

### Removed
- **TodoWrite System**: Completely removed all TodoWrite code, types, contracts, CLI commands, dispatch operations, and file-based sync state (`todowrite-session.json`, `todowrite-state.json`).
  - Deleted: `contracts/todowrite.ts`, `core/task-work/todowrite-merge.ts`, `core/admin/sync.ts`, `core/reconciliation/sync-state.ts`, CLI `extract` and `sync` commands, `tools.todowrite.*` dispatch ops and registry entries.
  - Removed `todowrite` export format from `admin/export.ts`.
- **Stale Compiled Artifacts**: Cleaned all `.js`, `.d.ts`, `.js.map`, `.d.ts.map` files for deleted source modules.

### Changed
- **Contracts**: `AdapterTaskSyncProvider` renamed to `ExternalTaskProvider`. `ExternalTask` enriched with `priority`, `type`, `url`, `parentExternalId`. `SyncSessionState` removed (replaced by DB-backed links). `ReconcileResult` gains `updated`, `linksAffected`, `total` counts.
- **DRY requiredParams**: Moved param validation from 13 inline handler checks to `requiredParams` declarations in the dispatch registry for the entire tasks domain.

## [2026.3.39] (2026-03-19)

### Fixed
- **CI/CD Pipeline**: Fixed pnpm version conflict in release workflow, added agents and skills packages to version sync and npm publish
- **Error Handling**: Created central error utilities in contracts package with proper TypeScript types
- **CLI Type Safety**: Completely removed commander-shim, migrated to clean citty-based CLI with zero `any` types
- **CAAMP Integration**: Updated to @cleocode/caamp@1.7.1 with proper exports, removed mock files
- **Documentation**: Added comprehensive README files for root and all packages
- **Code Quality**: Fixed all lint warnings, updated biome.json schema

## [2026.3.38] (2026-03-19)

Auto-prepared by release.ship (T021)

### Chores
- **Migrate parallel-state.json to SQLite**: Move orchestration/parallel.ts state from .cleo/parallel-state.json into SQLite schema_meta or new table. Eliminates JSON clobbering when parallel ... (T022)

### Changes
- **Eliminate _meta.activeSession pointer — use SQL query**: Replace activeSession pointer in file_meta with dynamic SQL: SELECT FROM sessions WHERE status=active. Remove from FileMeta, session-switch, sessio... (T021)
- **Wrap add/update/complete/delete in transaction()**: Wrap full read-validate-write flow in add.ts, update.ts, complete.ts, delete.ts inside accessor.transaction() for TOCTOU safety under concurrent mu... (T023)
- **SQL-level position allocation in add.ts**: Replace JS position computation with SQL: INSERT SELECT COALESCE(MAX(position),0)+1. Eliminates TOCTOU where concurrent adds get same position. (T024)
- **Bulk SQL for task reorder operations**: Replace per-task upsertSingleTask loop with single UPDATE tasks SET position=position+1 WHERE parent_id=? AND position>=?. Eliminates N+1 pattern. (T025)
- **Replace saveSessions(array) with upsertSingleSession**: Make upsertSingleSession required on DataAccessor. Replace all saveSessions bulk writes with per-session targeted writes. Eliminates session array ... (T026)
- **Async background embedding for brain memory**: Make embedding generation in observeBrain fire-and-forget via async queue. Currently synchronous and blocks CLI/Agent during LLM embedding calls. (T027)
- **Memory decay — confidence decay for old memories**: Add decay factor so old unreferenced memory drops from context window. Implement as decay multiplier based on age and reference count. (T028)

[Unreleased]: https://github.com/kryptobaseddev/cleo/compare/v2026.3.59...HEAD
[2026.3.59]: https://github.com/kryptobaseddev/cleo/compare/v2026.3.58...v2026.3.59
[2026.3.58]: https://github.com/kryptobaseddev/cleo/compare/v2026.3.57...v2026.3.58
