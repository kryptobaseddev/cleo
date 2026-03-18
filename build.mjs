#!/usr/bin/env node

/**
 * esbuild configuration for the @cleocode monorepo.
 *
 * Produces three bundles:
 *   1. packages/core/dist/index.js       — core standalone (npm publish)
 *   2. packages/cleoctl/dist/cli/index.js — CLI entry point (npm publish)
 *      packages/cleoctl/dist/mcp/index.js — MCP entry point (npm publish)
 *   3. packages/adapters/dist/index.js    — adapters bundle
 */

import * as esbuild from 'esbuild';
import { chmod } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const isWatch = process.argv.includes('--watch');

// ---------------------------------------------------------------------------
// Shared externals — these are NOT bundled, consumers install them separately
// ---------------------------------------------------------------------------
const sharedExternals = [
  '@cleocode/caamp',
  '@cleocode/lafs-protocol',
  'drizzle-orm',
  'pino',
  'pino-roll',
  'commander',
  '@modelcontextprotocol/sdk',
  'proper-lockfile',
  'write-file-atomic',
  'ajv',
  'ajv-formats',
  'env-paths',
  'yaml',
  'zod',
  'js-tiktoken',
];

// ---------------------------------------------------------------------------
// Helper: create a plugin that bundles workspace packages inline and
// externalizes everything else.
// ---------------------------------------------------------------------------
function workspacePlugin(name, inlineMap) {
  return {
    name,
    setup(build) {
      // Resolve @cleocode/* workspace packages to source TypeScript
      build.onResolve({ filter: /^@cleocode\// }, (args) => {
        const mapped = inlineMap[args.path];
        if (mapped) return { path: mapped };
        // Not in inline map → external
        return { path: args.path, external: true };
      });

      // Mark all other bare-specifier imports as external
      build.onResolve({ filter: /^[a-zA-Z@]/ }, (args) => {
        if (args.path.startsWith('@cleocode/')) return undefined;
        return { path: args.path, external: true };
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
// 2. @cleocode/cleoctl — CLI + MCP bundle
//    Bundles @cleocode/contracts and @cleocode/adapters inline.
//    @cleocode/core resolves to packages/core/src/index.ts (source).
// ---------------------------------------------------------------------------
/** @type {esbuild.BuildOptions} */
const cleoctlBuildOptions = {
  entryPoints: [
    { in: 'packages/cleoctl/src/cli/index.ts', out: 'cli/index' },
    { in: 'packages/cleoctl/src/mcp/index.ts', out: 'mcp/index' },
  ],
  bundle: true,
  platform: 'node',
  target: 'node24',
  format: 'esm',
  outdir: 'packages/cleoctl/dist',
  sourcemap: true,
  banner: {
    js: '#!/usr/bin/env -S node --disable-warning=ExperimentalWarning',
  },
  plugins: [
    workspacePlugin('bundle-cleoctl-deps', {
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
  console.log('Building @cleocode/core...');
  await esbuild.build(coreBuildOptions);
  console.log('  -> packages/core/dist/index.js');

  console.log('Building @cleocode/adapters...');
  await esbuild.build(adaptersBuildOptions);
  console.log('  -> packages/adapters/dist/index.js');

  console.log('Building @cleocode/cleoctl...');
  await esbuild.build(cleoctlBuildOptions);
  // Make CLI entry executable (shebang only works with +x)
  await chmod('packages/cleoctl/dist/cli/index.js', 0o755);
  await chmod('packages/cleoctl/dist/mcp/index.js', 0o755);
  console.log('  -> packages/cleoctl/dist/cli/index.js');
  console.log('  -> packages/cleoctl/dist/mcp/index.js');

  console.log('\nBuild complete.');
}

if (isWatch) {
  const ctx = await esbuild.context(cleoctlBuildOptions);
  await ctx.watch();
  console.log('Watching for changes...');
} else {
  await build();
}
