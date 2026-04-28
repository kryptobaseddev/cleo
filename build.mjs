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
import { chmod, cp, rm } from 'node:fs/promises';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

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
  'sentient',
  'gc',
  'memory',
  'tasks',
  'sessions',
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
];

/**
 * Explicit nested subdirectories that also need their files scanned.
 * Key: relative path from packages/core/src/ (used as the `out` prefix).
 * Value: absolute source directory path.
 */
const SUBPATH_SUBDIRS = {
  'nexus/api-extractors': 'packages/core/src/nexus/api-extractors',
};

/**
 * Root-level flat files in packages/core/src/ that need standalone entries
 * (in addition to index.ts which is always included).
 */
const ROOT_FLATS = ['cleo.ts', 'contracts.ts', 'internal.ts'];

/**
 * Collect all @cleocode/core esbuild entry points by scanning the source
 * tree. Returns an array of `{ in, out }` objects suitable for esbuild's
 * `entryPoints` option.
 *
 * @returns {{ in: string; out: string }[]}
 */
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
  sourcemap: true,
  plugins: [
    workspacePlugin('bundle-core-deps', {
      '@cleocode/contracts': resolve(__dirname, 'packages/contracts/src/index.ts'),
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
  sourcemap: true,
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
  sourcemap: true,
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

async function build() {
  // Assert every non-wildcard subpath export in packages/core/package.json
  // has a matching entry in coreBuildOptions.entryPoints. Exits non-zero if
  // any gap is detected — makes the T948/v2026.4.100 class of bug impossible
  // to ship silently (see validateCoreEntryPoints() above for details).
  validateCoreEntryPoints();

  // Build order is topological — every package builds AFTER its workspace
  // dependencies. Reordering this list without consulting the dep graph
  // breaks fresh-checkout builds (CI). Verified order:
  //
  //   lafs       (no internal deps)
  //   contracts  (no internal deps — type-only)
  //   nexus      (deps: contracts — tree-sitter code analysis)
  //   cant       (deps: contracts, lafs)
  //   caamp      (deps: cant, lafs)
  //   core       (deps: contracts, lafs, nexus, others — built via esbuild + tsc emit)
  //   runtime    (deps: contracts, core)
  //   adapters   (deps: contracts — built via esbuild + tsc emit)
  //   cleo       (deps: all of the above — built via esbuild)
  //   cleo-os    (deps: cleo, cant — TUI wrapper)
  //
  // The CI lint job at .github/workflows/ci.yml `Build & Verify` runs
  // `node build.mjs` from a fresh state (no dist, no tsbuildinfo) on every
  // push so that any future dep-order regression is caught at PR time, not
  // at release time.
  const { execFileSync } = await import('node:child_process');

  console.log('Building @cleocode/lafs...');
  execFileSync('pnpm', ['--filter', '@cleocode/lafs', 'run', 'build'], {
    stdio: 'inherit',
    cwd: __dirname,
  });
  await chmod('packages/lafs/dist/src/cli.js', 0o755).catch(() => {});
  console.log('  -> packages/lafs/dist/');

  // Contracts is type-only and has no internal deps — build before any
  // package that imports its types.
  console.log('Building @cleocode/contracts...');
  execFileSync('pnpm', ['--filter', '@cleocode/contracts', 'run', 'build'], {
    stdio: 'inherit',
    cwd: __dirname,
  });
  console.log('  -> packages/contracts/dist/');

  // WORKTREE depends on @cleocode/contracts only — build after contracts so
  // that core and cant can import from it. Built before nexus/cant to
  // establish dist/ for workspace symlink resolution in subsequent packages.
  console.log('Building @cleocode/worktree...');
  execFileSync('pnpm', ['--filter', '@cleocode/worktree', 'run', 'build'], {
    stdio: 'inherit',
    cwd: __dirname,
  });
  console.log('  -> packages/worktree/dist/');

  // GIT-SHIM depends on @cleocode/contracts only — similar profile to worktree.
  // Its `bin` entry points at dist/shim.js, so this build MUST run before
  // publish or npm emits "No bin file found" warnings + tarball is broken.
  console.log('Building @cleocode/git-shim...');
  execFileSync('pnpm', ['--filter', '@cleocode/git-shim', 'run', 'build'], {
    stdio: 'inherit',
    cwd: __dirname,
  });
  console.log('  -> packages/git-shim/dist/');

  // NEXUS depends on @cleocode/contracts — must build before core because
  // core's type declaration emit (tsc --emitDeclarationOnly) needs nexus's
  // .d.ts files available.
  console.log('Building @cleocode/nexus...');
  execFileSync('pnpm', ['--filter', '@cleocode/nexus', 'run', 'build'], {
    stdio: 'inherit',
    cwd: __dirname,
  });
  console.log('  -> packages/nexus/dist/');

  // CANT depends on @cleocode/contracts and @cleocode/lafs — both built above.
  // CANT must build BEFORE caamp because caamp imports validateDocument /
  // parseDocument from @cleocode/cant in src/core/harness/pi.ts. Without
  // cant's .d.ts on disk first, caamp's tsup DTS step throws TS2307.
  console.log('Building @cleocode/cant...');
  execFileSync('pnpm', ['--filter', '@cleocode/cant', 'run', 'build'], {
    stdio: 'inherit',
    cwd: __dirname,
  });
  console.log('  -> packages/cant/dist/');

  // CAAMP depends on @cleocode/cant and @cleocode/lafs — both built above.
  console.log('Building @cleocode/caamp...');
  execFileSync('pnpm', ['--filter', '@cleocode/caamp', 'run', 'build'], {
    stdio: 'inherit',
    cwd: __dirname,
  });
  await chmod('packages/caamp/dist/cli.js', 0o755).catch(() => {});
  console.log('  -> packages/caamp/dist/');

  console.log('Building @cleocode/core...');
  await esbuild.build(coreBuildOptions);
  console.log('  -> packages/core/dist/index.js');
  // esbuild doesn't emit .d.ts — run tsc for declarations only
  // Remove stale tsBuildInfo to force fresh declaration emit (composite: true)
  await rm(resolve(__dirname, 'packages/core/tsconfig.tsbuildinfo'), { force: true });
  console.log('  Generating type declarations...');
  execFileSync('pnpm', ['--filter', '@cleocode/core', 'exec', 'tsc', '--emitDeclarationOnly'], {
    stdio: 'inherit',
    cwd: __dirname,
  });
  console.log('  -> packages/core/dist/*.d.ts');

  // Runtime depends on @cleocode/contracts and @cleocode/core — both built above.
  console.log('Building @cleocode/runtime...');
  execFileSync('pnpm', ['--filter', '@cleocode/runtime', 'run', 'build'], {
    stdio: 'inherit',
    cwd: __dirname,
  });
  console.log('  -> packages/runtime/dist/');

  console.log('Building @cleocode/adapters...');
  await esbuild.build(adaptersBuildOptions);
  console.log('  -> packages/adapters/dist/index.js');
  // esbuild doesn't emit .d.ts — run tsc for declarations only
  await rm(resolve(__dirname, 'packages/adapters/tsconfig.tsbuildinfo'), { force: true });
  console.log('  Generating type declarations...');
  execFileSync('pnpm', ['--filter', '@cleocode/adapters', 'exec', 'tsc', '--emitDeclarationOnly'], {
    stdio: 'inherit',
    cwd: __dirname,
  });
  console.log('  -> packages/adapters/dist/*.d.ts');

  // T910/T935: playbooks standalone build for external consumers. The cleo
  // bundle inlines playbooks source, but @cleocode/playbooks is also published
  // on npm and needs its own dist/ for direct consumers. Built AFTER core
  // because playbooks depends on @cleocode/contracts + @cleocode/core.
  // tsconfig.tsbuildinfo must be removed first — composite: true causes tsc -b
  // to short-circuit when the cache thinks nothing has changed, even if dist/
  // has been wiped. This was the root cause of the v2026.4.94 empty-tarball
  // regression (fixed in v2026.4.95).
  await rm(resolve(__dirname, 'packages/playbooks/tsconfig.tsbuildinfo'), { force: true });
  console.log('Building @cleocode/playbooks...');
  execFileSync('pnpm', ['--filter', '@cleocode/playbooks', 'run', 'build'], {
    stdio: 'inherit',
    cwd: __dirname,
  });
  console.log('  -> packages/playbooks/dist/');

  console.log('Building @cleocode/cleo...');
  await esbuild.build(cleoBuildOptions);
  // Make CLI entry executable (shebang only works with +x)
  await chmod('packages/cleo/dist/cli/index.js', 0o755);
  console.log('  -> packages/cleo/dist/cli/index.js');

  // CleoOS wraps @cleocode/cleo + Pi — depends on cleo and cant (both built above).
  // Uses full `build` (src + extensions + postinstall) — no more `build:src`-only
  // shortcut that hid extension type errors v2026.4.66-73. If extensions break,
  // release blocks. No `|| true` bandaids in cleo-os scripts either.
  console.log('Building @cleocode/cleo-os...');
  execFileSync('pnpm', ['--filter', '@cleocode/cleo-os', 'run', 'build'], {
    stdio: 'inherit',
    cwd: __dirname,
  });
  await chmod('packages/cleo-os/dist/cli.js', 0o755).catch(() => {});
  console.log('  -> packages/cleo-os/dist/');

  console.log('\nBuild complete.');
}

if (isWatch) {
  const ctx = await esbuild.context(cleoBuildOptions);
  await ctx.watch();
  console.log('Watching for changes...');
} else {
  await build();
}
