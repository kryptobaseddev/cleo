#!/usr/bin/env node

/**
 * esbuild configuration for CLEO V2
 * Bundles the CLI into a single executable file.
 * @epic T4454
 * @task T4455
 */

import * as esbuild from 'esbuild';
import { spawnSync } from 'node:child_process';
import { chmod, readFile, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

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
  plugins: [
    {
      // Bundle @cleocode/* workspace packages inline; externalize all other packages.
      // This ensures adapters are included in the published npm tarball. (T5698)
      name: 'bundle-workspace-packages',
      setup(build) {
        // Resolve @cleocode/adapter-* to source TypeScript directly.
        // This avoids needing workspace dist/ builds and ensures adapters
        // are bundled into the output for npm publish. (T5698)
        const adapterMap = {
          '@cleocode/adapter-claude-code': resolve(__dirname, 'packages/adapters/claude-code/src/index.ts'),
          '@cleocode/adapter-opencode': resolve(__dirname, 'packages/adapters/opencode/src/index.ts'),
          '@cleocode/adapter-cursor': resolve(__dirname, 'packages/adapters/cursor/src/index.ts'),
          '@cleocode/contracts': resolve(__dirname, 'packages/contracts/src/index.ts'),
          // T5723: main bundle uses src/core/index.ts directly (avoids export* resolution issues)
          // packages/core/src/index.ts is only used for the corePackageBuildOptions standalone bundle
          '@cleocode/core': resolve(__dirname, 'src/core/index.ts'),
        };

        // Resolve @cleocode/* to source TypeScript
        build.onResolve({ filter: /^@cleocode\// }, (args) => {
          const mapped = adapterMap[args.path];
          if (mapped) return { path: mapped };
          return undefined;
        });

        // Mark all other bare-specifier imports as external
        build.onResolve({ filter: /^[a-zA-Z@]/ }, (args) => {
          if (args.path.startsWith('@cleocode/')) return undefined;
          return { path: args.path, external: true };
        });
      },
    },
  ],
};

/** @type {esbuild.BuildOptions} */
const corePackageBuildOptions = {
  entryPoints: ['packages/core/src/index.ts'],
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'esm',
  outfile: 'packages/core/dist/index.js',
  sourcemap: true,
  plugins: [
    {
      // Bundle @cleocode/contracts inline; keep all other @cleocode/* and npm packages external.
      // This ensures the standalone package has no relative back-references.
      name: 'bundle-core-workspace-packages',
      setup(build) {
        const workspaceMap = {
          '@cleocode/contracts': resolve(__dirname, 'packages/contracts/src/index.ts'),
        };

        // Resolve known workspace packages to their source TypeScript
        build.onResolve({ filter: /^@cleocode\// }, (args) => {
          const mapped = workspaceMap[args.path];
          if (mapped) return { path: mapped };
          // All other @cleocode/* are external (e.g. @cleocode/caamp, @cleocode/lafs-protocol)
          return { path: args.path, external: true };
        });

        // Mark all other bare-specifier imports as external
        build.onResolve({ filter: /^[a-zA-Z@]/ }, (args) => {
          if (args.path.startsWith('@cleocode/')) return undefined;
          return { path: args.path, external: true };
        });
      },
    },
  ],
};

/**
 * Fix TypeScript declaration entry points for packages/core after tsc emit.
 *
 * tsc places declarations relative to the monorepo rootDir, so it generates:
 *   packages/core/dist/packages/core/src/cleo.d.ts  (paths: ../../../src/*)
 *   packages/core/dist/packages/core/src/index.d.ts (paths: ../../../src/*)
 *
 * Neither is usable from dist/ directly. This function:
 *   1. Reads the tsc-generated cleo.d.ts and rewrites ../../../src/ → ./
 *      so all its imports resolve within dist/, then writes it to dist/cleo.d.ts
 *   2. Overwrites dist/index.d.ts with a corrected barrel that re-exports
 *      from the self-contained ./core/index.js and ./cleo.js paths.
 *
 * @epic T5716
 */
async function fixCoreDeclarations() {
  const distDir = resolve(__dirname, 'packages/core/dist');

  // 1. Fix cleo.d.ts — rewrite broken monorepo-relative paths
  const cleoSrc = resolve(distDir, 'packages/core/src/cleo.d.ts');
  let cleoContent = await readFile(cleoSrc, 'utf-8');
  cleoContent = cleoContent.replaceAll('../../../src/', './');
  await writeFile(resolve(distDir, 'cleo.d.ts'), cleoContent, 'utf-8');

  // 2. Rewrite dist/index.d.ts with correct relative paths
  const indexContent = `// @cleocode/core — generated declaration entry point
export * from './core/index.js';
export { Cleo } from './cleo.js';
export type { AdminAPI, CheckAPI, CleoInitOptions, CleoTasksApi, LifecycleAPI, MemoryAPI, NexusAPI, OrchestrationAPI, ReleaseAPI, SessionsAPI, StickyAPI, TasksAPI } from './cleo.js';
export { addTask, archiveTasks, completeTask, deleteTask, findTasks, listTasks, showTask, updateTask } from './core/tasks/index.js';
export { endSession, listSessions, resumeSession, sessionStatus, startSession } from './core/sessions/index.js';
export { fetchBrainEntries, observeBrain, searchBrainCompact, timelineBrain } from './core/memory/brain-retrieval.js';
export { searchBrain } from './core/memory/brain-search.js';
export type { DataAccessor } from './store/data-accessor.js';
export { createDataAccessor, getAccessor } from './store/data-accessor.js';
`;
  await writeFile(resolve(distDir, 'index.d.ts'), indexContent, 'utf-8');

  console.log('Fixed: packages/core/dist/index.d.ts and packages/core/dist/cleo.d.ts');
}

// Generate build config before compilation
generateBuildConfig();

const isCoreOnly = process.argv.includes('--core-only');

if (isWatch) {
  const ctx = await esbuild.context(buildOptions);
  await ctx.watch();
  console.log('Watching for changes...');
} else if (isCoreOnly) {
  // Build only the @cleocode/core standalone bundle
  console.log('Building @cleocode/core standalone bundle...');
  await esbuild.build(corePackageBuildOptions);
  // Generate TypeScript declarations for packages/core
  spawnSync(
    'npx',
    ['tsc', '--project', 'packages/core/tsconfig.json', '--emitDeclarationOnly', '--noEmit', 'false'],
    { stdio: 'inherit', encoding: 'utf-8' },
  );
  // Fix broken monorepo-relative paths in declaration entry points
  await fixCoreDeclarations();
  console.log('Done: packages/core/dist/index.js');
} else {
  await esbuild.build(buildOptions);
  // Make entry points executable (shebang only works with +x)
  await chmod('dist/cli/index.js', 0o755);
  await chmod('dist/mcp/index.js', 0o755);

  // Also build the @cleocode/core standalone bundle
  console.log('Building @cleocode/core standalone bundle...');
  await esbuild.build(corePackageBuildOptions);
  // Generate TypeScript declarations for packages/core
  spawnSync(
    'npx',
    ['tsc', '--project', 'packages/core/tsconfig.json', '--emitDeclarationOnly', '--noEmit', 'false'],
    { stdio: 'inherit', encoding: 'utf-8' },
  );
  // Fix broken monorepo-relative paths in declaration entry points
  await fixCoreDeclarations();
  console.log('Done: packages/core/dist/index.js');

  console.log('Build complete.');
}
