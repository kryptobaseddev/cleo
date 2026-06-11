#!/usr/bin/env node
/**
 * Self-healing regenerator for the `cleo ops` tier-SSoT snapshot
 * (`src/admin/__tests__/help-tier-snapshot.test.ts.snap`, T9845).
 *
 * Why this exists (T11957 / DHQ-074)
 * ----------------------------------
 * The tier snapshot is a regression lock over the LIVE `OPERATIONS` registry:
 * it pins per-tier operation counts and the domain-grouped operation map. That
 * is exactly the right safety net — an accidental tier reassignment or op
 * rename must trip a gate. But adding a *legitimate* new operation also trips
 * it, and historically agents discovered the break only in CI, then had to
 * reverse-engineer the precise `vitest -u --filter` incantation to regen.
 *
 * This script removes that stall point by giving the snapshot a first-class,
 * discoverable verb (mirroring the `gen:sdk` / `gen:sdk:check` precedent in
 * this same package):
 *
 *   - `pnpm --filter @cleocode/core run gen:tier-snapshot`
 *       Regenerates the `.snap` from the current registry (vitest `-u`).
 *
 *   - `pnpm --filter @cleocode/core run gen:tier-snapshot:check`  (this + --check)
 *       Runs the snapshot test WITHOUT updating and fails non-zero on drift,
 *       printing the exact one-liner to fix it. This is the seam a CI gate
 *       hangs off so the failure is actionable, not cryptic.
 *
 * It deliberately scopes vitest to the single snapshot test file so the regen
 * is fast and cannot touch unrelated snapshots.
 *
 * @task T11957 — DHQ-074: tier-snapshot auto-regen / discoverable verb
 * @epic T11679
 */

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = resolve(__dirname, '..');
const REPO_ROOT = resolve(PKG_ROOT, '..', '..');

/** Path to the snapshot test relative to the repo root (vitest CWD). */
const SNAPSHOT_TEST = 'packages/core/src/admin/__tests__/help-tier-snapshot.test.ts';

/** `--check` runs the test read-only and fails on drift; default regenerates. */
const CHECK = process.argv.includes('--check');

/** Resolve the workspace-local vitest binary (never a global `vitest`). */
function resolveVitestBin() {
  const candidates = [
    join(REPO_ROOT, 'node_modules', '.bin', 'vitest'),
    join(PKG_ROOT, 'node_modules', '.bin', 'vitest'),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(
    '[gen:tier-snapshot] could not find the workspace vitest binary — run `pnpm install` first.',
  );
}

/**
 * Run vitest against ONLY the tier snapshot test file. In update mode the
 * `.snap` is rewritten; in check mode a mismatch exits non-zero.
 */
function runVitest({ update }) {
  const bin = resolveVitestBin();
  const args = ['run', SNAPSHOT_TEST];
  if (update) args.push('-u');
  // Run from the repo root so the root vitest projects config + aliases apply.
  const result = spawnSync(bin, args, {
    cwd: REPO_ROOT,
    stdio: 'inherit',
    env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' },
  });
  return result.status ?? 1;
}

if (CHECK) {
  const status = runVitest({ update: false });
  if (status !== 0) {
    process.stderr.write(
      '\n[gen:tier-snapshot --check] tier-SSoT snapshot is STALE.\n' +
        'The `cleo ops` tier snapshot no longer matches the live OPERATIONS registry —\n' +
        'this is expected after adding/renaming/retiering an operation.\n\n' +
        'Regenerate it with:\n' +
        '  pnpm --filter @cleocode/core run gen:tier-snapshot\n\n' +
        'Then review the diff (an INTENTIONAL op change → commit the new .snap;\n' +
        'an UNINTENDED tier reassignment or rename → fix the registry instead).\n',
    );
    process.exit(1);
  }
  process.stdout.write('[gen:tier-snapshot --check] OK — tier snapshot in sync with the registry.\n');
} else {
  const status = runVitest({ update: true });
  if (status !== 0) {
    process.stderr.write('[gen:tier-snapshot] vitest exited non-zero while regenerating.\n');
    process.exit(status);
  }
  process.stdout.write(
    `[gen:tier-snapshot] regenerated ${SNAPSHOT_TEST}.snap from the live OPERATIONS registry.\n`,
  );
}
