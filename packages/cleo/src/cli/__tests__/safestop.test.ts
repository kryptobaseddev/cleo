/**
 * Tests for safestop CLI command (native citty).
 * @task T4551 / T4904
 * @epic T4545
 */

import { describe, expect, it } from 'vitest';
import { safestopCommand } from '../commands/safestop.js';

describe('safestopCommand (native citty)', () => {
  it('exports a command with the correct name', () => {
    expect(safestopCommand).toBeDefined();
    const meta =
      typeof safestopCommand.meta === 'function' ? safestopCommand.meta() : safestopCommand.meta;
    expect((meta as { name: string }).name).toBe('safestop');
  });

  it('has a description containing "Graceful shutdown"', () => {
    const meta =
      typeof safestopCommand.meta === 'function' ? safestopCommand.meta() : safestopCommand.meta;
    expect((meta as { description: string }).description).toContain('Graceful shutdown');
  });

  it('has --reason arg (shows usage on bare invocation instead of throwing)', () => {
    const args = safestopCommand.args as
      | Record<string, { type: string; required?: boolean }>
      | undefined;
    expect(args?.['reason']).toBeDefined();
    expect(args?.['reason'].type).toBe('string');
    // required: false so bare `cleo safestop` shows help and exits 0 (T863)
    expect(args?.['reason'].required).toBe(false);
  });

  it('has --commit, --handoff, --no-session-end, --dry-run args', () => {
    const args = safestopCommand.args as Record<string, { type: string }> | undefined;
    expect(args?.['commit']).toBeDefined();
    expect(args?.['handoff']).toBeDefined();
    expect(args?.['no-session-end']).toBeDefined();
    expect(args?.['dry-run']).toBeDefined();
  });
});
