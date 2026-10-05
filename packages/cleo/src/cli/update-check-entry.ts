/**
 * Entry of the detached background check behind the passive update notice
 * (T13137). `showUpdateNotice` spawns it as
 * `node update-check-entry.js <cachePath> <lockPath> <registry> <packageName>`
 * with stdio ignored; it loads nothing but `lib/update-check.ts`.
 *
 * @module
 * @task T13137
 */

import { runUpdateCheck } from './lib/update-check.js';

const [cachePath, lockPath, registry, packageName] = process.argv.slice(2);
if (cachePath && lockPath && registry && packageName) {
  await runUpdateCheck({ cachePath, lockPath, registry, packageName });
}
// fetch's keep-alive socket would hold the process for a few more seconds.
process.exit(0);
