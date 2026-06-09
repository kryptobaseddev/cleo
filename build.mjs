#!/usr/bin/env node

/**
 * esbuild configuration for the @cleocode monorepo.
 *
 * Produces three bundles:
 *   1. packages/core/dist/index.js     — core standalone (npm publish)
 *   2. packages/cleo/dist/cli/index.js — CLI entry point (npm publish)
 *   3. packages/adapters/dist/index.js — adapters bundle
 *
 * NOTE: there is no MCP runtime bundle. MCP is not a first-class CleoOS
 * primitive; see ADR-035 §D4 (Option Y addendum) for the rationale.
 *
 * AUTO-SYNC GUARD (T948 / subpath-contract)
 * -----------------------------------------
 * `validateCoreEntryPoints()` is called at the top of `build()`. It reads
 * packages/core/package.json exports and asserts that every non-wildcard
 * subpath whose `import` condition resolves to a concrete `dist/*.js` file
 * has a matching entry in `coreBuildOptions.entryPoints`. The check fails
 * the build with an actionable error message if a gap exists, making the
 * class of bug that caused the CI failure in v2026.4.100 impossible to
 * ship silently.
 */

import * as esbuild from 'esbuild';
import { chmod, cp, mkdir, rm, readFile, writeFile } from 'node:fs/promises';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { resolve, dirname, join, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { depsFor } from './scripts/build-deps.mjs';

// ---------------------------------------------------------------------------
// Auto-scan: build core entry points by scanning the source tree rather than
// maintaining a hand-written list. Add a new .ts file to any of the dirs
// listed in SUBPATH_DIRS and it will be picked up automatically.
//
// Conventions enforced by the scanner:
//   - .d.ts and .test.ts files are always excluded
//   - daemon-entry.ts files ARE included (spawned as standalone processes)
//   - Subdirectories are skipped UNLESS they appear in SUBPATH_SUBDIRS
//   - SUBPATH_SUBDIRS entries like 'nexus/api-extractors' are scanned one
//     level deep and emitted with the subdir path preserved in `out`
// ---------------------------------------------------------------------------

/**
 * Top-level subdirectories of packages/core/src/ that are exposed as subpath
 * exports. Each dir is scanned one level deep (direct .ts files only).
 */
const SUBPATH_DIRS = [
  // T9887 — packages/core/src/config/registry.ts is exposed via the
  // ./config/registry subpath export for `cleo config` (Saga T9855 E4).
  'config',
  // T9886 — packages/core/src/templates/registry.ts is exposed via the
  // ./templates/registry subpath export for `cleo templates` (Saga T9855 E4).
  'templates',
  'sentient',
  'gc',
  'doctor',
  'memory',
  'tasks',
  // T10124 / Saga T10113 — packages/core/src/sagas/ hosts the saga ops
  // (create/add/list/members/rollup) imported by the CLI dispatch handler.
  'sagas',
  'sessions',
  'setup',
  'status',
  'nexus',
  'lifecycle',
  'conduit',
  'harness',
  'store',
  'system',
  'agents',
  'docs',
  'orchestration',
  'verification',
  'formatters',
  'events',
  'llm',
  // T9740 Wave C: caamp imports `@cleocode/core/skills/skill-root.js` so the
  // `./skills/*` subpath export must emit physical .js files (not just .d.ts).
  'skills',
  // T10451 (PR #759): packages/cleo/src/cli/commands/hygiene.ts + release.ts
  // import @cleocode/core/hygiene/validate-spawn-readiness.js so the
  // `./hygiene/*` subpath must be scanned for esbuild entry points.
  'hygiene',
  // T10575 — public WorkGraph boundary exposed as @cleocode/core/workgraph.
  'workgraph',
  // T11514 (E4-T3) — @cleocode/core/db subpath for dual-scope DB chokepoint
  // (openDualScopeDb + idempotent helpers, SG-DB-SUBSTRATE-V2 · T11247).
  'db',
  // T11920 (M5/AC2) — @cleocode/core/gateway-client subpath for the single
  // generated SDK client over the /v1 REST gateway (E-API-STANDARD-FOUNDATION
  // T11769). `index.ts` bundles the hand-written `createCleoClient` wrapper plus
  // the transitively-imported generated client under `gateway-client/generated/`.
  'gateway-client',
];


/**
 * Explicit nested subdirectories that also need their files scanned.
 * Key: relative path from packages/core/src/ (used as the `out` prefix).
 * Value: absolute source directory path.
 */
const SUBPATH_SUBDIRS = {
  'nexus/api-extractors': 'packages/core/src/nexus/api-extractors',
  'llm/provider-registry': 'packages/core/src/llm/provider-registry',
  'llm/provider-registry/builtin': 'packages/core/src/llm/provider-registry/builtin',
  'llm/oauth': 'packages/core/src/llm/oauth',
  'llm/transports': 'packages/core/src/llm/transports',
  'llm/generated': 'packages/core/src/llm/generated',
  'llm/backends': 'packages/core/src/llm/backends',
  'memory/context-engines': 'packages/core/src/memory/context-engines',
  'setup/sections': 'packages/core/src/setup/sections',
};

/**
 * Root-level flat files in packages/core/src/ that need standalone entries
 * (in addition to index.ts which is always included).
 */
const ROOT_FLATS = [
  'cleo.ts',
  'contracts.ts',
  'internal.ts',
  // R10-L2 (T11581) — thin submodule re-exports of internalized workspace
  // packages, exposed as @cleocode/core/<pkg> subpaths (batteries-included
  // prep). Each `export * from '@cleocode/<pkg>'` bundles to a flat dist file;
  // validateCoreEntryPoints() asserts the matching package.json export entry.
  'paths-export.ts',
  'lafs-export.ts',
  'skills-export.ts',
  'caamp-export.ts',
  'worktree-export.ts',
  'git-shim-export.ts',
];

/**
 * Collect all @cleocode/core esbuild entry points by scanning the source
 * tree. Returns an array of `{ in, out }` objects suitable for esbuild's
 * `entryPoints` option.
 *
 * @returns {{ in: string; out: string }[]}
 */
/**
 * T9184: Sanitize .js.map files to strip CI runner absolute paths from sources.
 * @param {string} outDir - Output directory to sanitize.
 */
async function sanitizeSourcemaps(outDir) {
  const absOutDir = resolve(__dirname, outDir);
  const walk = async (dir) => {
    let entries; try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) { await walk(full); continue; }
      if (!entry.isFile() || !entry.name.endsWith('.js.map')) continue;
      try {
        const raw = await readFile(full, 'utf8'); const map = JSON.parse(raw);
        if (!Array.isArray(map.sources)) continue;
        let changed = false;
        map.sources = map.sources.map((src) => { if (typeof src !== 'string' || !isAbsolute(src)) return src; changed = true; return relative(dir, src); });
        if (changed) await writeFile(full, JSON.stringify(map));
      } catch {}
    }
  };
  await walk(absOutDir);
}

function collectCoreEntryPoints() {
  /** @type {{ in: string; out: string }[]} */
  const entries = [{ in: 'packages/core/src/index.ts', out: 'index' }];

  // Scan each top-level subpath directory (one level deep, no subdirs)
  for (const dir of SUBPATH_DIRS) {
    const srcDir = `packages/core/src/${dir}`;
    if (!existsSync(srcDir)) continue;
    const files = readdirSync(srcDir, { withFileTypes: true });
    for (const f of files) {
      if (f.isDirectory()) continue;
      if (!f.name.endsWith('.ts')) continue;
      if (f.name.endsWith('.d.ts') || f.name.endsWith('.test.ts')) continue;
      const base = f.name.replace(/\.ts$/, '');
      entries.push({ in: `${srcDir}/${f.name}`, out: `${dir}/${base}` });
    }
  }

  // Scan explicit nested subdirectories
  for (const [outPrefix, srcDir] of Object.entries(SUBPATH_SUBDIRS)) {
    if (!existsSync(srcDir)) continue;
    const files = readdirSync(srcDir, { withFileTypes: true });
    for (const f of files) {
      if (f.isDirectory()) continue;
      if (!f.name.endsWith('.ts')) continue;
      if (f.name.endsWith('.d.ts') || f.name.endsWith('.test.ts')) continue;
      const base = f.name.replace(/\.ts$/, '');
      entries.push({ in: `${srcDir}/${f.name}`, out: `${outPrefix}/${base}` });
    }
  }

  // Root-level flat files
  for (const f of ROOT_FLATS) {
    const srcPath = `packages/core/src/${f}`;
    if (existsSync(srcPath)) {
      entries.push({ in: srcPath, out: f.replace(/\.ts$/, '') });
    }
  }

  return entries;
}

const __dirname = dirname(fileURLToPath(import.meta.url));

const isWatch = process.argv.includes('--watch');
const pnpmCmd = 'pnpm';
const spawnPnpmOptions = process.platform === 'win32' ? { shell: true } : {};

function spawnPnpm(args, options = {}) {
  return spawn(pnpmCmd, args, {
    ...options,
    ...spawnPnpmOptions,
  });
}

// ---------------------------------------------------------------------------
// Shared externals — these are NOT bundled, consumers install them separately
// ---------------------------------------------------------------------------
// ALL npm dependencies are external — only @cleocode/* workspace packages are bundled inline.
// This matches the old repo pattern: npm deps are imported at runtime from node_modules.
const sharedExternals = [
  // T1178 (W3-2+W3-6): @cleocode/core is now truly external — the cleo CLI
  // imports it at runtime from node_modules (workspace symlink in dev,
  // peer dependency in published installs). Removing it from the inline map
  // below and adding it here makes esbuild emit `import` statements rather
  // than inlining the full 16 MB source tree.
  '@cleocode/core',
  /^@cleocode\/core\//,
  'proper-lockfile',
  'write-file-atomic',
  'pino',
  'pino-roll',
  'pino-pretty',
  'drizzle-orm',
  'ajv',
  'ajv-formats',
  'env-paths',
  'yaml',
  'zod',
  'js-tiktoken',
  // `ai` (Vercel AI SDK) is loaded via dynamic `import('ai')` in nexus CLI to
  // power LoOM providers. Externalize so esbuild doesn't try to inline the
  // large provider matrix — resolved at runtime from node_modules. (T1013)
  'ai',
  '@cleocode/caamp',
  '@cleocode/lafs',
  // @huggingface/transformers (ex-@xenova/transformers) pulls in native
  // onnxruntime-node (.node bindings) and sharp — both must stay external
  // so esbuild doesn't try to inline the native addons.
  '@huggingface/transformers',
  // tree-sitter native Node addon + grammar packages — must stay external
  // because .node binaries cannot be inlined by esbuild. Resolved at runtime
  // from node_modules via createRequire() in packages/nexus/src/code/parser.ts.
  'tree-sitter',
  'tree-sitter-javascript',
  'tree-sitter-typescript',
  'tree-sitter-python',
  'tree-sitter-go',
  'tree-sitter-rust',
  'tree-sitter-java',
  'tree-sitter-c',
  'tree-sitter-cpp',
  'tree-sitter-ruby',
  // node-cron v4 uses CJS-style require('events') internally which esbuild would
  // bundle into the ESM output, causing "Dynamic require of events is not supported"
  // at CLI startup. Keep it external so it loads at runtime from node_modules. (T755)
  'node-cron',
  // llmtxt (≥2026.4.13) is an optional runtime dep used throughout docs-ops
  // (blob, similarity, graph, sdk, cli, identity, etc.). It pulls in
  // onnxruntime-node (.node bindings), mssql, and @opentelemetry/api
  // transitively — all must stay external so esbuild does not try to inline
  // the native addons or tsql drivers.
  //
  // The 'llmtxt' bare specifier alone is NOT enough — esbuild resolves deeper
  // subpath imports (llmtxt/wasm/llmtxt_core.js, llmtxt/blob, llmtxt/similarity,
  // etc.) as separate modules unless the pattern is explicit. Without this,
  // the CJS-flavoured WASM loader (uses __dirname) gets inlined into the ESM
  // bundle and crashes at boot with ERR_AMBIGUOUS_MODULE_SYNTAX.
  'llmtxt',
  /^llmtxt\//,
  'onnxruntime-node',
  'mssql',
  '@opentelemetry/api',
  // openai SDK bundles node-fetch@2 (CJS) via its node-runtime shim, which calls
  // require("stream") and crashes in an ESM context. Keep openai and its subpaths
  // external so node-fetch never gets inlined into the ESM bundle. (T-THIN-WRAPPER)
  'openai',
  /^openai\//,
  // @google/generative-ai is a runtime dep for the Gemini LLM backend. Externalize
  // to avoid bundling any transitive CJS shims it may carry. (T-THIN-WRAPPER)
  '@google/generative-ai',
  /^@google\/generative-ai\//,
  // @anthropic-ai/sdk similarly should stay external — it's a large SDK that
  // the runtime needs to load from node_modules anyway.
  '@anthropic-ai/sdk',
  /^@anthropic-ai\//,
  // AWS SDK v3 modules — pull in @smithy/* runtime, node:buffer dynamic require,
  // and large transitive CJS shims that crash with "Dynamic require of buffer
  // is not supported" if inlined into the ESM bundle. (T9317)
  '@aws-sdk/client-bedrock-runtime',
  /^@aws-sdk\//,
  '@smithy/types',
  /^@smithy\//,
];

// ---------------------------------------------------------------------------
// Helper: create a plugin that bundles workspace packages inline and
// externalizes everything else.
// ---------------------------------------------------------------------------
function workspacePlugin(name, inlineMap) {
  // Split sharedExternals into exact-match (Set lookup) and regex-match
  // (sequential test). Exact matches are preferred for performance; regex
  // patterns handle subpath imports (e.g. /^llmtxt\// catches llmtxt/blob,
  // llmtxt/wasm/llmtxt_core.js, etc.) that the bare specifier misses.
  const externalExactSet = new Set(
    sharedExternals.filter((e) => typeof e === 'string'),
  );
  const externalRegexes = sharedExternals.filter((e) => e instanceof RegExp);
  const isExternalSpec = (specifier) => {
    if (externalExactSet.has(specifier)) return true;
    for (const re of externalRegexes) if (re.test(specifier)) return true;
    return false;
  };
  return {
    name,
    setup(build) {
      // Resolve @cleocode/* workspace packages to source TypeScript
      build.onResolve({ filter: /^@cleocode\// }, (args) => {
        const mapped = inlineMap[args.path];
        if (mapped) return { path: mapped };
        // Unmapped @cleocode/* → external (e.g. @cleocode/caamp, @cleocode/lafs)
        return { path: args.path, external: true };
      });

      // Only externalize packages in the sharedExternals list (exact or regex)
      // Everything else gets bundled (pino, drizzle-orm, citty, etc.)
      build.onResolve({ filter: /^[a-zA-Z@]/ }, (args) => {
        if (args.path.startsWith('@cleocode/')) return undefined;
        if (isExternalSpec(args.path)) return { path: args.path, external: true };
        // Bundle it
        return undefined;
      });
    },
  };
}

// ---------------------------------------------------------------------------
// 1. @cleocode/core — standalone bundle
//    Bundles @cleocode/contracts inline; all other deps are external.
// ---------------------------------------------------------------------------
/** @type {esbuild.BuildOptions} */
const coreBuildOptions = {
  // Entry points are auto-scanned from the source tree by collectCoreEntryPoints().
  // Add a new .ts file to any dir in SUBPATH_DIRS and it is picked up automatically.
  // validateCoreEntryPoints() below asserts every non-wildcard subpath export in
  // packages/core/package.json has a matching entry produced by this scan.
  entryPoints: collectCoreEntryPoints(),
  bundle: true,
  platform: 'node',
  target: 'node24',
  format: 'esm',
  outdir: 'packages/core/dist',
  // Linked sourcemap (`*.js.map`) without inlined original source. Stack traces
  // still resolve to original `.ts` file:line via Node `--enable-source-maps`,
  // but the published tarball drops from ~633 MB of inlined source to ~50 MB
  // of position-only mappings. Source preview in debuggers is unavailable;
  // users with the source checked out can still step through. Empirically this
  // cuts unpacked tarball size by ~85% with zero loss of stack-trace fidelity.
  sourcemap: 'linked',
  sourcesContent: false,
  sourceRoot: '', // T9184
  plugins: [
    workspacePlugin('bundle-core-deps', {
      '@cleocode/contracts': resolve(__dirname, 'packages/contracts/src/index.ts'),
      // E5/T11392: @cleocode/utils is a pure private leaf (never published). Inline
      // its source into the core bundle so the published @cleocode/core tarball does
      // not emit an external `import '@cleocode/utils'` that npm could not resolve.
      '@cleocode/utils': resolve(__dirname, 'packages/utils/src/index.ts'),
    }),
  ],
};

// ---------------------------------------------------------------------------
// 2. @cleocode/cleo — CLI bundle (MCP removed per MODERN-CLI-STANDARD)
//    Bundles @cleocode/contracts, @cleocode/adapters, @cleocode/nexus,
//    and @cleocode/playbooks inline.
//    @cleocode/core is EXTERNAL (T1178 W3-2+W3-6) — resolved at runtime
//    from node_modules (workspace symlink dev / peer dep published).
// ---------------------------------------------------------------------------
/** @type {esbuild.BuildOptions} */
const cleoBuildOptions = {
  entryPoints: [
    { in: 'packages/cleo/src/cli/index.ts', out: 'cli/index' },
  ],
  bundle: true,
  platform: 'node',
  target: 'node24',
  format: 'esm',
  outdir: 'packages/cleo/dist',
  sourcemap: 'linked',
  sourcesContent: false,
  sourceRoot: '', // T9184
  // T1138: Keep node:sqlite external (unbundled) so it's always imported
  // dynamically at runtime (after banner code runs). If bundled, esbuild
  // converts all dynamic imports to static imports, which fire their warnings
  // during the ESM loader phase (before any code executes).
  external: ['node:sqlite'],
  // NOTE: src/cli/index.ts already carries `#!/usr/bin/env node` — esbuild
  // preserves it into dist when `preserveShebang` semantics apply. If shebang
  // was missing, assert-shebang postbuild would fail the build (T929).
  // T1138: SQLite ExperimentalWarning suppression via process.emitWarning override.
  // Node emits the warning during the ESM module resolution phase. Override
  // process.emitWarning before node:sqlite is imported (which now happens at
  // runtime, not during bundling, because we marked it external).
  banner: {
    js: `(() => {
  const _origEmitWarning = process.emitWarning;
  process.emitWarning = function(warning, type, code, ctor) {
    if (typeof warning === 'object' && warning.name === 'ExperimentalWarning' && typeof warning.message === 'string' && /SQLite is an experimental feature/i.test(warning.message)) {
      return;
    }
    if (typeof warning === 'string' && /SQLite is an experimental feature/i.test(warning)) {
      return;
    }
    return _origEmitWarning.call(process, warning, type, code, ctor);
  };
})();`,
  },
  plugins: [
    workspacePlugin('bundle-cleo-deps', {
      '@cleocode/contracts': resolve(__dirname, 'packages/contracts/src/index.ts'),
      // E5/T11392: inline the pure private @cleocode/utils leaf (never published) so
      // the published CLI bundle carries its source instead of an unresolvable
      // external import. Same rationale as the playbooks/animations inline entries.
      '@cleocode/utils': resolve(__dirname, 'packages/utils/src/index.ts'),
      // @cleocode/core and @cleocode/core/internal are REMOVED from inline map.
      // T1178 (W3-2+W3-6): core is now in sharedExternals — esbuild emits
      // `import` statements and the runtime resolves core from node_modules
      // (workspace symlink in dev, peer dependency in published installs).
      '@cleocode/nexus': resolve(__dirname, 'packages/nexus/src/index.ts'),
      '@cleocode/nexus/internal': resolve(__dirname, 'packages/nexus/src/internal.ts'),
      '@cleocode/adapters': resolve(__dirname, 'packages/adapters/src/index.ts'),
      // T910/T935: playbooks is imported at runtime by
      // packages/cleo/src/dispatch/domains/playbook.ts. Inline its source into
      // the cleo bundle so the published CLI works even if @cleocode/playbooks
      // has not produced a standalone dist/ (v2026.4.94 shipped with no dist,
      // see CHANGELOG v2026.4.95).
      '@cleocode/playbooks': resolve(__dirname, 'packages/playbooks/src/index.ts'),
      // T9011: animations is a workspace-only dep of cleo (animation-bridge.ts).
      // Inline its source so the published CLI works without a separately built
      // animations dist/ — mirrors the same pattern used for @cleocode/playbooks.
      '@cleocode/animations': resolve(__dirname, 'packages/animations/src/index.ts'),
      // T10134: the `./render` subpath ships the static B3 primitives
      // (renderTree, renderTable, renderBadge, etc.) consumed by
      // `cleo tree` and the broader Human Render Contract. Same inline
      // rationale as the bare-package alias above — without this entry,
      // esbuild treats `@cleocode/animations/render` as external and the
      // published CLI breaks at runtime when the animations dist/ is not
      // physically present alongside the cleo bundle.
      '@cleocode/animations/render': resolve(
        __dirname,
        'packages/animations/src/render/index.ts',
      ),
    }),
  ],
};

// ---------------------------------------------------------------------------
// 3. @cleocode/adapters — standalone adapter bundle
// ---------------------------------------------------------------------------
/** @type {esbuild.BuildOptions} */
const adaptersBuildOptions = {
  entryPoints: ['packages/adapters/src/index.ts'],
  bundle: true,
  platform: 'node',
  target: 'node24',
  format: 'esm',
  outfile: 'packages/adapters/dist/index.js',
  sourcemap: 'linked',
  sourcesContent: false,
  sourceRoot: '', // T9184
  plugins: [
    workspacePlugin('bundle-adapters-deps', {
      '@cleocode/contracts': resolve(__dirname, 'packages/contracts/src/index.ts'),
    }),
  ],
};

// ---------------------------------------------------------------------------
// Auto-sync guard: assert every concrete non-wildcard subpath export in
// packages/core/package.json has a matching entry in coreBuildOptions.
//
// Entry points are now auto-scanned (see collectCoreEntryPoints() above).
// This validator is the safety net that catches the case where a subpath is
// added to package.json exports but no matching source file exists in one of
// the scanned directories — producing a missing dist/*.js that would only
// surface as ERR_MODULE_NOT_FOUND in CI on a fresh checkout.
//
// Wildcards (e.g. "./store/*") are skipped — they map to whole directories
// and all files within are already emitted by the scanner.
// ---------------------------------------------------------------------------

/**
 * Derive the expected esbuild `out` key from a package.json export `import`
 * path. Input example: `"./dist/cleo.js"` → `"cleo"`.
 * Returns null for wildcard paths or paths that don't map to a concrete file.
 *
 * @param {string} importPath - The `import` condition value from package.json exports.
 * @returns {string | null}
 */
function exportImportToOut(importPath) {
  // Only handle "./dist/<path>.js" — skip wildcards and anything else
  if (!importPath.startsWith('./dist/') || importPath.includes('*')) return null;
  // Strip ./dist/ prefix and .js suffix
  return importPath.slice('./dist/'.length).replace(/\.js$/, '');
}

/**
 * Validate that every non-wildcard subpath export in packages/core/package.json
 * has a corresponding entry in coreBuildOptions.entryPoints (which is now
 * populated by the auto-scanner collectCoreEntryPoints()).
 *
 * Exits the process with a non-zero code and a descriptive error if any gap is
 * found — makes the T948/v2026.4.100 class of CI failure impossible to ship
 * silently.
 */
function validateCoreEntryPoints() {
  const pkgPath = resolve(__dirname, 'packages/core/package.json');
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
  const exports = pkg.exports ?? {};

  // Build the set of `out` keys produced by the auto-scanner
  const declaredOuts = new Set(
    coreBuildOptions.entryPoints.map((ep) => (typeof ep === 'string' ? ep : ep.out)),
  );

  const missing = [];
  for (const [subpath, conditions] of Object.entries(exports)) {
    // Skip wildcard subpaths — these are directory globs, not concrete files
    if (subpath.includes('*')) continue;
    if (typeof conditions !== 'object' || conditions === null) continue;

    const importPath = conditions.import;
    if (!importPath || typeof importPath !== 'string') continue;

    const out = exportImportToOut(importPath);
    if (out === null) continue; // wildcard or non-dist path

    if (!declaredOuts.has(out)) {
      missing.push({ subpath, importPath, expectedOut: out });
    }
  }

  if (missing.length > 0) {
    console.error('\n[build] ERROR: packages/core/package.json exports has subpaths with no');
    console.error('[build] corresponding esbuild entry point from the auto-scanner.');
    console.error('[build] Either add a source file to one of the scanned SUBPATH_DIRS,');
    console.error('[build] add it to SUBPATH_SUBDIRS, or ensure the file exists at the');
    console.error('[build] expected path. This will produce a broken dist/ on a fresh checkout.\n');
    for (const { subpath, importPath, expectedOut } of missing) {
      console.error(`  subpath: ${subpath}`);
      console.error(`    import: ${importPath}`);
      console.error(`    expected source: packages/core/src/${expectedOut}.ts\n`);
    }
    console.error('[build] Fix the gaps above and re-run the build.\n');
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Build execution
// ---------------------------------------------------------------------------

/**
 * Hard-prereq assertion: throw `E_BUILD_DEP_MISSING` if any declared internal
 * dep's `dist/` directory is absent before we start building `<label>`.
 *
 * Replaces the implicit "wave comments declare ordering" pattern with an
 * explicit data-driven check (T9939). The dep declarations live in
 * `scripts/build-deps.mjs`; if a future refactor reorders waves and breaks
 * the topological invariant, this assertion fires at the wave gate with an
 * actionable error instead of letting tsup explode with a confusing
 * `TS2307: Cannot find module '@cleocode/cant'` deep in rollup-plugin-dts.
 *
 * Skips silently when the label is not in `PACKAGE_DEPS` — only declared
 * deps are checked, never invented ones.
 *
 * @param {string} label - The dist label, e.g. `"packages/caamp/dist/"`.
 * @throws Error with code `E_BUILD_DEP_MISSING` when a declared dep is absent.
 */
function assertDepsReady(label) {
  const deps = depsFor(label);
  if (deps.length === 0) return;
  const missing = deps.filter((dep) => !existsSync(resolve(__dirname, dep)));
  if (missing.length > 0) {
    const err = new Error(
      `E_BUILD_DEP_MISSING: ${label} depends on [${missing.join(', ')}] ` +
        `but their dist/ directories are absent. ` +
        `This indicates a wave-ordering regression in build.mjs — the wave ` +
        `that builds ${label} must run AFTER every wave that builds its deps. ` +
        `See scripts/build-deps.mjs for the canonical dependency declarations.`,
    );
    /** @type {any} */ (err).code = 'E_BUILD_DEP_MISSING';
    throw err;
  }
}

/**
 * Spawn `pnpm --filter <filter> run build` and return a Promise that resolves
 * when the process exits 0 or rejects with a descriptive error on non-zero exit.
 * Timing is logged on success so waves can be compared against the old
 * sequential baseline.
 *
 * Before spawning the child process, asserts that every internal dep declared
 * in `scripts/build-deps.mjs` for this `label` has produced its `dist/`. This
 * is the regression-locked guard for the cant→caamp dep (T9939) and every
 * other inter-package ordering invariant.
 *
 * @param {string} filter - pnpm filter expression (e.g. "@cleocode/lafs")
 * @param {string} label  - human-readable label for log output
 * @returns {Promise<void>}
 */
function buildPkg(filter, label) {
  assertDepsReady(label);
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const proc = spawnPnpm(['--filter', filter, 'run', 'build'], {
      stdio: 'inherit',
      cwd: __dirname,
    });
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`${label} build failed (exit ${code})`));
      } else {
        console.log(`  -> ${label} (${Date.now() - start}ms)`);
        resolve();
      }
    });
  });
}

async function build() {
  // Assert every non-wildcard subpath export in packages/core/package.json
  // has a matching entry in coreBuildOptions.entryPoints. Exits non-zero if
  // any gap is detected — makes the T948/v2026.4.100 class of bug impossible
  // to ship silently (see validateCoreEntryPoints() above for details).
  validateCoreEntryPoints();

  // Pre-build clean: wipe every packages/*/dist/ directory so files whose
  // source has been deleted cannot survive into the next published tarball.
  // Without this, deleting src/foo.ts leaves dist/foo.js orphaned and npm
  // still ships it (the substrate-removal scenario at T9337 hit exactly
  // this — v2026.5.71's @cleocode/core tarball still contained the stale
  // verifier-runner.js after the source was deleted). The cost is ~1s for
  // a full reinstall of the type-declaration cache on the next build.
  console.log('[build] Pre-clean: wiping packages/*/dist + tsbuildinfo');
  const PRE_CLEAN_PKGS = [
    'adapters',
    'caamp',
    'cant',
    'cleo',
    'cleo-os',
    'contracts',
    'core',
    'git-shim',
    'lafs',
    // 'mcp-adapter' removed (R8 · T11259): package deleted, MCP transport is in @cleocode/runtime.
    'nexus',
    'paths',
    'playbooks',
    'runtime',
    'worktree',
  ];
  const PRE_CLEAN_TARGETS = PRE_CLEAN_PKGS.flatMap((p) => [
    `packages/${p}/dist`,
    `packages/${p}/tsconfig.tsbuildinfo`,
  ]);
  await Promise.all(
    PRE_CLEAN_TARGETS.map((p) =>
      rm(resolve(__dirname, p), { recursive: true, force: true }),
    ),
  );

  // Build order is topological. Independent packages within each wave are
  // launched in parallel via Promise.all() to reduce wall-clock time.
  // Dependency constraints (each package must see its deps' dist/ before it
  // starts) are preserved by awaiting each wave before starting the next.
  //
  //   Wave 1:  lafs + paths   (zero internal deps — true roots)
  //   Wave 2:  contracts     (deps lafs)
  //   Wave 3:  worktree + git-shim + nexus + cant  (dep contracts + paths — both ready)
  //   Wave 4:  caamp         (deps cant — must wait for wave 3)
  //   Wave 5:  core esbuild + tsc declarations  (deps caamp, nexus, worktree, paths)
  //   Wave 6:  runtime + adapters  (both dep core — run in parallel)
  //   Wave 7:  playbooks  (deps core only — mcp-adapter deleted R8 · T11259)
  //   Wave 8:  cleo esbuild  (deps adapters, playbooks, runtime from above)
  //   Wave 9:  cleo-os       (deps cleo)
  //
  // The CI `Build & Verify` job runs `node build.mjs` from a fresh state on
  // every push — any future dep-order regression is caught at PR time.
  const buildStart = Date.now();

  // ---------------------------------------------------------------------------
  // Wave 1: lafs + paths (zero internal deps — true roots of the graph)
  //
  // Both packages have no @cleocode/* dependencies and can build in parallel.
  // paths must complete here so wave-3 packages (worktree, git-shim, caamp,
  // adapters, core) that import @cleocode/paths resolve its .d.ts correctly.
  // ---------------------------------------------------------------------------
  console.log('\n[build] Wave 1: lafs + paths (parallel)');
  await Promise.all([
    buildPkg('@cleocode/lafs', 'packages/lafs/dist/').then(async () => {
      await chmod('packages/lafs/dist/src/cli.js', 0o755).catch(() => {});
    }),
    buildPkg('@cleocode/paths', 'packages/paths/dist/'),
    // E5/T11392: @cleocode/utils is a zero-dep leaf consumed by core+cleo; build
    // its dist/*.d.ts here so core/cleo `tsc --emitDeclarationOnly` resolves it.
    buildPkg('@cleocode/utils', 'packages/utils/dist/'),
  ]);

  // ---------------------------------------------------------------------------
  // Wave 2: contracts (deps lafs — lafs is ready from wave 1)
  // ---------------------------------------------------------------------------
  console.log('\n[build] Wave 2: contracts');
  await buildPkg('@cleocode/contracts', 'packages/contracts/dist/');

  // ---------------------------------------------------------------------------
  // Wave 3: worktree + git-shim + nexus + cant  (dep contracts + paths — both ready)
  //
  // cant must finish in this wave (before caamp in wave 4) because caamp
  // imports validateDocument/parseDocument from @cleocode/cant and its tsup
  // DTS step throws TS2307 if cant's .d.ts are missing.
  // ---------------------------------------------------------------------------
  console.log('\n[build] Wave 3: worktree + git-shim + nexus + cant (parallel)');
  await Promise.all([
    buildPkg('@cleocode/worktree', 'packages/worktree/dist/'),
    buildPkg('@cleocode/git-shim', 'packages/git-shim/dist/'),
    buildPkg('@cleocode/nexus', 'packages/nexus/dist/'),
    buildPkg('@cleocode/cant', 'packages/cant/dist/'),
  ]);

  // ---------------------------------------------------------------------------
  // Wave 4: caamp (deps cant from wave 3 + pre-emitted core/skills/skill-root.d.ts)
  //
  // T9740 Wave C flipped the dep direction so caamp now depends on
  // `@cleocode/core/skills/skill-root.js` (a node-builtin-only file with zero
  // @cleocode/* imports). To break the build cycle without re-shuffling waves,
  // we pre-emit just that single file's .d.ts before caamp's tsup DTS step
  // runs — full core/dist still emits in wave 5.
  // ---------------------------------------------------------------------------
  console.log('\n[build] Wave 4: caamp');
  console.log('  Pre-emitting core/dist/skills/skill-root.d.ts (T9740 Wave C cycle break)...');
  // skill-root.ts has zero @cleocode/* deps — we hand-write the matching
  // .d.ts so caamp's tsup DTS step (which runs BEFORE core's full tsc emit
  // in wave 5) can resolve `@cleocode/core/skills/skill-root.js`. The wave-5
  // core tsc pass overwrites this stub with the real declaration emit.
  const skillRootDts = `export type SkillSourceType = 'canonical' | 'user' | 'community' | 'agent-created';
export interface IsCanonicalOptions {
  dbSourceType?: SkillSourceType | string;
  manifestNames?: string[];
}
export declare const AGENTS_SKILLS_BRIDGE_PATH: string;
export declare const CLAUDE_SKILLS_AGENTS_SHARED_PATH: string;
export declare function resolveSkillsRoot(): string;
export declare function is_canonical(skillPath: string, options?: IsCanonicalOptions): boolean;
`;
  await mkdir(resolve(__dirname, 'packages/core/dist/skills'), { recursive: true });
  await writeFile(
    resolve(__dirname, 'packages/core/dist/skills/skill-root.d.ts'),
    skillRootDts,
    'utf8',
  );
  console.log('  -> packages/core/dist/skills/skill-root.d.ts (stub)');
  await buildPkg('@cleocode/caamp', 'packages/caamp/dist/');
  await chmod('packages/caamp/dist/cli.js', 0o755).catch(() => {});

  // ---------------------------------------------------------------------------
  // Wave 5: core esbuild bundle + tsc declaration emit
  //   (deps caamp, nexus, worktree — all ready after waves 3–4)
  // ---------------------------------------------------------------------------
  console.log('\n[build] Wave 5: core (esbuild + tsc declarations)');
  assertDepsReady('packages/core/dist/');
  await esbuild.build(coreBuildOptions);
  await sanitizeSourcemaps('packages/core/dist'); // T9184
  console.log('  -> packages/core/dist/index.js');
  // esbuild doesn't emit .d.ts — run tsc for declarations only.
  // Remove stale tsBuildInfo to force fresh declaration emit (composite: true).
  await rm(resolve(__dirname, 'packages/core/tsconfig.tsbuildinfo'), { force: true });
  console.log('  Generating type declarations...');
  // Use spawn directly — `exec tsc --emitDeclarationOnly` is not a `run build`
  // invocation, so buildPkg() cannot be used here.
  await new Promise((res, rej) => {
    const proc = spawnPnpm(
      ['--filter', '@cleocode/core', 'exec', 'tsc', '--emitDeclarationOnly'],
      { stdio: 'inherit', cwd: __dirname },
    );
    proc.on('error', rej);
    proc.on('close', (code) =>
      code !== 0 ? rej(new Error(`core tsc --emitDeclarationOnly failed (exit ${code})`)) : res(),
    );
  });
  console.log('  -> packages/core/dist/*.d.ts');

  // ---------------------------------------------------------------------------
  // Wave 6: runtime + adapters (both dep core — independent of each other)
  // ---------------------------------------------------------------------------
  console.log('\n[build] Wave 6: runtime + adapters (parallel)');
  await Promise.all([
    buildPkg('@cleocode/runtime', 'packages/runtime/dist/'),
    // adapters uses esbuild inline + tsc for .d.ts — wrap inline to keep
    // it in the same wave without a separate buildPkg invocation.
    (async () => {
      assertDepsReady('packages/adapters/dist/');
      await esbuild.build(adaptersBuildOptions);
      await sanitizeSourcemaps('packages/adapters/dist'); // T9184
      console.log('  -> packages/adapters/dist/index.js (esbuild)');
      await rm(resolve(__dirname, 'packages/adapters/tsconfig.tsbuildinfo'), { force: true });
      await new Promise((res, rej) => {
        const proc = spawnPnpm(
          ['--filter', '@cleocode/adapters', 'exec', 'tsc', '--emitDeclarationOnly'],
          { stdio: 'inherit', cwd: __dirname },
        );
        proc.on('error', rej);
        proc.on('close', (code) =>
          code !== 0 ? rej(new Error(`adapters tsc --emitDeclarationOnly failed (exit ${code})`)) : res(),
        );
      });
      console.log('  -> packages/adapters/dist/*.d.ts');
    })(),
  ]);

  // ---------------------------------------------------------------------------
  // Wave 7: playbooks (dep core only — previously also built mcp-adapter here)
  //
  // packages/mcp-adapter removed (R8 · T11259): source deleted, MCP transport
  // consolidated into @cleocode/runtime/gateway/mcp which is already built in
  // Wave 6. No separate mcp-adapter build step needed.
  //
  // playbooks: tsconfig.tsbuildinfo must be removed first — composite: true
  // causes tsc -b to short-circuit when the cache thinks nothing changed, even
  // if dist/ was wiped. Root cause of the v2026.4.94 empty-tarball regression.
  // ---------------------------------------------------------------------------
  console.log('\n[build] Wave 7: playbooks');
  await rm(resolve(__dirname, 'packages/playbooks/tsconfig.tsbuildinfo'), { force: true });
  await buildPkg('@cleocode/playbooks', 'packages/playbooks/dist/');

  // ---------------------------------------------------------------------------
  // Wave 7.5: re-inline @cleocode/utils into core's tsc-emitted leaf files (T11654)
  //
  // core's published dist is tsc-transpiled (small per-file output where every
  // workspace dep survives as a bare `@cleocode/*` import — each of which is a
  // DECLARED runtime dependency of @cleocode/core, so the bundle-budget gate's
  // AC1 inlining check passes). @cleocode/utils is the one exception: it is
  // private (never published) and esbuild-inlined into the Wave-5 bundle — but
  // the playbooks `tsc -b` reference build (Wave 7) re-emits core's composite
  // project via plain tsc, which does NOT apply the esbuild utils alias and
  // leaves a bare `import '@cleocode/utils'` in the three leaf modules that
  // consume it (memory/redaction.ts, llm/plugin-facade.ts, docs/export-document.ts).
  // With utils moved to devDependencies (T11654) that surviving import is
  // unresolvable on npm (install 404 / runtime ERR_MODULE_NOT_FOUND) AND trips
  // the bundle-budget gate's AC1 (undeclared @cleocode/* import).
  //
  // Re-running the FULL core esbuild here would self-contain all ~625 entry
  // points and blow the dist size budget (T11582 — observed 1 GB). Instead,
  // surgically re-emit ONLY core's three utils-consuming entry points with
  // esbuild (utils inlined per the coreBuildOptions alias), overwriting the tsc
  // output for just those files. The rest of the tsc-transpiled tree — incl.
  // nested-subdir JS like store/exodus/index.js that the esbuild entry-point
  // scan does not cover — is left untouched, so dist size is unaffected.
  // ---------------------------------------------------------------------------
  console.log('\n[build] Wave 7.5: re-inline @cleocode/utils into core leaf files (T11654)');
  await esbuild.build({
    ...coreBuildOptions,
    entryPoints: [
      { in: 'packages/core/src/memory/redaction.ts', out: 'memory/redaction' },
      { in: 'packages/core/src/llm/plugin-facade.ts', out: 'llm/plugin-facade' },
      { in: 'packages/core/src/docs/export-document.ts', out: 'docs/export-document' },
    ],
  });
  await sanitizeSourcemaps('packages/core/dist'); // T9184
  console.log(
    '  -> packages/core/dist/{memory/redaction,llm/plugin-facade,docs/export-document}.js (utils inlined)',
  );

  // ---------------------------------------------------------------------------
  // Wave 8: cleo esbuild bundle (deps adapters, playbooks, runtime — all ready)
  // ---------------------------------------------------------------------------
  console.log('\n[build] Wave 8: cleo (esbuild)');
  assertDepsReady('packages/cleo/dist/');
  await esbuild.build(cleoBuildOptions);
  await sanitizeSourcemaps('packages/cleo/dist'); // T9184
  // Make CLI entry executable (shebang only works with +x)
  await chmod('packages/cleo/dist/cli/index.js', 0o755);
  console.log('  -> packages/cleo/dist/cli/index.js');

  // ---------------------------------------------------------------------------
  // Wave 9: cleo-os (deps cleo + cant — both ready)
  //
  // Uses full `build` (src + extensions + postinstall) — no `build:src`-only
  // shortcut that hid extension type errors in v2026.4.66-73.
  // ---------------------------------------------------------------------------
  console.log('\n[build] Wave 9: cleo-os');
  await buildPkg('@cleocode/cleo-os', 'packages/cleo-os/dist/');
  await chmod('packages/cleo-os/dist/cli.js', 0o755).catch(() => {});

  console.log(`\nBuild complete. (${Date.now() - buildStart}ms total)`);
}

if (isWatch) {
  const ctx = await esbuild.context(cleoBuildOptions);
  await ctx.watch();
  console.log('Watching for changes...');
} else {
  await build();
}
