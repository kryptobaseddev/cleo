/**
 * Tests for web CLI command (native citty).
 * @task T4551 / T717
 * @epic T4545
 */

import { describe, expect, it } from 'vitest';
import { webCommand } from '../commands/web.js';

describe('webCommand (native citty)', () => {
  it('exports a command with the correct name', () => {
    expect(webCommand).toBeDefined();
    const meta = typeof webCommand.meta === 'function' ? webCommand.meta() : webCommand.meta;
    expect((meta as { name: string }).name).toBe('web');
  });

  it('has a description containing "Web UI"', () => {
    const meta = typeof webCommand.meta === 'function' ? webCommand.meta() : webCommand.meta;
    expect((meta as { description: string }).description).toContain('Web UI');
  });

  it('has start, stop, restart, status, open subCommands', () => {
    const subs = webCommand.subCommands as Record<string, unknown> | undefined;
    expect(subs).toBeDefined();
    expect(subs?.['start']).toBeDefined();
    expect(subs?.['stop']).toBeDefined();
    expect(subs?.['restart']).toBeDefined();
    expect(subs?.['status']).toBeDefined();
    expect(subs?.['open']).toBeDefined();
  });

  it('start subCommand has --port and --host args', () => {
    const subs = webCommand.subCommands as
      | Record<string, { args?: Record<string, { type: string; default?: string }> }>
      | undefined;
    const startArgs = subs?.['start']?.args;
    expect(startArgs?.['port']).toBeDefined();
    expect(startArgs?.['host']).toBeDefined();
  });

  it('start defaults port to 3456 and host to 127.0.0.1', () => {
    const subs = webCommand.subCommands as
      | Record<string, { args?: Record<string, { type: string; default?: string }> }>
      | undefined;
    const startArgs = subs?.['start']?.args;
    expect(startArgs?.['port']?.default).toBe('3456');
    expect(startArgs?.['host']?.default).toBe('127.0.0.1');
  });

  it('restart subCommand has --port and --host args with correct defaults (T717 regression guard)', () => {
    // T717: ensure restart has its own port/host config rather than delegating to start's action
    const subs = webCommand.subCommands as
      | Record<string, { args?: Record<string, { type: string; default?: string }> }>
      | undefined;
    const restartArgs = subs?.['restart']?.args;
    expect(restartArgs?.['port']).toBeDefined();
    expect(restartArgs?.['host']).toBeDefined();
    expect(restartArgs?.['port']?.default).toBe('3456');
    expect(restartArgs?.['host']?.default).toBe('127.0.0.1');
  });
});
