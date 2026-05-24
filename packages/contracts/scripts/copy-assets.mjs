#!/usr/bin/env node
/**
 * copy-assets.mjs — Non-TS asset copier for @cleocode/contracts
 *
 * TypeScript's `tsc` does NOT copy `.json` files referenced via
 * `import x from './foo.json' with { type: 'json' }` into the `dist/`
 * output directory. Without an explicit copy step the built
 * `dist/db-inventory.js` would attempt to resolve `./db-inventory.json`
 * against an empty path inside the published tarball — breaking install
 * for every consumer of `@cleocode/contracts`.
 *
 * This script keeps the asset list explicit (one entry per JSON file
 * shipped alongside the contracts module). Add new assets here AND
 * verify the resulting tarball contains them via:
 *
 *   pnpm --filter @cleocode/contracts pack
 *   tar -tzf cleocode-contracts-*.tgz | grep '\.json$'
 *
 * @task T10399
 * @epic T10282
 * @saga T10281
 */
import { mkdirSync, copyFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC_ROOT = resolve(__dirname, '..', 'src');
const DIST_ROOT = resolve(__dirname, '..', 'dist');

/**
 * Asset list — every entry is copied from `src/<path>` to `dist/<path>`.
 *
 * Keep paths relative to the package root so the mapping reads as a
 * "this file moves from source into the published bundle" manifest.
 */
const ASSETS = ['db-inventory.json'];

let copied = 0;
for (const rel of ASSETS) {
  const from = resolve(SRC_ROOT, rel);
  const to = resolve(DIST_ROOT, rel);
  mkdirSync(dirname(to), { recursive: true });
  copyFileSync(from, to);
  console.log(`  copied: src/${rel} -> dist/${rel}`);
  copied++;
}

console.log(`\nDone — ${copied} asset file(s) copied into dist/.`);
