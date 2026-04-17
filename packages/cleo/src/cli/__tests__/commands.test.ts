/**
 * Tests for commands CLI command (native citty).
 * @task T4551
 * @epic T4545
 */

import { describe, expect, it } from 'vitest';
import { commandsCommand } from '../commands/commands.js';

describe('commandsCommand (native citty)', () => {
  it('exports a command with the correct name', () => {
    expect(commandsCommand).toBeDefined();
    const meta =
      typeof commandsCommand.meta === 'function' ? commandsCommand.meta() : commandsCommand.meta;
    expect((meta as { name: string }).name).toBe('commands');
  });

  it('has a description mentioning DEPRECATED or ops', () => {
    const meta =
      typeof commandsCommand.meta === 'function' ? commandsCommand.meta() : commandsCommand.meta;
    const desc = (meta as { description: string }).description;
    expect(desc).toMatch(/DEPRECATED|ops|List and query/);
  });

  it('defines --category, --relevance, --tier args', () => {
    const args = commandsCommand.args as Record<string, { type: string }> | undefined;
    expect(args).toBeDefined();
    expect(args?.['category']).toBeDefined();
    expect(args?.['relevance']).toBeDefined();
    expect(args?.['tier']).toBeDefined();
  });

  it('accepts an optional command name positional argument', () => {
    const args = commandsCommand.args as
      | Record<string, { type: string; required?: boolean }>
      | undefined;
    const commandArg = args?.['command'];
    expect(commandArg).toBeDefined();
    expect(commandArg?.type).toBe('positional');
    expect(commandArg?.required).toBeFalsy();
  });
});
