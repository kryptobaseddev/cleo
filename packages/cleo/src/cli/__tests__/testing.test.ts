/**
 * Tests for testing CLI command (native citty).
 * @task T4551
 * @epic T4545
 */

import { describe, expect, it } from 'vitest';
import { testingCommand } from '../commands/testing.js';

describe('testingCommand (native citty)', () => {
  it('exports a command with the correct name', () => {
    expect(testingCommand).toBeDefined();
    const meta =
      typeof testingCommand.meta === 'function' ? testingCommand.meta() : testingCommand.meta;
    expect((meta as { name: string }).name).toBe('testing');
  });

  it('has a description containing "testing protocol"', () => {
    const meta =
      typeof testingCommand.meta === 'function' ? testingCommand.meta() : testingCommand.meta;
    expect((meta as { description: string }).description).toContain('testing protocol');
  });

  it('has validate and check subCommands', () => {
    const subs = testingCommand.subCommands as Record<string, unknown> | undefined;
    expect(subs).toBeDefined();
    expect(subs?.['validate']).toBeDefined();
    expect(subs?.['check']).toBeDefined();
  });
});
