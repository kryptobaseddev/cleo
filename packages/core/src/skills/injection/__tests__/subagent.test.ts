/**
 * Tests for subagent protocol injection with tier filtering.
 * @task T5155
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { filterProtocolByTier, injectProtocol } from '../subagent.js';

// injectProtocol reads the task for its context block; the token refusal
// below is independent of the store, so the accessor finds no task.
vi.mock('../../../store/data-accessor.js', () => ({
  getTaskAccessor: async () => ({ loadSingleTask: async () => null }),
}));

const SAMPLE_PROTOCOL = `# Protocol Header

Version: 2.0.0

<!-- TIER:minimal -->
## Minimal Content
This is tier 0 content.
<!-- /TIER:minimal -->

<!-- TIER:standard -->
## Standard Content
This is tier 1 content.
<!-- /TIER:standard -->

<!-- TIER:orchestrator -->
## Orchestrator Content
This is tier 2 content.
<!-- /TIER:orchestrator -->

## Footer
References here.`;

describe('filterProtocolByTier', () => {
  it('tier 0 includes only minimal + header + footer', () => {
    const result = filterProtocolByTier(SAMPLE_PROTOCOL, 0);
    expect(result).toContain('Protocol Header');
    expect(result).toContain('Minimal Content');
    expect(result).not.toContain('Standard Content');
    expect(result).not.toContain('Orchestrator Content');
    expect(result).toContain('Footer');
  });

  it('tier 1 includes minimal + standard + header + footer', () => {
    const result = filterProtocolByTier(SAMPLE_PROTOCOL, 1);
    expect(result).toContain('Protocol Header');
    expect(result).toContain('Minimal Content');
    expect(result).toContain('Standard Content');
    expect(result).not.toContain('Orchestrator Content');
    expect(result).toContain('Footer');
  });

  it('tier 2 includes all tiers + header + footer', () => {
    const result = filterProtocolByTier(SAMPLE_PROTOCOL, 2);
    expect(result).toContain('Protocol Header');
    expect(result).toContain('Minimal Content');
    expect(result).toContain('Standard Content');
    expect(result).toContain('Orchestrator Content');
    expect(result).toContain('Footer');
  });

  it('returns content unchanged when no tier markers present', () => {
    const plain = '# Simple content\nNo markers here.';
    expect(filterProtocolByTier(plain, 0)).toBe(plain);
    expect(filterProtocolByTier(plain, 2)).toBe(plain);
  });

  it('handles empty content', () => {
    expect(filterProtocolByTier('', 0)).toBe('');
  });

  it('preserves tier order in output', () => {
    const result = filterProtocolByTier(SAMPLE_PROTOCOL, 2);
    const minIdx = result.indexOf('Minimal Content');
    const stdIdx = result.indexOf('Standard Content');
    const orcIdx = result.indexOf('Orchestrator Content');
    expect(minIdx).toBeLessThan(stdIdx);
    expect(stdIdx).toBeLessThan(orcIdx);
  });

  it('strips tier marker tags from output', () => {
    const result = filterProtocolByTier(SAMPLE_PROTOCOL, 2);
    expect(result).not.toContain('<!-- TIER:minimal -->');
    expect(result).not.toContain('<!-- /TIER:minimal -->');
    expect(result).not.toContain('<!-- TIER:standard -->');
    expect(result).not.toContain('<!-- /TIER:standard -->');
    expect(result).not.toContain('<!-- TIER:orchestrator -->');
    expect(result).not.toContain('<!-- /TIER:orchestrator -->');
  });

  it('handles content with only one tier block', () => {
    const singleTier = `# Header
<!-- TIER:minimal -->
## Only minimal
<!-- /TIER:minimal -->
## End`;
    const result = filterProtocolByTier(singleTier, 0);
    expect(result).toContain('Header');
    expect(result).toContain('Only minimal');
    expect(result).toContain('End');
  });

  it('handles missing tier blocks gracefully', () => {
    // Content has minimal and orchestrator but no standard
    const sparse = `# Header
<!-- TIER:minimal -->
## Min
<!-- /TIER:minimal -->
<!-- TIER:orchestrator -->
## Orc
<!-- /TIER:orchestrator -->
## End`;
    const result = filterProtocolByTier(sparse, 1);
    expect(result).toContain('Header');
    expect(result).toContain('Min');
    expect(result).not.toContain('Orc');
    expect(result).toContain('End');
  });
});

describe('injectProtocol backward compatibility', () => {
  it('exports injectProtocol with tier parameter added', async () => {
    const mod = await import('../subagent.js');
    // Verify the function exists -- callers without tier still work
    // because the tier param is optional (undefined when omitted)
    expect(typeof mod.injectProtocol).toBe('function');
  });

  it('exports orchestratorSpawnSkill with tier parameter added', async () => {
    const mod = await import('../subagent.js');
    expect(typeof mod.orchestratorSpawnSkill).toBe('function');
  });

  it('exports filterProtocolByTier', async () => {
    const mod = await import('../subagent.js');
    expect(typeof mod.filterProtocolByTier).toBe('function');
  });
});

describe('injectProtocol refuses a tree command with no root id (T14673)', () => {
  it('throws for a bare {{TASK_TREE_CMD}} and renders one with a root id', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'subagent-tree-token-'));
    try {
      await expect(
        injectProtocol('Run `{{TASK_TREE_CMD}}` first.', 'T1', { EPIC_ID: 'T10' }, cwd),
      ).rejects.toMatchObject({ message: expect.stringContaining('needs a root id') });
      await expect(
        injectProtocol('Run {{TASK_TREE_CMD}} {{EPIC_ID}}.', 'T1', { EPIC_ID: '' }, cwd),
      ).rejects.toMatchObject({ message: expect.stringContaining('{{EPIC_ID}} has no value') });
      const ok = await injectProtocol(
        'Run {{TASK_TREE_CMD}} {{EPIC_ID}}.',
        'T1',
        { EPIC_ID: 'T10' },
        cwd,
      );
      expect(ok).toContain('Run cleo tree T10.');
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
