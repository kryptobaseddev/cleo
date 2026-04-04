#!/usr/bin/env node

/**
 * esbuild configuration for the @cleocode monorepo.
 *
 * Produces three bundles:
 *   1. packages/core/dist/index.js       — core standalone (npm publish)
 *   2. packages/cleo/dist/cli/index.js — CLI entry point (npm publish)
 *      packages/cleo/dist/mcp/index.js — MCP entry point (npm publish)
 *   3. packages/adapters/dist/index.js    — adapters bundle
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
  '@modelcontextprotocol/sdk',
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
  '@xenova/transformers',
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
    js: '#!/usr/bin/env node',
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
  console.log('Building @cleocode/lafs...');
  const { execFileSync } = await import('node:child_process');
  execFileSync('pnpm', ['--filter', '@cleocode/lafs', 'run', 'build'], {
    stdio: 'inherit',
    cwd: __dirname,
  });
  await chmod('packages/lafs/dist/src/cli.js', 0o755).catch(() => {});
  console.log('  -> packages/lafs/dist/');

  console.log('Building @cleocode/caamp...');
  execFileSync('pnpm', ['--filter', '@cleocode/caamp', 'run', 'build'], {
    stdio: 'inherit',
    cwd: __dirname,
  });
  await chmod('packages/caamp/dist/cli.js', 0o755).catch(() => {});
  console.log('  -> packages/caamp/dist/');

  // Build contracts first (tsc, not esbuild — types-only package)
  console.log('Building @cleocode/contracts...');
  execFileSync('pnpm', ['--filter', '@cleocode/contracts', 'run', 'build'], {
    stdio: 'inherit',
    cwd: __dirname,
  });
  console.log('  -> packages/contracts/dist/');

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

  console.log('\nBuild complete.');
}

if (isWatch) {
  const ctx = await esbuild.context(cleoBuildOptions);
  await ctx.watch();
  console.log('Watching for changes...');
} else {
  await build();
}
