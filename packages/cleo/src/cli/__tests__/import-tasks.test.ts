/**
 * Tests for import-tasks CLI command (native citty).
 * @task T4551
 * @epic T4545
 */

import { describe, expect, it } from 'vitest';
import { importTasksCommand } from '../commands/import-tasks.js';

describe('importTasksCommand (native citty)', () => {
  it('exports a command with the correct name', () => {
    expect(importTasksCommand).toBeDefined();
    const meta =
      typeof importTasksCommand.meta === 'function'
        ? importTasksCommand.meta()
        : importTasksCommand.meta;
    expect((meta as { name: string }).name).toBe('import-tasks');
  });

  it('has a description containing "ID remapping"', () => {
    const meta =
      typeof importTasksCommand.meta === 'function'
        ? importTasksCommand.meta()
        : importTasksCommand.meta;
    expect((meta as { description: string }).description).toContain('ID remapping');
  });

  it('requires a file positional argument', () => {
    const args = importTasksCommand.args as
      | Record<string, { type: string; required?: boolean }>
      | undefined;
    expect(args?.['file']).toBeDefined();
    expect(args?.['file'].type).toBe('positional');
    expect(args?.['file'].required).toBe(true);
  });

  it('defines all conflict resolution args', () => {
    const args = importTasksCommand.args as
      | Record<string, { type: string; default?: string }>
      | undefined;
    expect(args?.['dry-run']).toBeDefined();
    expect(args?.['parent']).toBeDefined();
    expect(args?.['phase']).toBeDefined();
    expect(args?.['add-label']).toBeDefined();
    expect(args?.['no-provenance']).toBeDefined();
    expect(args?.['reset-status']).toBeDefined();
    expect(args?.['on-conflict']).toBeDefined();
    expect(args?.['on-missing-dep']).toBeDefined();
    expect(args?.['force']).toBeDefined();
  });

  it('defaults on-conflict to fail', () => {
    const args = importTasksCommand.args as
      | Record<string, { type: string; default?: string }>
      | undefined;
    expect(args?.['on-conflict']?.default).toBe('fail');
  });

  it('defaults on-missing-dep to strip', () => {
    const args = importTasksCommand.args as
      | Record<string, { type: string; default?: string }>
      | undefined;
    expect(args?.['on-missing-dep']?.default).toBe('strip');
  });
});
