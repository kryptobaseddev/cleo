/**
 * Vitest global setup — runs once per test fork, before any test file imports
 * library code. Provides a second layer of defense against the production-DB
 * leak vector that introduced T9001…T9020 fixtures into tasks.db on
 * 2026-05-06.
 *
 * The first layer is the path-isolation guard inside `openNativeDatabase`
 * (packages/core/src/store/sqlite-native.ts) — it throws synchronously if
 * any test ever opens a SQLite file outside `os.tmpdir()`. This setup file
 * makes it harder for that guard to fire by pinning every per-fork
 * "global" CLEO root to an ephemeral temp directory.
 *
 * Concretely:
 *   - `CLEO_HOME` is set to a fresh `mkdtempSync` path under `os.tmpdir()`,
 *     scoped per fork. Resolves global signaldock.db, brain global pages,
 *     and worktree storage to throwaway directories.
 *   - `NEXUS_HOME` and `NEXUS_CACHE_DIR` follow `CLEO_HOME` so the global
 *     Nexus database also lives in tmp.
 *   - Variables already set by the parent process (e.g. by an integration
 *     suite that explicitly opted in via `CLEO_TEST_ALLOW_PROJECT_DB=true`)
 *     are honoured — we only fill in defaults.
 *
 * Tests that need to override these (e.g. nexus/transfer.test.ts) can still
 * set them in their own `beforeEach` — that mutation lives only inside the
 * fork's process and overrides the default established here.
 */

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const sandbox = mkdtempSync(join(tmpdir(), 'cleo-vitest-fork-'));

if (!process.env.CLEO_HOME) {
  process.env.CLEO_HOME = sandbox;
}
if (!process.env.NEXUS_HOME) {
  process.env.NEXUS_HOME = join(sandbox, 'nexus');
}
if (!process.env.NEXUS_CACHE_DIR) {
  process.env.NEXUS_CACHE_DIR = join(sandbox, 'nexus', 'cache');
}
// Tests do not need real signaldock peer permission checks.
if (!process.env.NEXUS_SKIP_PERMISSION_CHECK) {
  process.env.NEXUS_SKIP_PERMISSION_CHECK = 'true';
}
