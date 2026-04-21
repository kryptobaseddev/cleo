/**
 * Tests for nexus group subcommand alias (T1114).
 * Verifies that `cleo nexus group` is an alias for `cleo nexus contracts`
 * with identical subcommands (sync, show, link-tasks).
 *
 * @task T1114
 */

import { describe, expect, it } from 'vitest';
import { nexusCommand } from '../nexus.js';

describe('nexus group alias (T1114)', () => {
  it('should define group as a subcommand of nexus', () => {
    const subcommandNames = Object.keys(nexusCommand.subCommands ?? {});
    expect(subcommandNames).toContain('group');
  });

  it('should define group with same children as contracts', () => {
    const groupCmd = nexusCommand.subCommands?.['group'];
    const contractsCmd = nexusCommand.subCommands?.['contracts'];

    expect(groupCmd).toBeDefined();
    expect(contractsCmd).toBeDefined();

    const groupChildren = Object.keys(groupCmd?.subCommands ?? {});
    const contractsChildren = Object.keys(contractsCmd?.subCommands ?? {});

    expect(groupChildren).toEqual(contractsChildren);
  });

  it('should have sync, show, and link-tasks children', () => {
    const groupCmd = nexusCommand.subCommands?.['group'];
    const groupChildren = Object.keys(groupCmd?.subCommands ?? {});

    expect(groupChildren).toContain('sync');
    expect(groupChildren).toContain('show');
    expect(groupChildren).toContain('link-tasks');
  });

  it('should delegate sync to same handler as contracts sync', () => {
    const groupSyncCmd = nexusCommand.subCommands?.['group']?.subCommands?.['sync'];
    const contractsSyncCmd = nexusCommand.subCommands?.['contracts']?.subCommands?.['sync'];

    expect(groupSyncCmd).toBeDefined();
    expect(contractsSyncCmd).toBeDefined();

    // Both should have the same handler (same function reference)
    expect(groupSyncCmd?.run).toBe(contractsSyncCmd?.run);
  });

  it('should delegate show to same handler as contracts show', () => {
    const groupShowCmd = nexusCommand.subCommands?.['group']?.subCommands?.['show'];
    const contractsShowCmd = nexusCommand.subCommands?.['contracts']?.subCommands?.['show'];

    expect(groupShowCmd).toBeDefined();
    expect(contractsShowCmd).toBeDefined();

    // Both should have the same handler (same function reference)
    expect(groupShowCmd?.run).toBe(contractsShowCmd?.run);
  });

  it('should delegate link-tasks to same handler as contracts link-tasks', () => {
    const groupLinkTasksCmd = nexusCommand.subCommands?.['group']?.subCommands?.['link-tasks'];
    const contractsLinkTasksCmd =
      nexusCommand.subCommands?.['contracts']?.subCommands?.['link-tasks'];

    expect(groupLinkTasksCmd).toBeDefined();
    expect(contractsLinkTasksCmd).toBeDefined();

    // Both should have the same handler (same function reference)
    expect(groupLinkTasksCmd?.run).toBe(contractsLinkTasksCmd?.run);
  });

  it('should have appropriate help description', () => {
    const groupCmd = nexusCommand.subCommands?.['group'];
    expect(groupCmd?.meta?.description).toBeDefined();
    expect(String(groupCmd?.meta?.description).toLowerCase()).toContain('alias');
  });
});
