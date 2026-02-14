#!/usr/bin/env node

/**
 * esbuild configuration for CLEO V2
 * Bundles the CLI into a single executable file.
 * @epic T4454
 * @task T4455
 */

import * as esbuild from 'esbuild';

const isWatch = process.argv.includes('--watch');

/** @type {esbuild.BuildOptions} */
const buildOptions = {
  entryPoints: ['src/cli/index.ts'],
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'esm',
  outfile: 'dist/cli/index.js',
  sourcemap: true,
  banner: {
    js: '#!/usr/bin/env node',
  },
  external: [
    // Keep native modules external
    'proper-lockfile',
    'write-file-atomic',
  ],
  packages: 'external',
};

if (isWatch) {
  const ctx = await esbuild.context(buildOptions);
  await ctx.watch();
  console.log('Watching for changes...');
} else {
  await esbuild.build(buildOptions);
  console.log('Build complete.');
}
