/**
 * Tests for docs CLI command (native citty).
 * @task T4551 (sync/gap-check), T797 (add/list/fetch/remove)
 * @epic T4545 (legacy), T760 (attachments)
 */

import { describe, expect, it } from 'vitest';
import { docsCommand } from '../commands/docs.js';

describe('docsCommand (native citty)', () => {
  it('exports a command with the correct name', () => {
    expect(docsCommand).toBeDefined();
    const meta = typeof docsCommand.meta === 'function' ? docsCommand.meta() : docsCommand.meta;
    expect((meta as { name: string }).name).toBe('docs');
  });

  it('has a description containing "Documentation"', () => {
    const meta = typeof docsCommand.meta === 'function' ? docsCommand.meta() : docsCommand.meta;
    expect((meta as { description: string }).description).toContain('Documentation');
  });

  it('has sync and gap-check subcommands', () => {
    const subs = docsCommand.subCommands as Record<string, unknown> | undefined;
    expect(subs).toBeDefined();
    expect(subs?.['sync']).toBeDefined();
    expect(subs?.['gap-check']).toBeDefined();
  });

  it('has add, list, fetch, remove subcommands', () => {
    const subs = docsCommand.subCommands as Record<string, unknown> | undefined;
    expect(subs?.['add']).toBeDefined();
    expect(subs?.['list']).toBeDefined();
    expect(subs?.['fetch']).toBeDefined();
    expect(subs?.['remove']).toBeDefined();
  });
});
