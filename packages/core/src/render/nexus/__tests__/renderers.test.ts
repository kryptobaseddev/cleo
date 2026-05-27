/**
 * Pure-renderer tests for the nexus renderer families migrated to
 * `@cleocode/core/render/nexus/` (B7 — T10132).
 *
 * Verifies each renderer accepts the legacy `(data, quiet)` shape and
 * produces the same human-readable string the legacy CLI module emitted.
 *
 * Originally lived at
 * `packages/cleo/src/cli/commands/__tests__/nexus-clioutput.test.ts`; the
 * pure-renderer half moved here when nexus.ts was deleted, while the
 * `cliOutput` integration half stayed in `packages/cleo/`.
 *
 * @epic T10114
 * @task T10132
 */

import type { GraphNodeKind } from '@cleocode/contracts';
import { describe, expect, it } from 'vitest';
import {
  renderNexusClusters,
  renderNexusContext,
  renderNexusFullContext,
  renderNexusHotPaths,
  renderNexusStatus,
} from '../index.js';

type GraphFixtureSize = 'small' | 'medium' | 'large';

interface GraphContextPerformanceFixture {
  size: GraphFixtureSize;
  graph: {
    nodeCount: number;
    relationCount: number;
  };
  thresholds: {
    contextTokenBudget: number;
    fullContextTokenBudget: number;
    maxRenderMs: number;
    maxQueryCount: number;
  };
  observed: {
    queryCount: number;
  };
  contextData: Record<string, unknown>;
  fullContextData: Record<string, unknown>;
}

const DISPLAYED_CONTEXT_MATCHES = 5;

const estimateFixtureTokens = (text: string): number => Math.ceil(text.length / 4);

const makeKind = (index: number): GraphNodeKind => (index % 3 === 0 ? 'method' : 'function');

const makeSymbolLinks = (
  prefix: string,
  count: number,
): Array<{ name: string; kind: GraphNodeKind }> =>
  Array.from({ length: count }, (_, index) => ({
    name: `${prefix}${index + 1}`,
    kind: makeKind(index),
  }));

const makeContextResult = (
  fixtureName: GraphFixtureSize,
  index: number,
): Record<string, unknown> => ({
  name: `${fixtureName}ContextSymbol${index + 1}`,
  kind: makeKind(index),
  filePath: `src/${fixtureName}/module-${index + 1}.ts`,
  startLine: 20 + index,
  docSummary: `${fixtureName} graph context fixture symbol ${index + 1}`,
  community: { id: `${fixtureName}-community`, label: `${fixtureName}-core` },
  callers: makeSymbolLinks(`${fixtureName}Caller${index + 1}_`, 3),
  callees: makeSymbolLinks(`${fixtureName}Callee${index + 1}_`, 4),
  processes: [{ label: `${fixtureName} render flow`, role: 'entry' }],
  source: null,
});

const makeBrainMemories = (
  fixtureName: GraphFixtureSize,
  count: number,
): Array<Record<string, unknown>> =>
  Array.from({ length: count }, (_, index) => ({
    nodeType: 'learning',
    label: `${fixtureName} context memory ${index + 1}`,
    edgeType: 'documents',
    weight: 0.9 - index * 0.01,
  }));

const makeTaskLinks = (count: number): Array<{ taskId: string; weight: number }> =>
  Array.from({ length: count }, (_, index) => ({
    taskId: `T${10_000 + index}`,
    weight: 0.8 - index * 0.02,
  }));

const makePerformanceFixture = (
  size: GraphFixtureSize,
  graph: { nodeCount: number; relationCount: number },
  matchCount: number,
  thresholds: GraphContextPerformanceFixture['thresholds'],
): GraphContextPerformanceFixture => ({
  size,
  graph,
  thresholds,
  observed: {
    queryCount: size === 'small' ? 2 : size === 'medium' ? 4 : 6,
  },
  contextData: {
    matchCount,
    _symbolName: `${size}ContextSymbol`,
    _fixtureGraphSize: graph,
    _queryCount: size === 'small' ? 2 : size === 'medium' ? 4 : 6,
    results: Array.from({ length: Math.min(DISPLAYED_CONTEXT_MATCHES, matchCount) }, (_, index) =>
      makeContextResult(size, index),
    ),
  },
  fullContextData: {
    symbolId: `src/${size}/entry.ts::${size}ContextSymbol`,
    _durationMs: size === 'small' ? 3 : size === 'medium' ? 9 : 17,
    _fixtureGraphSize: graph,
    _queryCount: size === 'small' ? 2 : size === 'medium' ? 4 : 6,
    nexus: {
      kind: 'function',
      filePath: `src/${size}/entry.ts`,
      callers: makeSymbolLinks(`${size}Caller`, 16),
      callees: makeSymbolLinks(`${size}Callee`, 18),
    },
    plasticityWeight: {
      totalWeight: graph.relationCount / graph.nodeCount,
      edgeCount: graph.relationCount,
    },
    brainMemories: makeBrainMemories(size, size === 'small' ? 2 : size === 'medium' ? 8 : 24),
    tasks: makeTaskLinks(size === 'small' ? 1 : size === 'medium' ? 6 : 18),
    sentientProposals: Array.from({ length: size === 'large' ? 9 : 2 }, (_, index) => ({
      title: `${size} proposal ${index + 1}`,
      weight: 0.7 - index * 0.03,
    })),
    conduitThreads: Array.from({ length: size === 'large' ? 8 : 1 }, (_, index) => ({
      nodeId: `${size}-thread-${index + 1}`,
      weight: 0.5 - index * 0.02,
    })),
  },
});

const graphContextPerformanceFixtures: GraphContextPerformanceFixture[] = [
  makePerformanceFixture('small', { nodeCount: 24, relationCount: 48 }, 2, {
    contextTokenBudget: 700,
    fullContextTokenBudget: 700,
    maxRenderMs: 25,
    maxQueryCount: 3,
  }),
  makePerformanceFixture('medium', { nodeCount: 250, relationCount: 900 }, 12, {
    contextTokenBudget: 1_900,
    fullContextTokenBudget: 1_100,
    maxRenderMs: 35,
    maxQueryCount: 5,
  }),
  makePerformanceFixture('large', { nodeCount: 2_500, relationCount: 12_000 }, 240, {
    contextTokenBudget: 2_000,
    fullContextTokenBudget: 1_300,
    maxRenderMs: 50,
    maxQueryCount: 7,
  }),
];

// ---------------------------------------------------------------------------
// nexus clusters renderer
// ---------------------------------------------------------------------------

describe('nexus clusters — human renderer', () => {
  it('renders empty communities with a hint to run analyze', () => {
    const data = { projectId: 'proj-abc', communities: [] };
    const output = renderNexusClusters(data, false);
    expect(output).toContain('[nexus] No communities found for project proj-abc');
    expect(output).toContain("Run 'cleo nexus analyze' first");
  });

  it('renders communities with id, label, symbolCount, cohesion', () => {
    const data = {
      projectId: 'proj-test',
      communities: [
        { id: 'community:1', label: 'auth-module', symbolCount: 42, cohesion: 0.75 },
        { id: 'community:2', label: null, symbolCount: 15, cohesion: 0.3 },
      ],
    };
    const output = renderNexusClusters(data, false);
    expect(output).toContain('community:1');
    expect(output).toContain('auth-module');
    expect(output).toContain('42');
    expect(output).toContain('0.750');
    expect(output).toContain('community:2');
    expect(output).toContain('0.300');
  });

  it('returns empty string in quiet mode', () => {
    const data = {
      projectId: 'proj',
      communities: [{ id: '1', label: 'a', symbolCount: 1, cohesion: 0.5 }],
    };
    expect(renderNexusClusters(data, true)).toBe('');
  });
});

// ---------------------------------------------------------------------------
// nexus context renderer
// ---------------------------------------------------------------------------

describe('nexus context — human renderer', () => {
  it('renders "not found" message when matchCount is 0', () => {
    const data = { matchCount: 0, results: [], _symbolName: 'unknownFn' };
    const output = renderNexusContext(data, false);
    expect(output).toContain("No symbol found matching 'unknownFn'");
    expect(output).toContain('cleo nexus analyze');
  });

  it('renders symbol details with callers and callees', () => {
    const data = {
      matchCount: 1,
      _symbolName: 'dispatchFromCli',
      results: [
        {
          name: 'dispatchFromCli',
          kind: 'function',
          filePath: 'src/dispatch/adapters/cli.ts',
          startLine: 42,
          docSummary: 'Dispatches a CLI command',
          community: { id: 'c1', label: 'dispatch-layer' },
          callers: [{ name: 'runCommand', kind: 'function' }],
          callees: [{ name: 'dispatcher.dispatch', kind: 'method' }],
          processes: [{ label: 'CLI dispatch flow', role: 'entry' }],
          source: null,
        },
      ],
    };
    const output = renderNexusContext(data, false);
    expect(output).toContain('dispatchFromCli');
    expect(output).toContain('src/dispatch/adapters/cli.ts:42');
    expect(output).toContain('Dispatches a CLI command');
    expect(output).toContain('dispatch-layer');
    expect(output).toContain('runCommand[function]');
    expect(output).toContain('dispatcher.dispatch[method]');
    expect(output).toContain('CLI dispatch flow');
  });

  it('renders single-match header without "es" suffix', () => {
    const data = {
      matchCount: 1,
      _symbolName: 'myFn',
      results: [
        {
          name: 'myFn',
          kind: 'function',
          filePath: 'a.ts',
          startLine: 1,
          docSummary: null,
          community: null,
          callers: [],
          callees: [],
          processes: [],
          source: null,
        },
      ],
    };
    const output = renderNexusContext(data, false);
    expect(output).toContain('1 match)');
    expect(output).not.toContain('1 matches');
  });

  it('returns empty string in quiet mode', () => {
    const data = { matchCount: 0, results: [], _symbolName: 'x' };
    expect(renderNexusContext(data, true)).toBe('');
  });
});

// ---------------------------------------------------------------------------
// graph/context token-budget + performance fixtures
// ---------------------------------------------------------------------------

describe('nexus graph/context — token budget and performance fixtures', () => {
  it.each(
    graphContextPerformanceFixtures,
  )('keeps $size graph context output inside recorded token/query/latency thresholds', (fixture) => {
    const start = performance.now();
    const output = renderNexusContext(fixture.contextData, false);
    const elapsedMs = performance.now() - start;
    const tokenEstimate = estimateFixtureTokens(output);

    expect(fixture.graph.nodeCount).toBeGreaterThan(0);
    expect(fixture.graph.relationCount).toBeGreaterThanOrEqual(fixture.graph.nodeCount);
    expect(tokenEstimate).toBeLessThanOrEqual(fixture.thresholds.contextTokenBudget);
    expect(elapsedMs).toBeLessThanOrEqual(fixture.thresholds.maxRenderMs);
    expect(fixture.observed.queryCount).toBeLessThanOrEqual(fixture.thresholds.maxQueryCount);
  });

  it.each(
    graphContextPerformanceFixtures,
  )('keeps $size full-context output inside recorded token/query/latency thresholds', (fixture) => {
    const start = performance.now();
    const output = renderNexusFullContext(fixture.fullContextData, false);
    const elapsedMs = performance.now() - start;
    const tokenEstimate = estimateFixtureTokens(output);

    expect(output).toContain('## Living Brain:');
    expect(tokenEstimate).toBeLessThanOrEqual(fixture.thresholds.fullContextTokenBudget);
    expect(elapsedMs).toBeLessThanOrEqual(fixture.thresholds.maxRenderMs);
    expect(fixture.observed.queryCount).toBeLessThanOrEqual(fixture.thresholds.maxQueryCount);
  });

  it('reports omitted matches for medium/large context fixtures', () => {
    const omittedFixtures = graphContextPerformanceFixtures.filter(
      (fixture) => Number(fixture.contextData['matchCount']) > DISPLAYED_CONTEXT_MATCHES,
    );

    expect(omittedFixtures.map((fixture) => fixture.size)).toEqual(['medium', 'large']);
    for (const fixture of omittedFixtures) {
      const output = renderNexusContext(fixture.contextData, false);
      expect(output).toContain(
        `Showing ${DISPLAYED_CONTEXT_MATCHES} of ${fixture.contextData['matchCount']} matches`,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// nexus hot-paths renderer
// ---------------------------------------------------------------------------

describe('nexus hot-paths — human renderer', () => {
  it('renders "no hot paths" when paths array is empty', () => {
    const data = { paths: [], count: 0 };
    const output = renderNexusHotPaths(data, false);
    expect(output).toContain('[nexus] No hot paths found');
  });

  it('renders markdown table header and edge rows', () => {
    const data = {
      paths: [
        {
          sourceId: 'src/a.ts::fnA',
          targetId: 'src/b.ts::fnB',
          type: 'calls',
          weight: 0.75,
          coAccessedCount: 12,
        },
        {
          sourceId: 'src/c.ts::fnC',
          targetId: 'src/d.ts::fnD',
          type: 'imports',
          weight: 0.25,
          coAccessedCount: 3,
        },
      ],
      count: 2,
    };
    const output = renderNexusHotPaths(data, false);
    expect(output).toContain('| Source | Target | Edge Type | Weight | Co-Access |');
    expect(output).toContain('src/a.ts::fnA');
    expect(output).toContain('0.7500');
    expect(output).toContain('12');
    expect(output).toContain('2 edge(s) shown');
  });

  it('includes note when present', () => {
    const data = { paths: [], count: 0, note: 'No dream cycle has run yet.' };
    const output = renderNexusHotPaths(data, false);
    expect(output).toContain('No dream cycle has run yet');
  });

  it('returns empty string in quiet mode', () => {
    const data = {
      paths: [{ sourceId: 'a', targetId: 'b', type: 'calls', weight: 0.5, coAccessedCount: 1 }],
      count: 1,
    };
    expect(renderNexusHotPaths(data, true)).toBe('');
  });
});

// ---------------------------------------------------------------------------
// nexus status renderer
// ---------------------------------------------------------------------------

describe('nexus status — human renderer', () => {
  it('renders NOT INDEXED when indexed is false', () => {
    const data = { projectId: 'proj', repoPath: '/my/repo', indexed: false };
    const output = renderNexusStatus(data, false);
    expect(output).toContain('NOT INDEXED');
    expect(output).toContain('/my/repo');
    expect(output).toContain('cleo nexus analyze');
  });

  it('renders full stats when indexed is true', () => {
    const data = {
      projectId: 'proj-123',
      repoPath: '/my/repo',
      indexed: true,
      nodeCount: 500,
      relationCount: 1200,
      fileCount: 80,
      lastIndexedAt: '2026-05-01T12:00:00Z',
      staleFileCount: 3,
    };
    const output = renderNexusStatus(data, false);
    expect(output).toContain('proj-123');
    expect(output).toContain('500');
    expect(output).toContain('1200');
    expect(output).toContain('80');
    expect(output).toContain('3 stale');
  });

  it('shows "up to date" when staleFileCount is 0', () => {
    const data = {
      projectId: 'p',
      repoPath: '/r',
      indexed: true,
      nodeCount: 10,
      relationCount: 20,
      fileCount: 5,
      lastIndexedAt: '2026-05-01T00:00:00Z',
      staleFileCount: 0,
    };
    const output = renderNexusStatus(data, false);
    expect(output).toContain('up to date');
  });

  it('returns empty string in quiet mode', () => {
    const data = { projectId: 'p', repoPath: '/r', indexed: false };
    expect(renderNexusStatus(data, true)).toBe('');
  });
});
