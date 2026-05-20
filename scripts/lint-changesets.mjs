#!/usr/bin/env node
/**
 * Lint rule: every `.changeset/*.md` file (excluding `README.md`) MUST be a
 * valid CLEO-native changeset entry parseable by
 * `@cleocode/core/src/changesets/parser.ts`.
 *
 * Iterates the directory, parses each file, and exits non-zero on the first
 * error (with all subsequent failures still surfaced to stderr so authors
 * can see the full picture in one CI run).
 *
 * @epic T9738
 * @task T9738
 */

import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// ─── Configuration ────────────────────────────────────────────────────────────

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = resolve(dirname(__filename), '..');
const CHANGESET_DIR = join(REPO_ROOT, '.changeset');

// ─── Resolve the parser from built core, or fall back to a TS-loader hint ─────
// The parser lives in `@cleocode/core` — when running in CI the package has
// been built and `dist/changesets/index.js` exists. For local dev we fall
// back to telling the user to build first rather than spinning up a TS
// loader (avoids tsx/ts-node coupling).

const corePkgRoot = join(REPO_ROOT, 'packages/core');
const corePkgDist = join(corePkgRoot, 'dist/index.js');

if (!existsSync(corePkgDist)) {
  process.stderr.write(
    `lint-changesets: @cleocode/core has not been built — run 'pnpm run build' first.\n`,
  );
  process.exit(2);
}

// Dynamic import the built `@cleocode/core` bundle and pull the
// `changesets` namespace off it. The `file://` URL form is required for
// absolute paths under Node's ESM loader.
/** @type {{ changesets: { parseChangesetDir: (dir: string) => unknown[] } }} */
const coreMod = await import(`file://${corePkgDist}`);
const { parseChangesetDir } = coreMod.changesets;

// ─── Run ──────────────────────────────────────────────────────────────────────

if (!existsSync(CHANGESET_DIR)) {
  process.stderr.write(`lint-changesets: ${CHANGESET_DIR} does not exist.\n`);
  process.exit(2);
}

try {
  const entries = parseChangesetDir(CHANGESET_DIR);
  process.stdout.write(
    `lint-changesets: ${entries.length} entry/entries validated successfully.\n`,
  );
  process.exit(0);
} catch (err) {
  const msg = err instanceof Error ? err.message : String(err);
  process.stderr.write(`lint-changesets: FAIL\n${msg}\n`);
  process.exit(1);
}
