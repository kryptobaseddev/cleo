# T10179 Executor npm-pack Probe — Result

**Saga**: T10176 (`SG-BOUNDARY-REGISTRY`)
**Epic**: T10195
**Decision**: D010 (Council Executor verdict)
**Probe script**: `scripts/probes/tools-in-core-probe.mjs`
**Log**: `/tmp/tools-in-core-probe.log`
**Date**: 2026-05-22
**Verdict**: **PASS** (exit code 0) — release-equivalent flow safe; raw npm-pack mode documented as broken-by-design.

---

## 1. Question

Does the tools-in-core pattern (currently embodied by `@cleocode/lafs` +
`@cleocode/cant`) survive a clean `npm pack` → fresh-tmpfs install → `node
require()` flow? If it does NOT, extending the pattern to new domains is
contraindicated until the resolution gaps are filed and fixed.

## 2. Method

The probe is captured as a reusable, idempotent ESM script at
`scripts/probes/tools-in-core-probe.mjs`. Six deterministic steps:

1. **Quote `package.json` fields** — emit `name`, `version`, `main`,
   `dependencies`, `optionalDependencies` from both
   `packages/lafs/package.json` and `packages/cant/package.json` to the log
   so the research artefact records the exact pre-pack state.
2. **Ensure `dist/` exists** — run `pnpm --filter @cleocode/<pkg> run build`
   when missing. Idempotent: skipped if `dist/` already present.
3. **Pack both packages in TWO modes** —
   - Step 3a: `npm pack --json` (raw — does NOT rewrite `workspace:*`).
   - Step 3b: `pnpm pack` (rewrites `workspace:*` to concrete versions,
     mirroring real-release `pnpm publish` behaviour).
4. **Fresh-tmpfs install** — for each mode, `mkdtempSync()` a fresh dir,
   drop a minimal `package.json`, then `npm install --no-package-lock
   --no-audit --no-fund <lafs.tgz> <cant.tgz>`.
5. **`node` smoke require** — `import * as lafs from '@cleocode/lafs'`
   + `import * as cant from '@cleocode/cant'` from the install dir,
   assert non-empty export sets, print `JSON.stringify({ ok, lafsExports,
   cantExports })`.
6. **Cleanup** — remove tarballs + tmpdirs.

Final exit code is **0 iff the release-equivalent (pnpm-pack) mode succeeds
end-to-end**. The raw `npm pack` mode is captured for diagnostic value but
its failure is non-fatal because the real release pipeline emits
`pnpm publish` tarballs, not `npm pack` tarballs.

## 3. Quoted package.json state

### `packages/lafs/package.json`

```json
{
  "name": "@cleocode/lafs",
  "version": "2026.5.101",
  "main": "dist/src/index.js",
  "dependencies": {
    "@a2a-js/sdk": "^0.3.10",
    "ajv": "^8.18.0",
    "ajv-formats": "^3.0.1",
    "express": "^5.2.1"
  },
  "optionalDependencies": {}
}
```

### `packages/cant/package.json`

```json
{
  "name": "@cleocode/cant",
  "version": "2026.5.101",
  "main": "dist/index.js",
  "dependencies": {
    "@cleocode/contracts": "workspace:*",
    "@cleocode/core": "workspace:*",
    "@cleocode/lafs": "workspace:*"
  },
  "optionalDependencies": {}
}
```

### `packages/lafs/src/native-loader.ts` (native-addon strategy)

The LAFS package does **not** declare `optionalDependencies`. The Rust
napi-rs binding (`@cleocode/lafs-native`) is loaded via a runtime
`createRequire(import.meta.url)` `try/catch`, with an automatic AJV
fallback when the binding is unavailable. This is intentional: the AJV
fallback is faithful for every conformance check, so the package is
fully functional on any platform without the native addon.

`packages/cant/src/native-loader.ts` follows the same pattern: a
platform-keyed lookup of `napi/cant.<triple>.node` first, then a
dev-mode workspace fallback to `crates/cant-napi/index.cjs`, then `null`
on failure (with explicit `throw` in `requireNative()` if a caller hits
that path).

## 4. Exit codes

| Mode        | Install exit | Tarball ships         | Verdict                                          |
|-------------|--------------|------------------------|--------------------------------------------------|
| `npm pack`  | **1**        | `workspace:*` LITERAL  | **FAIL** — `EUNSUPPORTEDPROTOCOL workspace:*`    |
| `pnpm pack` | **0**        | Concrete `2026.5.101`  | **PASS** — install + require succeed end-to-end  |

Smoke output from the passing run:

```json
{"ok":true,"lafsExports":110,"cantExports":46}
```

## 5. Headline finding

**The tools-in-core pattern survives a clean install IFF the release artefact
is produced by `pnpm pack` / `pnpm publish` (NOT raw `npm pack`).**

The npm-pack failure is not a bug in lafs / cant — it is a fundamental
limitation of `npm` itself: npm does not understand the `workspace:*`
protocol marker that pnpm injects to express intra-monorepo dependencies.
The CLEO release pipeline already uses `pnpm publish` (confirmed by
`npm view @cleocode/cant@latest dependencies` returning the concrete
versions `{"@cleocode/core":"2026.5.101","@cleocode/lafs":"2026.5.101",
"@cleocode/contracts":"2026.5.101"}`), so production consumers receive
correctly-rewritten manifests.

## 6. Sub-tasks filed

**None.** The release-equivalent flow passes. No blocking sub-tasks
required under T10195.

The npm-pack mode failure is documented here as a known footnote: any
contributor who runs `npm pack <pkg>` locally and tries to install the
result will hit `EUNSUPPORTEDPROTOCOL`. The probe script makes this
visible up-front so the next contributor does not lose time
re-diagnosing it.

## 7. Implication for SAGA T10176 scope

**Tools-in-core pattern is safe to extend to new domains.**

Because the release-equivalent flow passes, the pattern (workspace
packages with cross-workspace deps + lazy-loaded native addons via
`try/catch` instead of `optionalDependencies`) is structurally sound.
The two existing packages serve as the reference template for any
future domain that wants to be extracted from `packages/core/`.

Constraints any future extraction MUST inherit from the lafs+cant
template:

- **Lazy-load native addons via runtime `try/catch` in a
  `native-loader.ts`** — do NOT declare an `optionalDependencies` entry
  pointing to a not-yet-published platform-suffix package, because that
  invites publish-time circular-version issues and yields no resolution
  benefit (npm's `optionalDependencies` only suppresses install-failure;
  it does not enable graceful fallback inside the consuming module).
- **Ship a pure-JS fallback** so the package is useful on every
  supported platform without the native binding present (lafs ships AJV
  fallback; cant throws a clear "build it with `cargo build`" error
  with no fallback today — this is documented but the bar for new
  domains should be a real fallback unless explicitly waived).
- **Workspace deps are fine** because `pnpm pack` / `pnpm publish`
  rewrites them. Do NOT advise contributors to use `npm pack` for any
  publish-equivalent verification.

T10176 scope can therefore proceed unchanged — the foundational
probe-finding does not contraindicate the saga's extension plans.

## 8. Reproduction

```bash
node scripts/probes/tools-in-core-probe.mjs
# Exit 0 indicates the release-equivalent flow is healthy.
# Exit 3 = install failure (release-equivalent mode broken — investigate).
# Exit 4 = require/smoke failure (entry points / exports broken — investigate).
# Logs land at /tmp/tools-in-core-probe.log
```

The probe is idempotent — successive runs reuse `dist/` outputs when
present, so the per-invocation overhead after a cold first run is the
two `pack` calls plus the two `npm install` calls (typically &lt; 5 s on
a warm cache).
