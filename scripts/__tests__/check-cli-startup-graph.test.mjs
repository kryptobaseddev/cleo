/**
 * Unit tests for the built-CLI startup ratchet (T13126).
 *
 * The runtime probes need a built CLI and run in CI's Build & Verify job; these
 * tests pin the pure pieces: what counts as a static import, how the static
 * graph is walked, and how a probe is judged against its budgets.
 */

import { describe, expect, it } from 'vitest';
import {
  buildPrecondition,
  FORBIDDEN_STATIC_EXTERNALS,
  judgeProbe,
  PROBES,
  SKIPPED_EXIT_CODE,
  staticImportSpecifiers,
  topPackages,
  walkStaticGraph,
} from '../check-cli-startup-graph.mjs';

describe('staticImportSpecifiers', () => {
  it('collects static imports, side-effect imports and re-exports', () => {
    const source = [
      '#!/usr/bin/env node',
      'import {',
      '  a,',
      '  b',
      '} from "./chunk-AAAAAAAA.js";',
      'import "./chunk-BBBBBBBB.js";',
      'import { enforceNodeVersion } from "@cleocode/paths";',
      'export { c } from "./chunk-CCCCCCCC.js";',
      'export * from "@cleocode/lafs";',
    ].join('\n');
    expect(staticImportSpecifiers(source)).toEqual([
      './chunk-AAAAAAAA.js',
      './chunk-BBBBBBBB.js',
      '@cleocode/paths',
      './chunk-CCCCCCCC.js',
      '@cleocode/lafs',
    ]);
  });

  it('ignores dynamic import() — it costs nothing until it runs', () => {
    const source = [
      'const { cliOutput } = await import("./renderers-XJCPXIWY.js");',
      'await import("@cleocode/core/internal");',
      'const x = import ("@cleocode/core");',
      'import("./lazy-entry-AAAAAAAA.js").then((m) => m.run());',
      'import ("@cleocode/core/internal");',
    ].join('\n');
    expect(staticImportSpecifiers(source)).toEqual([]);
  });
});

describe('walkStaticGraph', () => {
  const files = {
    '/dist/cli/index.js': 'import "./chunk-A.js";\nawait import("./lazy.js");\n',
    '/dist/cli/chunk-A.js': 'import { x } from "@cleocode/lafs";\nimport "node:fs";\n',
    '/dist/cli/lazy.js': 'import { y } from "@cleocode/core";\n',
  };
  const read = (path) => {
    const source = files[path];
    if (source === undefined) throw new Error(`unexpected read ${path}`);
    return source;
  };

  it('follows static relative imports only and reports bare externals', () => {
    const graph = walkStaticGraph('/dist/cli/index.js', read);
    expect(graph.files).toEqual(['/dist/cli/index.js', '/dist/cli/chunk-A.js']);
    expect(graph.externals).toEqual(['@cleocode/lafs']);
  });

  it('would surface a hoisted barrel (the T13126 failure shape)', () => {
    const hoisted = { ...files, '/dist/cli/index.js': 'import { y } from "@cleocode/core";\n' };
    const graph = walkStaticGraph('/dist/cli/index.js', (path) => hoisted[path] ?? '');
    expect(graph.externals.filter((spec) => FORBIDDEN_STATIC_EXTERNALS.includes(spec))).toEqual([
      '@cleocode/core',
    ]);
  });
});

describe('judgeProbe', () => {
  const version = PROBES.find((probe) => probe.name === 'version');

  it('passes a probe within budget that loads nothing forbidden', () => {
    expect(version).toBeDefined();
    const urls = ['file:///repo/packages/cleo/dist/cli/index.js', 'node:fs'];
    expect(judgeProbe(version, { modules: 1, maxRssMb: 60, urls })).toEqual([]);
  });

  it.each([
    'file:///repo/packages/core/dist/internal.js',
    'file:///repo/node_modules/@cleocode/core/dist/index.js',
    'file:///repo/node_modules/@cleocode/contracts/dist/index.js',
    'file:///repo/node_modules/.pnpm/drizzle-orm@1/node_modules/drizzle-orm/index.js',
    'node:sqlite',
    'file:///repo/node_modules/@anthropic-ai/sdk/index.mjs',
  ])('fails --version when it loads %s', (url) => {
    const reasons = judgeProbe(version, { modules: 1, maxRssMb: 60, urls: [url] });
    expect(reasons).toHaveLength(1);
    expect(reasons[0]).toContain('forbidden');
  });

  it('fails when the module budget or the RSS ceiling is exceeded', () => {
    const reasons = judgeProbe(version, {
      modules: version.maxModules + 1,
      maxRssMb: version.maxRssMb + 1,
      urls: [],
    });
    expect(reasons).toHaveLength(2);
    expect(reasons[0]).toContain('over its budget');
    expect(reasons[1]).toContain('over its ceiling');
  });

  it('keeps every probe budget positive and the startup probes under 120 MB', () => {
    for (const probe of PROBES) expect(probe.maxModules).toBeGreaterThan(0);
    for (const name of ['version', 'help']) {
      expect(PROBES.find((probe) => probe.name === name)?.maxRssMb).toBeLessThanOrEqual(120);
    }
  });
});

describe('topPackages', () => {
  it('groups loaded modules by package, largest first', () => {
    const urls = [
      'file:///r/node_modules/zod/a.js',
      'file:///r/node_modules/zod/b.js',
      'file:///r/node_modules/@cleocode/lafs/dist/x.js',
      'file:///r/packages/core/dist/y.js',
      'node:fs',
    ];
    expect(topPackages(urls)).toEqual(['     2 zod', '     1 @cleocode/lafs', '     1 core']);
  });
});

describe('buildPrecondition (review LOW on #1812)', () => {
  const current = {
    entryExists: true,
    entryMtimeMs: 2000,
    isBundle: true,
    newest: { path: 'packages/core/src/x.ts', mtimeMs: 1000 },
  };

  it('measures a current esbuild bundle', () => {
    expect(buildPrecondition(current, false)).toEqual({ action: 'measure' });
    expect(buildPrecondition(current, true)).toEqual({ action: 'measure' });
  });

  it.each([
    ['a missing build', { ...current, entryExists: false }, /is missing/],
    ['a stale build', { ...current, entryMtimeMs: 500 }, /older than packages\/core\/src\/x\.ts/],
    [
      'tsc output in place of the bundle',
      { ...current, isBundle: false },
      /not the esbuild bundle/,
    ],
  ])('skips %s locally and fails it in CI', (_name, build, reason) => {
    const local = buildPrecondition(build, false);
    expect(local.action).toBe('skip');
    expect(local.message).toMatch(reason);
    expect(local.message).toMatch(/^skipped: no current build/);
    const ci = buildPrecondition(build, true);
    expect(ci.action).toBe('fail');
    expect(ci.message).toMatch(reason);
  });

  it('uses the exit code cleo check arch reports as skipped', () => {
    expect(SKIPPED_EXIT_CODE).toBe(78);
  });
});
