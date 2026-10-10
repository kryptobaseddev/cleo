#!/usr/bin/env node

/**
 * sync-gate-b.mjs — the change journal's Gate B on real store snapshots
 * (journal spec S3 exit, §5.1; T12987).
 *
 * Runs `packages/core/src/store/sync/__tests__/journal-gate-b.test.ts` on
 * snapshots of real stores: each snapshot is copied to scratch, opened with
 * capture and seal on, put through the Gate B workload, and its sealed ops
 * are replayed from genesis and from a checkpoint onto earlier copies; both
 * replays must fingerprint equal to the source (`--canon-timestamps`).
 *
 * The input is a snapshot file, never a live store: take one with the
 * installed CLI in the project (`cleo backup add`, which writes
 * `.cleo/backups/sqlite/…`), or copy a store that is not in use to scratch
 * first. A path that looks like a live project store (`.cleo/cleo.db`) is
 * refused. The snapshot itself is never opened in place or written.
 *
 * Usage:
 *   node scripts/sync-gate-b.mjs --snapshot <name>=</abs/snapshot.db> [--snapshot …]
 *
 * Prints the vitest result and exits with its code (2 on bad usage). Run it
 * through the machine's heavy-command runner: it opens and migrates a full
 * copy of each store.
 *
 * @task T12987
 */

import { spawnSync } from 'node:child_process';
import { existsSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TEST = 'src/store/sync/__tests__/journal-gate-b.test.ts';

/**
 * Validate the `--snapshot` values.
 *
 * @param {string[]} values - `name=/abs/path` entries.
 * @returns {Array<{ name: string, file: string }>}
 * @throws {Error} On a malformed, missing or live-store path.
 */
export function parseSnapshots(values) {
  if (values.length === 0)
    throw new Error('pass at least one --snapshot <name>=</abs/snapshot.db>');
  return values.map((v) => {
    const at = v.indexOf('=');
    if (at <= 0) throw new Error(`--snapshot expects <name>=</abs/path>, got ${v}`);
    const name = v.slice(0, at);
    const file = v.slice(at + 1);
    if (!/^[a-z0-9][a-z0-9-]*$/.test(name))
      throw new Error(`snapshot name must be kebab-case: ${name}`);
    if (!isAbsolute(file)) throw new Error(`snapshot path must be absolute: ${file}`);
    if (!existsSync(file) || !statSync(file).isFile())
      throw new Error(`no snapshot file at ${file}`);
    // Resolve symlinks, and compare case-insensitively (APFS is). Every live
    // store, project (`.cleo/cleo.db`) or global (`<CLEO_HOME>/cleo.db`, at
    // the platform default or anywhere CLEO_HOME points), is named cleo.db,
    // and a `cleo backup add` snapshot never is: refusing the name covers the
    // global store without resolving the platform home here (T13225).
    const real = realpathSync(file);
    if (basename(real).toLowerCase() === 'cleo.db') {
      throw new Error(
        `${file} looks like a live store (named cleo.db): take a snapshot with \`cleo backup add\` ` +
          'and pass that file, or rename a stopped copy',
      );
    }
    const wal = `${real}-wal`;
    if (existsSync(wal) && statSync(wal).size > 0) {
      throw new Error(`${file} is not a quiesced snapshot: its -wal is not empty`);
    }
    if (file.includes(',')) throw new Error(`snapshot path must not contain a comma: ${file}`);
    return { name, file };
  });
}

function main() {
  const { values } = parseArgs({ options: { snapshot: { type: 'string', multiple: true } } });
  let snapshots;
  try {
    snapshots = parseSnapshots(values.snapshot ?? []);
  } catch (e) {
    process.stderr.write(`sync-gate-b: ${e instanceof Error ? e.message : String(e)}\n`);
    process.exit(2);
  }
  const r = spawnSync('pnpm', ['exec', 'vitest', 'run', TEST, '-t', 'real store snapshots'], {
    cwd: join(REPO_ROOT, 'packages', 'core'),
    stdio: 'inherit',
    env: {
      ...process.env,
      CLEO_SYNC_GATE_B_SNAPSHOTS: snapshots.map((s) => `${s.name}=${s.file}`).join(','),
    },
  });
  process.exit(r.status ?? 1);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
