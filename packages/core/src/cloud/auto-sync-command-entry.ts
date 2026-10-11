/**
 * Detached worker for the command piggyback sync (T13553), spawned by
 * `startCommandAutoSync` (`cloud/auto-sync-command.ts`). Runs
 * {@link runCommandAutoSync}: the `cloud.autoSync` opt-out, then a
 * throttled, single-flight, bounded `autoCloudSync`. No stdout: this process
 * has no reader.
 *
 * argv: `<projectRoot>`
 *
 * @task T13553
 */

import { runCommandAutoSync } from './auto-sync-command.js';

const projectRoot = process.argv[2];
if (!projectRoot) process.exit(2);
await runCommandAutoSync(projectRoot);
process.exit(0);
