/**
 * Federated search tests — covers ranking determinism, OPT-IN federation
 * behaviour, network-failure resilience, and multi-source merge.
 *
 * @task T9731
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { computeScore, federatedSearch } from '../federated-search.js';
import { writeFederationIndex } from '../federation-store.js';

describe('computeScore (T9731)', () => {
  it('weights trust levels in expected order: builtin > trusted > community > agent-created', () => {
    const sBuiltin = computeScore('builtin', 1, 0);
    const sTrusted = computeScore('trusted', 1, 0);
    const sCommunity = computeScore('community', 1, 0);
    const sAgent = computeScore('agent-created', 1, 0);
    expect(sBuiltin).toBeGreaterThan(sTrusted);
    expect(sTrusted).toBeGreaterThan(sCommunity);
    expect(sCommunity).toBeGreaterThan(sAgent);
  });

  it('is deterministic for given inputs', () => {
    expect(computeScore('trusted', 0.6, 10)).toBe(computeScore('trusted', 0.6, 10));
  });

  it('usage factor monotonically increases', () => {
    const a = computeScore('community', 1, 0);
    const b = computeScore('community', 1, 5);
    const c = computeScore('community', 1, 100);
    expect(b).toBeGreaterThan(a);
    expect(c).toBeGreaterThan(b);
  });

  it('never returns zero for any positive textMatch + trust', () => {
    // Critical for federation discoverability — a fresh peer's never-used
    // skill should still be findable.
    expect(computeScore('community', 0.4, 0)).toBeGreaterThan(0);
  });
});

describe('federatedSearch — OPT-IN behaviour', () => {
  let tmpRoot: string;
  let federationPath: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'fed-search-'));
    federationPath = join(tmpRoot, 'federation.json');
    writeFederationIndex(
      {
        version: 1,
        entries: [
          { url: 'https://peer.example/', trust: 'verified', addedAt: '2026-01-01T00:00:00Z' },
        ],
      },
      federationPath,
    );
  });
  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('does NOT call fetchPeer when includeFederated is false', async () => {
    let called = false;
    const result = await federatedSearch({
      query: 'whatever',
      includeFederated: false,
      federationIndexPath: federationPath,
      localSkillsRoot: join(tmpRoot, 'empty'),
      fetchPeer: async () => {
        called = true;
        return [];
      },
    });
    expect(called).toBe(false);
    expect(result.results).toHaveLength(0);
  });

  it('calls fetchPeer for every non-blocked peer when includeFederated is true', async () => {
    const peers: string[] = [];
    const result = await federatedSearch({
      query: 'memory',
      includeFederated: true,
      federationIndexPath: federationPath,
      localSkillsRoot: join(tmpRoot, 'empty'),
      fetchPeer: async (peer) => {
        peers.push(peer.url);
        return [{ name: 'memory', description: 'persistent memory' }];
      },
    });
    expect(peers).toContain('https://peer.example/');
    expect(result.results.length).toBeGreaterThan(0);
    expect(result.results[0]?.source.startsWith('federation:')).toBe(true);
  });

  it('skips blocked peers', async () => {
    writeFederationIndex(
      {
        version: 1,
        entries: [
          { url: 'https://good.example/', trust: 'verified', addedAt: '' },
          { url: 'https://bad.example/', trust: 'blocked', addedAt: '' },
        ],
      },
      federationPath,
    );
    const calledFor: string[] = [];
    await federatedSearch({
      query: 'x',
      includeFederated: true,
      federationIndexPath: federationPath,
      localSkillsRoot: join(tmpRoot, 'empty'),
      fetchPeer: async (peer) => {
        calledFor.push(peer.url);
        return [{ name: 'x' }];
      },
    });
    expect(calledFor).toContain('https://good.example/');
    expect(calledFor).not.toContain('https://bad.example/');
  });
});

describe('federatedSearch — graceful degradation', () => {
  let tmpRoot: string;
  let federationPath: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'fed-search-grace-'));
    federationPath = join(tmpRoot, 'federation.json');
    writeFederationIndex(
      {
        version: 1,
        entries: [
          { url: 'https://flaky.example/', trust: 'verified', addedAt: '' },
          { url: 'https://ok.example/', trust: 'verified', addedAt: '' },
        ],
      },
      federationPath,
    );
  });
  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('individual peer failure surfaces as a warning, not a thrown error', async () => {
    const result = await federatedSearch({
      query: 'memory',
      includeFederated: true,
      federationIndexPath: federationPath,
      localSkillsRoot: join(tmpRoot, 'empty'),
      fetchPeer: async (peer) => {
        if (peer.url === 'https://flaky.example/') {
          throw new Error('connection refused');
        }
        return [{ name: 'memory' }];
      },
    });
    expect(result.warnings.some((w) => w.includes('flaky.example'))).toBe(true);
    expect(result.results.length).toBeGreaterThan(0);
  });

  it('canonical marketplace failure surfaces as a warning', async () => {
    const result = await federatedSearch({
      query: 'memory',
      localSkillsRoot: join(tmpRoot, 'empty'),
      localMarketplaceSearch: async () => {
        throw new Error('marketplace 500');
      },
    });
    expect(result.warnings.some((w) => w.includes('canonical'))).toBe(true);
  });
});

describe('federatedSearch — local + canonical merge', () => {
  let tmpRoot: string;
  let localRoot: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'fed-search-merge-'));
    localRoot = join(tmpRoot, 'skills');
    mkdirSync(join(localRoot, 'memory'), { recursive: true });
    writeFileSync(
      join(localRoot, 'memory', 'SKILL.md'),
      '---\nname: memory\ndescription: persistent memory storage\n---\n# memory\n',
    );
    mkdirSync(join(localRoot, 'unrelated'), { recursive: true });
    writeFileSync(
      join(localRoot, 'unrelated', 'SKILL.md'),
      '---\nname: unrelated\ndescription: nothing about memory\n---\n',
    );
  });
  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('matches local skills by name + description', async () => {
    const result = await federatedSearch({
      query: 'memory',
      localSkillsRoot: localRoot,
    });
    expect(result.results.some((r) => r.name === 'memory' && r.source === 'local')).toBe(true);
  });

  it('matches via description when name does not match', async () => {
    const result = await federatedSearch({
      query: 'persistent',
      localSkillsRoot: localRoot,
    });
    expect(result.results.some((r) => r.name === 'memory')).toBe(true);
  });

  it('merges canonical marketplace results with local + ranks them', async () => {
    const result = await federatedSearch({
      query: 'memory',
      localSkillsRoot: localRoot,
      localMarketplaceSearch: async () => [
        {
          name: '@cleocode/memory',
          description: 'cleo memory skill',
          scopedName: '@cleocode/memory',
        },
      ],
    });
    const sources = result.results.map((r) => r.source);
    expect(sources).toContain('local');
    expect(sources).toContain('canonical');
  });

  it('result order is deterministic (score DESC, name ASC)', async () => {
    const result = await federatedSearch({
      query: 'memory',
      localSkillsRoot: localRoot,
      localMarketplaceSearch: async () => [
        { name: 'b-memory', description: 'b' },
        { name: 'a-memory', description: 'a' },
      ],
    });
    // Ensure no equal-score adjacent pairs violate the alpha tiebreak.
    for (let i = 1; i < result.results.length; i++) {
      const prev = result.results[i - 1];
      const curr = result.results[i];
      if (!prev || !curr) continue;
      if (prev.score === curr.score) {
        expect(prev.name.localeCompare(curr.name)).toBeLessThanOrEqual(0);
      } else {
        expect(prev.score).toBeGreaterThan(curr.score);
      }
    }
  });
});
