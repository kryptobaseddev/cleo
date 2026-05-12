/**
 * Tests for validateSpawnRequest — FISE-2 Lead authorship bypass prevention (T9231).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { validateSpawnRequest } from '../ivtr-loop.js';

// Mock the audit module to control delegate_task events
vi.mock('../../audit.js', () => ({
  queryAudit: vi.fn(),
}));

async function mockQueryAudit(
  entries: Array<{ operation: string; domain: string; result: { success: boolean } }>,
) {
  const { queryAudit } = await import('../../audit.js');
  (queryAudit as ReturnType<typeof vi.fn>).mockResolvedValue(entries);
}

describe('validateSpawnRequest (FISE-2 / T9231)', () => {
  const originalRole = process.env['CLEO_AGENT_ROLE'];

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    if (originalRole === undefined) {
      delete process.env['CLEO_AGENT_ROLE'];
    } else {
      process.env['CLEO_AGENT_ROLE'] = originalRole;
    }
  });

  it('allows non-implemented gate writes without restriction', async () => {
    process.env['CLEO_AGENT_ROLE'] = 'lead';
    const result = await validateSpawnRequest('T9001', 'testsPassed', 'ses_123');
    expect(result.allowed).toBe(true);
  });

  it('allows implemented gate write for worker role', async () => {
    process.env['CLEO_AGENT_ROLE'] = 'worker';
    const result = await validateSpawnRequest('T9001', 'implemented', 'ses_123');
    expect(result.allowed).toBe(true);
  });

  it('allows implemented gate write when no role set', async () => {
    delete process.env['CLEO_AGENT_ROLE'];
    const result = await validateSpawnRequest('T9001', 'implemented', 'ses_123');
    expect(result.allowed).toBe(true);
  });

  it('allows implemented gate write when no sessionId', async () => {
    process.env['CLEO_AGENT_ROLE'] = 'lead';
    const result = await validateSpawnRequest('T9001', 'implemented', null);
    expect(result.allowed).toBe(true);
  });

  it('blocks implemented gate write for Lead with no delegate_task events', async () => {
    process.env['CLEO_AGENT_ROLE'] = 'lead';
    await mockQueryAudit([
      // No delegate_task or spawn events
      { operation: 'show', domain: 'tasks', result: { success: true } },
    ]);
    const result = await validateSpawnRequest('T9001', 'implemented', 'ses_123');
    expect(result.allowed).toBe(false);
    expect(result.code).toBe('E_LEAD_AUTHORSHIP_BYPASS');
    expect(result.message).toContain('T9001');
  });

  it('allows implemented gate write for Lead with delegate_task event', async () => {
    process.env['CLEO_AGENT_ROLE'] = 'lead';
    await mockQueryAudit([
      { operation: 'delegate_task', domain: 'tasks', result: { success: true } },
    ]);
    const result = await validateSpawnRequest('T9001', 'implemented', 'ses_123');
    expect(result.allowed).toBe(true);
  });

  it('allows implemented gate write for Lead with successful orchestrate.spawn event', async () => {
    process.env['CLEO_AGENT_ROLE'] = 'lead';
    await mockQueryAudit([
      { operation: 'spawn', domain: 'orchestrate', result: { success: true } },
    ]);
    const result = await validateSpawnRequest('T9001', 'implemented', 'ses_123');
    expect(result.allowed).toBe(true);
  });

  it('blocks even if orchestrate.spawn failed (success=false)', async () => {
    process.env['CLEO_AGENT_ROLE'] = 'lead';
    await mockQueryAudit([
      // spawn attempt that failed — does not count
      { operation: 'spawn', domain: 'orchestrate', result: { success: false } },
    ]);
    const result = await validateSpawnRequest('T9001', 'implemented', 'ses_123');
    expect(result.allowed).toBe(false);
    expect(result.code).toBe('E_LEAD_AUTHORSHIP_BYPASS');
  });
});
