/**
 * `memory observe` fails loudly when the extraction gate stores nothing
 * (T13949, owner decision D11181): a duplicate merged into an existing entry
 * used to come back as success with the existing id, so callers believed a
 * new memory had been written.
 *
 * @task T13949
 */

import { describe, expect, it, vi } from 'vitest';

const { memoryObserve } = vi.hoisted(() => ({ memoryObserve: vi.fn() }));

vi.mock('@cleocode/core/memory/engine-compat', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@cleocode/core/memory/engine-compat')>()),
  memoryObserve,
}));

import { MemoryHandler } from '../memory.js';

describe('memory.observe when nothing is stored (T13949)', () => {
  it('returns E_OBSERVE_NOT_STORED naming the entry a duplicate merged into', async () => {
    memoryObserve.mockResolvedValueOnce({
      success: true,
      data: {
        id: 'O-existing',
        type: 'discovery',
        createdAt: '2026-10-23 00:00:00',
        stored: false,
        gateAction: 'merged',
        gateReason: 'content hash duplicate',
      },
    });
    const result = await new MemoryHandler().mutate('observe', { text: 'already known' });
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('E_OBSERVE_NOT_STORED');
    expect(result.error?.message).toContain('O-existing');
  });

  it('still succeeds with the new id when a row is stored', async () => {
    memoryObserve.mockResolvedValueOnce({
      success: true,
      data: { id: 'O-new', type: 'discovery', createdAt: '2026-10-23 00:00:00' },
    });
    const result = await new MemoryHandler().mutate('observe', { text: 'something new' });
    expect(result.success).toBe(true);
    expect((result.data as { id: string }).id).toBe('O-new');
  });
});
