/**
 * Hermes import classifier tests (T9733).
 *
 * Covers:
 *   1. TRUSTED_REPOS allow-list promotes to canonical.
 *   2. is_agent_created=true preserves agent-created provenance.
 *   3. Unknown URLs quarantine as community.
 *   4. Trusted URL auto-registers federation peer as `verified`.
 *   5. Re-import is idempotent (federation upsert).
 *
 * @task T9733
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { listFederationPeers, writeFederationIndex } from '../federation-store.js';
import {
  classifyHermesBatch,
  classifyHermesRecord,
  TRUSTED_REPOS_FOR_IMPORT,
} from '../hermes-import-classifier.js';

describe('classifyHermesRecord (T9733)', () => {
  let tmpRoot: string;
  let federationPath: string;
  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'hermes-classify-'));
    federationPath = join(tmpRoot, 'federation.json');
    writeFederationIndex({ version: 1, entries: [] }, federationPath);
  });
  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('TRUSTED_REPOS_FOR_IMPORT contains the three Hermes-aligned repos', () => {
    expect(TRUSTED_REPOS_FOR_IMPORT.has('openai/skills')).toBe(true);
    expect(TRUSTED_REPOS_FOR_IMPORT.has('anthropics/skills')).toBe(true);
    expect(TRUSTED_REPOS_FOR_IMPORT.has('huggingface/skills')).toBe(true);
  });

  it('owner/repo shorthand matches trusted list', () => {
    const result = classifyHermesRecord(
      { name: 'memory', sourceUrl: 'openai/skills' },
      { federationIndexPath: federationPath },
    );
    expect(result.sourceType).toBe('canonical');
    expect(result.needsReview).toBe(false);
  });

  it('github.com URL matches via owner/repo extraction', () => {
    const result = classifyHermesRecord(
      { name: 'memory', sourceUrl: 'https://github.com/openai/skills/tree/main/memory' },
      { federationIndexPath: federationPath },
    );
    expect(result.sourceType).toBe('canonical');
    expect(result.registeredFederationUrl).toBe('https://github.com/');
  });

  it('auto-registers federation peer for trusted URL', () => {
    classifyHermesRecord(
      { name: 'memory', sourceUrl: 'https://github.com/openai/skills/tree/main/memory' },
      { federationIndexPath: federationPath },
    );
    const peers = listFederationPeers(federationPath);
    expect(peers).toHaveLength(1);
    expect(peers[0]?.url).toBe('https://github.com/');
    expect(peers[0]?.trust).toBe('verified');
  });

  it('repeat import is idempotent — does NOT add duplicate peer', () => {
    for (let i = 0; i < 3; i++) {
      classifyHermesRecord(
        { name: 'memory', sourceUrl: 'https://github.com/openai/skills/tree/main/memory' },
        { federationIndexPath: federationPath },
      );
    }
    const peers = listFederationPeers(federationPath);
    expect(peers).toHaveLength(1);
  });

  it('is_agent_created=true preserves agent-created provenance regardless of URL', () => {
    const result = classifyHermesRecord(
      { name: 'auto-skill', sourceUrl: 'openai/skills', isAgentCreated: true },
      { federationIndexPath: federationPath },
    );
    expect(result.sourceType).toBe('agent-created');
    expect(result.needsReview).toBe(false);
    expect(result.registeredFederationUrl).toBeNull();
  });

  it('unknown URL classifies as community + quarantine', () => {
    const result = classifyHermesRecord(
      { name: 'sketchy', sourceUrl: 'https://random.example/skill' },
      { federationIndexPath: federationPath },
    );
    expect(result.sourceType).toBe('community');
    expect(result.needsReview).toBe(true);
    expect(result.registeredFederationUrl).toBeNull();
  });

  it('missing sourceUrl classifies as community + quarantine', () => {
    const result = classifyHermesRecord(
      { name: 'unsourced' },
      { federationIndexPath: federationPath },
    );
    expect(result.sourceType).toBe('community');
    expect(result.needsReview).toBe(true);
  });

  it('extraTrustedRepos test hook is honoured', () => {
    const result = classifyHermesRecord(
      { name: 'custom', sourceUrl: 'myorg/myrepo' },
      { federationIndexPath: federationPath, extraTrustedRepos: new Set(['myorg/myrepo']) },
    );
    expect(result.sourceType).toBe('canonical');
  });

  it('does NOT register a peer for owner/repo shorthand (no URL to register)', () => {
    classifyHermesRecord(
      { name: 'memory', sourceUrl: 'openai/skills' },
      { federationIndexPath: federationPath },
    );
    const peers = listFederationPeers(federationPath);
    expect(peers).toHaveLength(0);
  });
});

describe('classifyHermesBatch', () => {
  let tmpRoot: string;
  let federationPath: string;
  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'hermes-batch-'));
    federationPath = join(tmpRoot, 'federation.json');
    writeFederationIndex({ version: 1, entries: [] }, federationPath);
  });
  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('preserves input order', () => {
    const records = [
      { name: 'a', sourceUrl: 'openai/skills' },
      { name: 'b', isAgentCreated: true },
      { name: 'c', sourceUrl: 'https://random.example/' },
    ];
    const out = classifyHermesBatch(records, { federationIndexPath: federationPath });
    expect(out.map((r) => r.sourceType)).toEqual(['canonical', 'agent-created', 'community']);
  });
});
