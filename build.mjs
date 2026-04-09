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
import { chmod, rm } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
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
  entryPoints: ['packages/core/src/index.ts'],
  bundle: true,
  platform: 'node',
  target: 'node24',
  format: 'esm',
  outfile: 'packages/core/dist/index.js',
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
// Build execution
// ---------------------------------------------------------------------------

async function build() {
  // Build order is topological — every package builds AFTER its workspace
  // dependencies. Reordering this list without consulting the dep graph
  // breaks fresh-checkout builds (CI). Verified order:
  //
  //   lafs       (no internal deps)
  //   contracts  (no internal deps — type-only)
  //   cant       (deps: contracts, lafs)
  //   caamp      (deps: cant, lafs)
  //   core       (deps: contracts, lafs, others — built via esbuild + tsc emit)
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

  console.log('Building @cleocode/cleo...');
  await esbuild.build(cleoBuildOptions);
  // Make CLI entry executable (shebang only works with +x)
  await chmod('packages/cleo/dist/cli/index.js', 0o755);
  console.log('  -> packages/cleo/dist/cli/index.js');

  // CleoOS wraps @cleocode/cleo + Pi — depends on cleo and cant (both built above).
  // Uses build:src (main tsc only) — extensions have their own tsconfig and are
  // compiled separately via build:extensions when needed. This avoids blocking
  // the monorepo build on optional extension type issues.
  console.log('Building @cleocode/cleo-os...');
  execFileSync('pnpm', ['--filter', '@cleocode/cleo-os', 'run', 'build:src'], {
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
