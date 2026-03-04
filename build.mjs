#!/usr/bin/env node

/**
 * esbuild configuration for CLEO V2
 * Bundles the CLI into a single executable file.
 * @epic T4454
 * @task T4455
 */

import * as esbuild from 'esbuild';
import { spawnSync } from 'node:child_process';
import { chmod } from 'node:fs/promises';

const isWatch = process.argv.includes('--watch');

/**
 * Generate build configuration from package.json
 * Must run before TypeScript compilation
 */
function generateBuildConfig() {
  console.log('Generating build configuration...');
  const result = spawnSync('node', ['dev/generate-build-config.js'], {
    stdio: 'inherit',
    encoding: 'utf-8',
  });
  
  if (result.status !== 0) {
    console.error('Failed to generate build configuration');
    process.exit(1);
  }
}

/** @type {esbuild.BuildOptions} */
const buildOptions = {
  entryPoints: [
    { in: 'src/cli/index.ts', out: 'cli/index' },
    { in: 'src/mcp/index.ts', out: 'mcp/index' },
  ],
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'esm',
  outdir: 'dist',
  sourcemap: true,
  banner: {
    js: '#!/usr/bin/env -S node --disable-warning=ExperimentalWarning',
  },
  external: [
    // Keep native modules external
    'proper-lockfile',
    'write-file-atomic',
    '@modelcontextprotocol/sdk',
  ],
  packages: 'external',
};

// Generate build config before compilation
generateBuildConfig();

if (isWatch) {
  const ctx = await esbuild.context(buildOptions);
  await ctx.watch();
  console.log('Watching for changes...');
} else {
  await esbuild.build(buildOptions);
  // Make entry points executable (shebang only works with +x)
  await chmod('dist/cli/index.js', 0o755);
  await chmod('dist/mcp/index.js', 0o755);
  console.log('Build complete.');
}
