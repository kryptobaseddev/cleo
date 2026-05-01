/**
 * CLI sequence command - task ID sequence management.
 * @task T4538
 * @epic T4454
 * @task T480 — fix sequence repair: route to systemSequenceRepair instead of
 *              misrouted config.set (admin.sequence mutate was removed in T5615
 *              but no correct CLI path remained).
 */

import { getProjectRoot } from '@cleocode/core/internal';
import { defineCommand, showUsage } from 'citty';
import { dispatchFromCli } from '../../dispatch/adapters/cli.js';
import { cliOutput } from '../renderers/index.js';

/** cleo sequence show — display current sequence state */
const showCommand = defineCommand({
  meta: { name: 'show', description: 'Display current sequence state' },
  async run() {
    await dispatchFromCli(
      'query',
      'admin',
      'sequence',
      { action: 'show' },
      { command: 'sequence' },
    );
  },
});

/** cleo sequence check — verify counter >= max(todo + archive) */
const checkCommand = defineCommand({
  meta: { name: 'check', description: 'Verify counter >= max(todo + archive)' },
  async run() {
    await dispatchFromCli(
      'query',
      'admin',
      'sequence',
      { action: 'check' },
      { command: 'sequence' },
    );
  },
});

/** cleo sequence repair — reset counter to max + 1 if behind */
const repairCommand = defineCommand({
  meta: { name: 'repair', description: 'Reset counter to max + 1 if behind' },
  async run() {
    // admin.sequence (mutate) was removed in T5615 with no CLI path retained.
    // Call core directly, mirroring the detect command pattern (T1571: system-engine.ts deleted).
    const { repairSequence } = await import('@cleocode/core/internal');
    const projectRoot = getProjectRoot();
    const repair = await repairSequence(projectRoot);
    const result = {
      repaired: repair.repaired,
      message: repair.message,
      counter: repair.counter,
      oldCounter: repair.oldCounter,
      newCounter: repair.newCounter,
    };
    cliOutput(result, { command: 'sequence', operation: 'admin.sequence.repair' });
  },
});

/**
 * Native citty command group for `cleo sequence`.
 *
 * Exposes show, check, and repair subcommands for task ID sequence management.
 */
export const sequenceCommand = defineCommand({
  meta: {
    name: 'sequence',
    description: 'Inspect and manage task ID sequence (show/check/repair)',
  },
  subCommands: {
    show: showCommand,
    check: checkCommand,
    repair: repairCommand,
  },
  async run({ cmd, rawArgs }) {
    const firstArg = rawArgs?.find((a) => !a.startsWith('-'));
    if (firstArg && cmd.subCommands && firstArg in cmd.subCommands) return;
    await showUsage(cmd);
  },
});
