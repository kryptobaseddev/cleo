/**
 * CLI project command structure tests — verify command wiring for
 * project move, rename, and re-register subcommands.
 *
 * @task T11017
 * @epic T10298
 */

import { describe, expect, it } from 'vitest';
import { projectCommand } from '../commands/project.js';

describe('project command group', () => {
  it('exports projectCommand with meta.name "project"', () => {
    expect(projectCommand.meta.name).toBe('project');
    expect(projectCommand.meta.description).toContain('move');
    expect(projectCommand.meta.description).toContain('rename');
    expect(projectCommand.meta.description).toContain('re-register');
  });

  it('has move, re-register, and rename subcommands', () => {
    const subs = projectCommand.subCommands as Record<string, unknown>;
    expect(subs).toHaveProperty('move');
    expect(subs).toHaveProperty('re-register');
    expect(subs).toHaveProperty('rename');
  });

  describe('re-register subcommand', () => {
    const subs = projectCommand.subCommands as Record<
      string,
      { meta?: { name: string; description: string }; args?: Record<string, unknown> }
    >;
    const cmd = subs['re-register'];

    it('has name "re-register"', () => {
      expect(cmd?.meta?.name).toBe('re-register');
    });

    it('accepts --fix flag', () => {
      expect(cmd?.args).toHaveProperty('fix');
      const fixArg = cmd?.args?.['fix'] as { type: string; default: boolean } | undefined;
      expect(fixArg?.type).toBe('boolean');
      expect(fixArg?.default).toBe(false);
    });

    it('accepts --json flag', () => {
      expect(cmd?.args).toHaveProperty('json');
      const jsonArg = cmd?.args?.['json'] as { type: string; default: boolean } | undefined;
      expect(jsonArg?.type).toBe('boolean');
      expect(jsonArg?.default).toBe(false);
    });

    it('has no positional args (operates on CWD project)', () => {
      const argEntries = Object.entries(cmd?.args ?? {});
      const positional = argEntries.filter(([, v]) => {
        const a = v as { type: string };
        return a.type === 'positional';
      });
      expect(positional).toHaveLength(0);
    });
  });
});
