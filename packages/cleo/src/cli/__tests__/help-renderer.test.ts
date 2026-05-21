/**
 * Tests for the grouped help renderer and its SSoT-derived command groups.
 *
 * Covers:
 *  1. `buildCommandGroups` puts commands into their declared categories.
 *  2. `renderGroupedHelp` output contains all known command categories.
 *  3. A new command with a `cliCategory` annotation auto-categorizes without
 *     any edits to help-renderer.ts.
 *  4. Commands absent from CLI_COMMAND_CATEGORIES fall through to OTHER.
 *  5. Alias detection (same CommandDef reference → alias, IMPLICIT_ALIASES).
 *
 * @task T9815
 */

import { buildCommandGroups, CLI_COMMAND_CATEGORIES } from '@cleocode/core/internal';
import type { CommandDef } from 'citty';
import { describe, expect, it } from 'vitest';
import { buildAliasMap, renderGroupedHelp } from '../help-renderer.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a minimal CommandDef stub for testing. */
function makeCmd(name: string, description = `${name} description`): CommandDef {
  return {
    meta: { name, description },
    run: async () => {},
  };
}

/** Build a subCommands record with no aliases. */
function makeSubCommands(names: string[]): Record<string, CommandDef> {
  const result: Record<string, CommandDef> = {};
  for (const name of names) {
    result[name] = makeCmd(name);
  }
  return result;
}

// ---------------------------------------------------------------------------
// buildCommandGroups — unit tests
// ---------------------------------------------------------------------------

describe('buildCommandGroups', () => {
  it('returns groups in canonical category order', () => {
    const groups = buildCommandGroups(['add', 'session', 'version']);
    const names = groups.map((g) => g.name);
    const addIdx = names.indexOf('Task Management');
    const sessionIdx = names.indexOf('Sessions & Planning');
    const adminIdx = names.indexOf('System & Admin');
    expect(addIdx).toBeGreaterThanOrEqual(0);
    expect(sessionIdx).toBeGreaterThanOrEqual(0);
    expect(adminIdx).toBeGreaterThanOrEqual(0);
    expect(addIdx).toBeLessThan(sessionIdx);
    expect(sessionIdx).toBeLessThan(adminIdx);
  });

  it('puts "add" in Task Management', () => {
    const groups = buildCommandGroups(['add']);
    const group = groups.find((g) => g.name === 'Task Management');
    expect(group).toBeDefined();
    expect(group?.commands).toContain('add');
  });

  it('puts "add-batch" in Task Management (new command auto-categorizes)', () => {
    const groups = buildCommandGroups(['add-batch']);
    const group = groups.find((g) => g.name === 'Task Management');
    expect(group).toBeDefined();
    expect(group?.commands).toContain('add-batch');
  });

  it('puts "orchestrate" in Research & Orchestration', () => {
    const groups = buildCommandGroups(['orchestrate']);
    const group = groups.find((g) => g.name === 'Research & Orchestration');
    expect(group?.commands).toContain('orchestrate');
  });

  it('omits empty groups', () => {
    const groups = buildCommandGroups(['add']);
    const empty = groups.find((g) => g.commands.length === 0);
    expect(empty).toBeUndefined();
  });

  it('omits commands not registered', () => {
    // Pass a restricted set that only contains "session"
    const groups = buildCommandGroups(['session']);
    const taskMgmt = groups.find((g) => g.name === 'Task Management');
    // "add" is in Task Management but not in the registered set — should be absent
    expect(taskMgmt).toBeUndefined();
  });

  it('includes all registered commands that are in CLI_COMMAND_CATEGORIES', () => {
    const registered = ['add', 'session', 'nexus', 'version'];
    const groups = buildCommandGroups(registered);
    const allGroupedCmds = groups.flatMap((g) => g.commands);
    for (const cmd of registered) {
      expect(allGroupedCmds).toContain(cmd);
    }
  });

  it('accepts categoryOverrides to dynamically categorize new commands', () => {
    const groups = buildCommandGroups(['my-new-cmd'], { 'my-new-cmd': 'Task Management' });
    const group = groups.find((g) => g.name === 'Task Management');
    expect(group?.commands).toContain('my-new-cmd');
  });

  it('returns no groups when registeredCommands is empty', () => {
    const groups = buildCommandGroups([]);
    expect(groups).toHaveLength(0);
  });

  it('passes with undefined registeredCommands (includes all from map)', () => {
    const groups = buildCommandGroups(undefined);
    // Should include every command in CLI_COMMAND_CATEGORIES
    const allGroupedCmds = groups.flatMap((g) => g.commands);
    for (const cmd of Object.keys(CLI_COMMAND_CATEGORIES)) {
      expect(allGroupedCmds).toContain(cmd);
    }
  });
});

// ---------------------------------------------------------------------------
// CLI_COMMAND_CATEGORIES — completeness check
// ---------------------------------------------------------------------------

describe('CLI_COMMAND_CATEGORIES', () => {
  it('has no duplicate keys (TypeScript enforces this at compile time, verified at runtime)', () => {
    const seen = new Set<string>();
    for (const cmd of Object.keys(CLI_COMMAND_CATEGORIES)) {
      expect(seen.has(cmd)).toBe(false);
      seen.add(cmd);
    }
  });

  it('categorizes "add-batch" that previously fell through to OTHER', () => {
    expect(CLI_COMMAND_CATEGORIES['add-batch']).toBe('Task Management');
  });

  it('categorizes "saga" that was previously uncategorized', () => {
    expect(CLI_COMMAND_CATEGORIES['saga']).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// buildAliasMap — unit tests
// ---------------------------------------------------------------------------

describe('buildAliasMap', () => {
  it('detects aliases by shared reference identity', () => {
    const shared = makeCmd('complete');
    const subCmds: Record<string, CommandDef> = {
      complete: shared,
      done: shared, // alias
    };
    const map = buildAliasMap(subCmds);
    expect(map.has('done')).toBe(true);
    expect(map.get('done')).toBe('complete');
    expect(map.has('complete')).toBe(false);
  });

  it('includes implicit alias "tags" → "labels"', () => {
    const subCmds = makeSubCommands(['labels', 'tags']);
    const map = buildAliasMap(subCmds);
    expect(map.get('tags')).toBe('labels');
  });
});

// ---------------------------------------------------------------------------
// renderGroupedHelp — integration tests
// ---------------------------------------------------------------------------

describe('renderGroupedHelp', () => {
  it('renders TASK MANAGEMENT section when "add" is registered', () => {
    const subCmds = makeSubCommands(['add', 'show', 'version']);
    const aliasMap = buildAliasMap(subCmds);
    const output = renderGroupedHelp('1.0.0', subCmds, aliasMap);
    expect(output).toContain('TASK MANAGEMENT');
    expect(output).toContain('add');
  });

  it('renders SYSTEM & ADMIN section when "version" is registered', () => {
    const subCmds = makeSubCommands(['version', 'init']);
    const aliasMap = buildAliasMap(subCmds);
    const output = renderGroupedHelp('1.0.0', subCmds, aliasMap);
    expect(output).toContain('SYSTEM & ADMIN');
  });

  it('new command with known category appears under its category (no help-renderer edit)', () => {
    // "add-batch" was a command that previously fell through to OTHER.
    // After T9815 it should appear in TASK MANAGEMENT.
    const subCmds = makeSubCommands(['add-batch', 'version']);
    const aliasMap = buildAliasMap(subCmds);
    const output = renderGroupedHelp('1.0.0', subCmds, aliasMap);
    expect(output).toContain('TASK MANAGEMENT');
    expect(output).toContain('add-batch');
    // Should NOT appear under OTHER
    const otherIdx = output.indexOf('OTHER');
    if (otherIdx !== -1) {
      const otherSection = output.slice(otherIdx);
      expect(otherSection).not.toContain('add-batch');
    }
  });

  it('command not in CLI_COMMAND_CATEGORIES falls through to OTHER', () => {
    const subCmds = makeSubCommands(['totally-unknown-cmd']);
    const aliasMap = buildAliasMap(subCmds);
    const output = renderGroupedHelp('1.0.0', subCmds, aliasMap);
    expect(output).toContain('OTHER');
    expect(output).toContain('totally-unknown-cmd');
  });

  it('includes USAGE header', () => {
    const subCmds = makeSubCommands(['add']);
    const aliasMap = buildAliasMap(subCmds);
    const output = renderGroupedHelp('2.0.0', subCmds, aliasMap);
    expect(output).toContain('USAGE');
    expect(output).toContain('cleo <command>');
    expect(output).toContain('v2.0.0');
  });

  it('shows alias next to primary command', () => {
    const completeCmd = makeCmd('complete', 'Mark task complete');
    const subCmds: Record<string, CommandDef> = {
      complete: completeCmd,
      done: completeCmd, // alias by identity
    };
    const aliasMap = buildAliasMap(subCmds);
    const output = renderGroupedHelp('1.0.0', subCmds, aliasMap);
    // "done" alias should appear inline with "complete"
    expect(output).toMatch(/complete\s*\(done\)/);
    // "done" should NOT appear as its own top-level command line
    const lines = output.split('\n');
    const doneOwnLine = lines.some((l) => l.match(/^\s+done\s/) && !l.includes('complete'));
    expect(doneOwnLine).toBe(false);
  });

  it('OTHER bucket is empty when all registered commands are in the category map', () => {
    // Build a subCommands set where every command is in CLI_COMMAND_CATEGORIES
    const knownCmds = Object.keys(CLI_COMMAND_CATEGORIES).slice(0, 10);
    const subCmds = makeSubCommands(knownCmds);
    const aliasMap = buildAliasMap(subCmds);
    const output = renderGroupedHelp('1.0.0', subCmds, aliasMap);
    // OTHER section should not appear
    expect(output).not.toContain('OTHER');
  });
});
