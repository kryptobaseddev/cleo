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
 * While the daemon runs it also triggers the automatic cloud sync
 * (T13468, `cloud/auto-sync.ts`) once a minute; the sync throttles itself to
 * its interval. It lives here, in the detached process, never on a command's
 * path.
 *
 * @see sentient/daemon.ts for spawn logic
 * @task T946
 * @task T11497 E5-HEADLESS AC3
 * @task T13468
 */

import { cwd } from 'node:process';
import { autoCloudSync } from '../cloud/auto-sync.js';
import { releaseDaemonExitGuard } from '../llm/pi/pi-errors.js';
import { bootstrapDaemon } from './daemon.js';

const projectRoot = process.argv[2] ?? cwd();

// Read scope env vars written by `cleo daemon install --saga <id>` (AC3).
const scopeSagaId = process.env['CLEO_SENTIENT_SAGA'] || undefined;
const scopeEpicId = process.env['CLEO_SENTIENT_EPIC'] || undefined;

bootstrapDaemon(projectRoot, { scopeSagaId, scopeEpicId }).catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`[CLEO SENTIENT] Fatal daemon error: ${message}\n`);
  // If bootstrap pinned the Pi exit guard before throwing, un-pin it so this
  // fatal exit reaches the REAL process.exit (the trap would otherwise convert
  // it into a thrown PiContainmentError and the process would hang). Idempotent.
  releaseDaemonExitGuard();
  process.exit(1);
});

// T13468: poll once a minute; autoCloudSync throttles to its own interval, takes
// its lock and governor admission, and never throws.
setInterval(() => {
  void autoCloudSync(projectRoot, 'tick');
}, 60_000).unref();
