/**
 * Sentient Daemon Entry Point — spawned by `spawnSentientDaemon()`.
 *
 * Runs as a detached background process. Receives the project root as
 * argv[2]. Does NOT import the CLI shim — only the sentient/ subtree.
 *
 * Environment variables (set by `cleo daemon install --saga <id>` / systemd
 * unit or launchd plist — AC3/T11497):
 *   CLEO_SENTIENT_SAGA  — restrict the task picker to this Saga's member tasks.
 *   CLEO_SENTIENT_EPIC  — restrict the task picker to children of this Epic.
 *
 * @see sentient/daemon.ts for spawn logic
 * @task T946
 * @task T11497 E5-HEADLESS AC3
 */

import { cwd } from 'node:process';
import { bootstrapDaemon } from './daemon.js';

const projectRoot = process.argv[2] ?? cwd();

// Read scope env vars written by `cleo daemon install --saga <id>` (AC3).
const scopeSagaId = process.env['CLEO_SENTIENT_SAGA'] || undefined;
const scopeEpicId = process.env['CLEO_SENTIENT_EPIC'] || undefined;

bootstrapDaemon(projectRoot, { scopeSagaId, scopeEpicId }).catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`[CLEO SENTIENT] Fatal daemon error: ${message}\n`);
  process.exit(1);
});
