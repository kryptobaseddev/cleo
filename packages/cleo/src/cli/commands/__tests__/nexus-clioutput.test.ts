/**
 * Snapshot tests for nexus.ts cliOutput migration (T1720).
 *
 * Verifies that --json output conforms to the LAFS envelope shape and
 * --human output routes through the registered nexus renderers.
 *
 * Tests cover three representative subcommands:
 *   - nexus clusters (dispatch result with communities array)
 *   - nexus context (symbol lookup with callers/callees)
 *   - nexus hot-paths (plasticity query)
 *
 * @task T1720
 * @epic T1691
 */

import { mkdirSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { setFormatContext } from '../../format-context.js';
import {
  renderNexusClusters,
  renderNexusContext,
  renderNexusHotPaths,
  renderNexusStatus,
} from '../../renderers/nexus.js';

// ---------------------------------------------------------------------------
// Test lifecycle
// ---------------------------------------------------------------------------

let suiteDir: string;

beforeEach(async () => {
  suiteDir = await mkdtemp(join(tmpdir(), 'nexus-clioutput-test-'));
  mkdirSync(join(suiteDir, 'cleo-home'), { recursive: true });
  process.env['CLEO_HOME'] = join(suiteDir, 'cleo-home');
  // Default to json format for isolation
  setFormatContext({ format: 'json', source: 'default', quiet: false });
});

afterEach(async () => {
  setFormatContext({ format: 'json', source: 'default', quiet: false });
  delete process.env['CLEO_HOME'];
  await rm(suiteDir, { recursive: true, force: true });
});

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

// ---------------------------------------------------------------------------
// cliOutput integration — JSON envelope shape validation
// ---------------------------------------------------------------------------

describe('cliOutput — LAFS envelope shape for nexus commands', () => {
  it('emits valid LAFS envelope in json format', async () => {
    const { cliOutput } = await import('../../renderers/index.js');
    setFormatContext({ format: 'json', source: 'flag', quiet: false });

    let written = '';
    const origWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = (chunk: unknown): boolean => {
      written += String(chunk);
      return true;
    };

    try {
      cliOutput(
        { paths: [], count: 0 },
        { command: 'nexus-hot-paths', operation: 'nexus.hot-paths' },
      );
    } finally {
      process.stdout.write = origWrite;
    }

    expect(written.length).toBeGreaterThan(0);
    const envelope = JSON.parse(written.trim()) as Record<string, unknown>;
    expect(envelope['success']).toBe(true);
    expect(envelope['meta']).toBeDefined();
    const meta = envelope['meta'] as Record<string, unknown>;
    expect(meta['operation']).toBe('nexus.hot-paths');
    expect(meta['timestamp']).toBeDefined();
  });

  it('emits human output via renderer in human format', async () => {
    const { cliOutput } = await import('../../renderers/index.js');
    setFormatContext({ format: 'human', source: 'flag', quiet: false });

    let written = '';
    const origWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = (chunk: unknown): boolean => {
      written += String(chunk);
      return true;
    };

    try {
      cliOutput(
        { paths: [], count: 0 },
        { command: 'nexus-hot-paths', operation: 'nexus.hot-paths' },
      );
    } finally {
      process.stdout.write = origWrite;
      setFormatContext({ format: 'json', source: 'default', quiet: false });
    }

    expect(written.length).toBeGreaterThan(0);
    expect(written).toContain('[nexus] No hot paths found');
  });

  it('emits human clusters output via nexus-clusters renderer', async () => {
    const { cliOutput } = await import('../../renderers/index.js');
    setFormatContext({ format: 'human', source: 'flag', quiet: false });

    let written = '';
    const origWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = (chunk: unknown): boolean => {
      written += String(chunk);
      return true;
    };

    try {
      cliOutput(
        {
          projectId: 'test-proj',
          communities: [{ id: 'c1', label: 'core', symbolCount: 100, cohesion: 0.8 }],
        },
        { command: 'nexus-clusters', operation: 'nexus.clusters' },
      );
    } finally {
      process.stdout.write = origWrite;
      setFormatContext({ format: 'json', source: 'default', quiet: false });
    }

    expect(written.length).toBeGreaterThan(0);
    expect(written).toContain('test-proj');
    expect(written).toContain('core');
    expect(written).toContain('0.800');
  });
});
