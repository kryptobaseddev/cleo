/**
 * Sentient Daemon Entry Point — spawned by `spawnSentientDaemon()`.
 *
 * Runs as a detached background process. Receives the project root as
 * argv[2]. Does NOT import the CLI shim — only the sentient/ subtree.
 *
 * @see sentient/daemon.ts for spawn logic
 * @task T946
 */

import { cwd } from 'node:process';
import { bootstrapDaemon } from './daemon.js';

const projectRoot = process.argv[2] ?? cwd();

bootstrapDaemon(projectRoot).catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`[CLEO SENTIENT] Fatal daemon error: ${message}\n`);
  process.exit(1);
});
