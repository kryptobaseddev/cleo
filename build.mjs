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

const __dirname = dirname(fileURLToPath(import.meta.url));

const isWatch = process.argv.includes('--watch');

// ---------------------------------------------------------------------------
// Shared externals — these are NOT bundled, consumers install them separately
// ---------------------------------------------------------------------------
// ALL npm dependencies are external — only @cleocode/* workspace packages are bundled inline.
// This matches the old repo pattern: npm deps are imported at runtime from node_modules.
const sharedExternals = [
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
  // llmtxt (≥2026.4.6) is an optional runtime dep used by docs-generator via
  // dynamic import('llmtxt'). It pulls in onnxruntime-node (.node bindings),
  // mssql, and @opentelemetry/api transitively — all must stay external so
  // esbuild does not try to inline the native addons or tsql drivers.
  'llmtxt',
  'onnxruntime-node',
  'mssql',
  '@opentelemetry/api',
];

// ---------------------------------------------------------------------------
// Helper: create a plugin that bundles workspace packages inline and
// externalizes everything else.
// ---------------------------------------------------------------------------
function workspacePlugin(name, inlineMap) {
  const externalSet = new Set(sharedExternals);
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

      // Only externalize packages in the sharedExternals list
      // Everything else gets bundled (pino, drizzle-orm, citty, etc.)
      build.onResolve({ filter: /^[a-zA-Z@]/ }, (args) => {
        if (args.path.startsWith('@cleocode/')) return undefined;
        if (externalSet.has(args.path)) return { path: args.path, external: true };
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
  entryPoints: [
    { in: 'packages/core/src/index.ts', out: 'index' },
    // ---------------------------------------------------------------------------
    // Stable public subpath entry points (T948)
    //
    // Every subpath declared in packages/core/package.json `exports` whose
    // `import` condition resolves to a concrete dist/*.js file MUST appear here.
    // `validateCoreEntryPoints()` asserts this invariant at build time so that
    // a missing entry is caught before CI ships a broken tarball.
    // ---------------------------------------------------------------------------
    // ./sdk — Cleo class facade, imported via `@cleocode/core/sdk`
    { in: 'packages/core/src/cleo.ts', out: 'cleo' },
    // ./contracts — re-exports from @cleocode/contracts, imported via `@cleocode/core/contracts`
    { in: 'packages/core/src/contracts.ts', out: 'contracts' },
    // ./tasks — task domain index, imported via `@cleocode/core/tasks`
    { in: 'packages/core/src/tasks/index.ts', out: 'tasks/index' },
    // ./memory — memory domain index, imported via `@cleocode/core/memory`
    { in: 'packages/core/src/memory/index.ts', out: 'memory/index' },
    // ./sessions — sessions domain index, imported via `@cleocode/core/sessions`
    { in: 'packages/core/src/sessions/index.ts', out: 'sessions/index' },
    // ./nexus — nexus domain index, imported via `@cleocode/core/nexus`
    { in: 'packages/core/src/nexus/index.ts', out: 'nexus/index' },
    // ./lifecycle — lifecycle domain index, imported via `@cleocode/core/lifecycle`
    { in: 'packages/core/src/lifecycle/index.ts', out: 'lifecycle/index' },
    // Sub-entry for @cleocode/core/conduit — must produce dist/conduit/index.js
    // to match the "./conduit" export in packages/core/package.json.
    { in: 'packages/core/src/conduit/index.ts', out: 'conduit/index' },
    // Sub-entry for @cleocode/core/internal — matches the "./internal" export.
    { in: 'packages/core/src/internal.ts', out: 'internal' },
    // Store subpath entry points — these files are dynamically imported at runtime
    // via `import('@cleocode/core/store/nexus-sqlite' as string)` in the cleo CLI
    // (packages/cleo/src/cli/commands/nexus.ts). They MUST exist as standalone .js
    // files in dist/store/ — they are NOT bundled into dist/index.js.
    // The `as string` cast prevents esbuild from inlining them when bundling cleo.
    // T721: These were previously produced by a stale full `tsc` run. Registering
    // them as explicit entry points guarantees they are always emitted. (T721)
    { in: 'packages/core/src/store/nexus-sqlite.ts', out: 'store/nexus-sqlite' },
    { in: 'packages/core/src/store/nexus-schema.ts', out: 'store/nexus-schema' },
    { in: 'packages/core/src/store/memory-sqlite.ts', out: 'store/memory-sqlite' },
    // Transcript subpath entry points — imported dynamically by packages/cleo/src/cli/commands/transcript.ts
    // via `@cleocode/core/memory/transcript-scanner.js` and `@cleocode/core/memory/transcript-extractor.js`.
    // Must exist as standalone .js files in dist/memory/ to match the package.json subpath exports. (T755)
    { in: 'packages/core/src/memory/transcript-scanner.ts', out: 'memory/transcript-scanner' },
    { in: 'packages/core/src/memory/transcript-extractor.ts', out: 'memory/transcript-extractor' },
    // T1004/T1003/T1015: subpath entry points added in v2026.4.97+. Each one is
    // imported by cleo via @cleocode/core/<subpath>.js and MUST exist as a
    // standalone emitted file (not only in the bundled core index.js) so that
    // node's export-map resolution at runtime finds the target file.
    // v2026.4.99 shipped without these entries → ERR_MODULE_NOT_FOUND in CI
    // smoke test `node packages/cleo/dist/cli/index.js version`.
    { in: 'packages/core/src/memory/brain-backfill.ts', out: 'memory/brain-backfill' },
    { in: 'packages/core/src/memory/precompact-flush.ts', out: 'memory/precompact-flush' },
    // Sentient daemon + tick subpath entry points (T1015 relocation from cleo → core)
    { in: 'packages/core/src/sentient/index.ts', out: 'sentient/index' },
    { in: 'packages/core/src/sentient/daemon.ts', out: 'sentient/daemon' },
    { in: 'packages/core/src/sentient/tick.ts', out: 'sentient/tick' },
    { in: 'packages/core/src/sentient/state.ts', out: 'sentient/state' },
    { in: 'packages/core/src/sentient/propose-tick.ts', out: 'sentient/propose-tick' },
    { in: 'packages/core/src/sentient/proposal-rate-limiter.ts', out: 'sentient/proposal-rate-limiter' },
    // GC daemon subpath entry points (T1015 relocation from cleo → core)
    { in: 'packages/core/src/gc/index.ts', out: 'gc/index' },
    { in: 'packages/core/src/gc/daemon.ts', out: 'gc/daemon' },
    { in: 'packages/core/src/gc/runner.ts', out: 'gc/runner' },
    { in: 'packages/core/src/gc/state.ts', out: 'gc/state' },
    { in: 'packages/core/src/gc/transcript.ts', out: 'gc/transcript' },
    // System/platform-paths — has a subpath export, cleo imports it at runtime
    { in: 'packages/core/src/system/platform-paths.ts', out: 'system/platform-paths' },
  ],
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
//    Bundles @cleocode/contracts and @cleocode/adapters inline.
//    @cleocode/core resolves to packages/core/src/index.ts (source).
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
  // NOTE: src/cli/index.ts already carries `#!/usr/bin/env node` — esbuild
  // preserves it into dist when `preserveShebang` semantics apply. If shebang
  // was missing, assert-shebang postbuild would fail the build (T929).
  banner: {},
  plugins: [
    workspacePlugin('bundle-cleo-deps', {
      '@cleocode/contracts': resolve(__dirname, 'packages/contracts/src/index.ts'),
      '@cleocode/core': resolve(__dirname, 'packages/core/src/index.ts'),
      '@cleocode/core/internal': resolve(__dirname, 'packages/core/src/internal.ts'),
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
// T759: Migration sync — keep packages/cleo/migrations/ in sync with
// packages/core/migrations/ so the CLI bundle always ships complete migrations.
// ---------------------------------------------------------------------------

/**
 * Sync migration folders from @cleocode/core to @cleocode/cleo.
 *
 * The CLI bundle (packages/cleo/dist/cli/index.js) resolves migrations relative
 * to the @cleocode/cleo package root. Without this sync, only the initial
 * migration is present and subsequent schema changes (agent field, graph schema,
 * tier columns, etc.) never run, causing "no such column" errors at runtime.
 *
 * T759: root cause — brain_page_edges missing `provenance` column because T528
 * migration was absent from packages/cleo/migrations/drizzle-brain/.
 */
async function syncMigrationsToCleoPackage() {
  const coreMigsBase = resolve(__dirname, 'packages/core/migrations');
  const cleoMigsBase = resolve(__dirname, 'packages/cleo/migrations');
  const sets = ['drizzle-brain', 'drizzle-tasks', 'drizzle-nexus'];

  for (const set of sets) {
    const src = join(coreMigsBase, set);
    const dst = join(cleoMigsBase, set);
    if (!existsSync(src)) continue;

    const srcDirs = readdirSync(src, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);

    for (const dir of srcDirs) {
      const srcDir = join(src, dir);
      const dstDir = join(dst, dir);
      if (!existsSync(dstDir)) {
        await cp(srcDir, dstDir, { recursive: true });
        console.log(`  [migrations] synced ${set}/${dir}`);
      }
    }
  }
  console.log('Migration sync complete (packages/cleo/migrations/ up to date).');
}

// ---------------------------------------------------------------------------
// Auto-sync guard: assert every concrete non-wildcard subpath export in
// packages/core/package.json has a matching entry in coreBuildOptions.
//
// This catches the class of bug where a subpath is added to package.json
// exports but its corresponding esbuild entry point is forgotten, producing
// a missing dist/*.js that only surfaces as a test failure (or a runtime
// ERR_MODULE_NOT_FOUND) in CI on a fresh checkout.
//
// Wildcards (e.g. "./store/*") are skipped because they map to whole
// directories — individual files within them get explicit entries anyway.
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
 * has a corresponding entry in coreBuildOptions.entryPoints.
 *
 * Exits the process with a non-zero code and a descriptive error if any gap is
 * found — this makes the class of bug that caused the v2026.4.100 CI failure
 * impossible to ship silently.
 */
function validateCoreEntryPoints() {
  const pkgPath = resolve(__dirname, 'packages/core/package.json');
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
  const exports = pkg.exports ?? {};

  // Build the set of `out` keys already declared in coreBuildOptions
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
    console.error('[build] corresponding esbuild entry point in coreBuildOptions.entryPoints.');
    console.error('[build] This will produce a broken dist/ on a fresh checkout.\n');
    for (const { subpath, importPath, expectedOut } of missing) {
      console.error(`  subpath: ${subpath}`);
      console.error(`    import: ${importPath}`);
      console.error(`    add to coreBuildOptions.entryPoints:`);
      // Derive the source path from the out key (convention: packages/core/src/<out>.ts)
      const srcGuess = `packages/core/src/${expectedOut}.ts`;
      console.error(`      { in: '${srcGuess}', out: '${expectedOut}' }\n`);
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

  // T759: Sync all DB migrations from @cleocode/core to @cleocode/cleo.
  // The CLI bundle resolves migrations relative to the @cleocode/cleo package
  // directory (packages/cleo/migrations/). Without this sync, only the initial
  // migration is present in @cleocode/cleo, causing E_BRAIN_OBSERVE on fresh
  // installs (brain_page_edges missing the `provenance` column that T528 adds).
  await syncMigrationsToCleoPackage();

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
