/**
 * The sentient daemon runs as its own process and never passes through the
 * CLI dispatcher that loads `@cleocode/core/registrations`. It used to pick up
 * the hook handlers when a tick first imported `@cleocode/core/internal`;
 * since CORE stopped importing its own barrel (T14391), `daemon-entry.ts`
 * loads the registrations itself. Without that, every hook the daemon
 * dispatched would find no handler.
 *
 * `bootstrapDaemon` and the cloud-sync poll are stubbed, so importing the
 * entry starts nothing.
 *
 * @task T14391
 */

import { describe, expect, it, vi } from 'vitest';

vi.mock('../daemon.js', () => ({ bootstrapDaemon: vi.fn(async () => undefined) }));
vi.mock('../../cloud/auto-sync.js', () => ({ autoCloudSync: vi.fn(async () => undefined) }));

describe('sentient daemon-entry', () => {
  it('populates the hook registry when the entry loads', async () => {
    const { hooks } = await import('../../hooks/registry.js');
    expect(hooks.listHandlers('SessionStart')).toEqual([]);

    await import('../daemon-entry.js');

    const ids = hooks.listHandlers('SessionStart').map((h) => h.id);
    expect(ids).toContain('brain-session-start');
  });
});
