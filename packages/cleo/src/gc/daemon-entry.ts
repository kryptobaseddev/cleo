/**
 * GC Daemon Entry Point — Standalone script executed by `spawnGCDaemon()`.
 *
 * This script is spawned as a detached background process by `cleo daemon start`.
 * It must NOT import from the main CLI shim (no citty, no commander). It only
 * imports from the gc/ module subtree.
 *
 * The cleoDir is passed as argv[2] by `spawnGCDaemon()`.
 *
 * @see gc/daemon.ts for the spawn logic
 * @task T731
 * @epic T726
 */

import { homedir } from 'node:os';
import { join } from 'node:path';
import { bootstrapDaemon } from './daemon.js';

const cleoDir = process.argv[2] ?? join(homedir(), '.cleo');

bootstrapDaemon(cleoDir).catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  // stderr is redirected to gc.err by the parent spawn call
  process.stderr.write(`[CLEO GC] Fatal daemon error: ${message}\n`);
  process.exit(1);
});
