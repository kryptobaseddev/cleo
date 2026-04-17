/**
 * CLI command: cleo refresh-memory
 *
 * Regenerates .cleo/memory-bridge.md from brain.db by calling
 * writeMemoryBridge() from core/internal.
 *
 * @task T5240
 * @task T487
 */

import { getProjectRoot } from '@cleocode/core';
import { defineCommand } from 'citty';

/**
 * cleo refresh-memory — regenerate .cleo/memory-bridge.md from brain.db.
 *
 * Calls writeMemoryBridge() from @cleocode/core/internal directly (no dispatch).
 */
export const refreshMemoryCommand = defineCommand({
  meta: {
    name: 'refresh-memory',
    description: 'Regenerate .cleo/memory-bridge.md from brain.db',
  },
  async run() {
    const projectDir = getProjectRoot();
    const { writeMemoryBridge } = await import('@cleocode/core/internal');
    const result = await writeMemoryBridge(projectDir);

    if (result.written) {
      process.stdout.write(`Memory bridge refreshed at ${result.path}\n`);
    } else {
      process.stdout.write(`Memory bridge unchanged at ${result.path}\n`);
    }
  },
});
