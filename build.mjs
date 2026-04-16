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
 */

import * as esbuild from 'esbuild';
import { chmod, cp, rm } from 'node:fs/promises';
import { existsSync, readdirSync } from 'node:fs';
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
    { in: 'packages/core/src/store/brain-sqlite.ts', out: 'store/brain-sqlite' },
    // Transcript subpath entry points — imported dynamically by packages/cleo/src/cli/commands/transcript.ts
    // via `@cleocode/core/memory/transcript-scanner.js` and `@cleocode/core/memory/transcript-extractor.js`.
    // Must exist as standalone .js files in dist/memory/ to match the package.json subpath exports. (T755)
    { in: 'packages/core/src/memory/transcript-scanner.ts', out: 'memory/transcript-scanner' },
    { in: 'packages/core/src/memory/transcript-extractor.ts', out: 'memory/transcript-extractor' },
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
  banner: {
    js: '#!/bin/sh\n":" //; exec node --disable-warning=ExperimentalWarning "$0" "$@"',
  },
  plugins: [
    workspacePlugin('bundle-cleo-deps', {
      '@cleocode/contracts': resolve(__dirname, 'packages/contracts/src/index.ts'),
      '@cleocode/core': resolve(__dirname, 'packages/core/src/index.ts'),
      '@cleocode/core/internal': resolve(__dirname, 'packages/core/src/internal.ts'),
      '@cleocode/nexus': resolve(__dirname, 'packages/nexus/src/index.ts'),
      '@cleocode/nexus/internal': resolve(__dirname, 'packages/nexus/src/internal.ts'),
      '@cleocode/adapters': resolve(__dirname, 'packages/adapters/src/index.ts'),
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
// Build execution
// ---------------------------------------------------------------------------

async function build() {
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
