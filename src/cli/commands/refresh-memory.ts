/**
 * CLI command: cleo refresh-memory
 * Regenerates .cleo/memory-bridge.md from brain.db.
 *
 * @task T5240
 */

import { getProjectRoot } from '@cleocode/core';
import type { Command } from 'commander';

export function registerRefreshMemoryCommand(program: Command): void {
  program
    .command('refresh-memory')
    .description('Regenerate .cleo/memory-bridge.md from brain.db')
    .action(async () => {
      const projectDir = getProjectRoot();
      const { writeMemoryBridge } = await import('../../core/memory/memory-bridge.js');
      const result = await writeMemoryBridge(projectDir);

      if (result.written) {
        process.stdout.write(`Memory bridge refreshed at ${result.path}\n`);
      } else {
        process.stdout.write(`Memory bridge unchanged at ${result.path}\n`);
      }
    });
}
