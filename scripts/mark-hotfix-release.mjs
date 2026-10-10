#!/usr/bin/env node
/**
 * Flag a hotfix release in `@cleocode/cleo`'s published manifest (T13184).
 *
 * Installed CLIs show a stronger HOTFIX update notice for a release whose
 * registry manifest carries `"cleo": { "hotfix": true }` (see
 * `packages/cleo/src/cli/lib/update-check.ts`). Releases publish tokenless
 * through npm Trusted Publishing (OIDC), which can publish but cannot move
 * dist-tags, so the flag travels inside the package itself: release.yml runs
 * this before packing, and the ordinary publish ships it.
 *
 * The source of truth is the release plan committed by `cleo release open`:
 * `.cleo/release/v<version>.plan.json`, whose `releaseKind` is `hotfix` for a
 * plan made with `cleo release plan <v> --hotfix`.
 *
 * - `releaseKind: "hotfix"`: sets `cleo.hotfix = true` in
 *   `packages/cleo/package.json`.
 * - Any other kind: removes a stale `cleo.hotfix` (a regular release must never
 *   inherit the flag), otherwise leaves the manifest untouched.
 * - No plan file (a break-glass `workflow_dispatch` release): regular, with a
 *   notice. An unreadable or malformed plan fails: release metadata must not be
 *   guessed.
 *
 * Usage: `node scripts/mark-hotfix-release.mjs <version>` (no leading `v`).
 *
 * @task T13184
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { isMain } from './lib/is-main.mjs';

/** Manifest the flag is written into. */
export const CLEO_MANIFEST = 'packages/cleo/package.json';

/**
 * Read the plan's release kind.
 *
 * @param {string} root - Repository root.
 * @param {string} version - Release version without a leading `v`.
 * @returns {{ kind: string, planPath: string } | { kind: null, planPath: string }}
 *   The kind, or `null` when there is no plan file.
 * @throws {Error} When the plan exists but is not valid JSON or has no `releaseKind`.
 */
export function readReleaseKind(root, version) {
  const planPath = join(root, '.cleo', 'release', `v${version}.plan.json`);
  if (!existsSync(planPath)) return { kind: null, planPath };
  const plan = JSON.parse(readFileSync(planPath, 'utf8'));
  if (typeof plan?.releaseKind !== 'string') {
    throw new Error(`${planPath} has no releaseKind`);
  }
  return { kind: plan.releaseKind, planPath };
}

/**
 * Apply the plan's release kind to `@cleocode/cleo`'s manifest.
 *
 * @param {string} root - Repository root.
 * @param {string} version - Release version without a leading `v`.
 * @returns {{ hotfix: boolean, changed: boolean, reason: string }} What was done.
 */
export function markHotfixRelease(root, version) {
  const { kind, planPath } = readReleaseKind(root, version);
  const manifestPath = join(root, CLEO_MANIFEST);
  const before = readFileSync(manifestPath, 'utf8');
  const manifest = JSON.parse(before);
  const meta = typeof manifest.cleo === 'object' && manifest.cleo !== null ? manifest.cleo : {};
  const hotfix = kind === 'hotfix';

  if (hotfix) {
    manifest.cleo = { ...meta, hotfix: true };
  } else if ('hotfix' in meta) {
    const { hotfix: _stale, ...rest } = meta;
    if (Object.keys(rest).length > 0) manifest.cleo = rest;
    else delete manifest.cleo;
  }
  const after = `${JSON.stringify(manifest, null, 2)}\n`;
  const changed =
    after !== before && JSON.stringify(JSON.parse(before)) !== JSON.stringify(manifest);
  if (changed) writeFileSync(manifestPath, after);

  const reason =
    kind === null
      ? `no plan at ${planPath}; treated as a regular release`
      : `plan releaseKind is ${kind}`;
  return { hotfix, changed, reason };
}

if (isMain(import.meta.url)) {
  const version = process.argv[2];
  if (!version || version.startsWith('v')) {
    process.stderr.write('usage: node scripts/mark-hotfix-release.mjs <version without v>\n');
    process.exit(2);
  }
  try {
    const result = markHotfixRelease(resolve('.'), version);
    const prefix = result.reason.startsWith('no plan') ? '::notice::' : '';
    process.stdout.write(
      `${prefix}${result.reason}: @cleocode/cleo ${result.hotfix ? 'IS' : 'is not'} flagged as a hotfix` +
        `${result.changed ? ' (manifest updated)' : ''}\n`,
    );
  } catch (err) {
    process.stderr.write(
      `::error::cannot read the release plan: ${err instanceof Error ? err.message : err}\n`,
    );
    process.exit(1);
  }
}
