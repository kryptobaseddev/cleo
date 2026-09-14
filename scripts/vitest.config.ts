import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
import { MEMORY_SAFE_TEST_DEFAULTS } from '../vitest.memory-safe.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

/**
 * Vitest project config for `scripts/__tests__/*.test.mjs` unit tests.
 *
 * Why this exists:
 *   The root `vitest.config.ts` switched to projects-mode in T9079. Once a
 *   `projects:` array is set, vitest 4 uses ONLY the projects to discover
 *   tests — the root `include` field is ignored for test discovery. Without
 *   a dedicated project, the long-standing `scripts/__tests__/*.test.mjs`
 *   tests (commit-msg-release-lint, lint-cli-package-boundary, etc.) silently
 *   stopped running in CI shards.
 *
 *   This project re-attaches the scripts tests to the workspace and gives
 *   them a stable `scripts` project name so they can be invoked with:
 *     pnpm exec vitest run --project=scripts
 *
 * @task T10177
 * @saga T10176
 * @decision D010
 */
export default defineConfig({
  test: {
    // Memory-safe fork bounds (T12087) — spread FIRST so anything below can
    // still override deliberately.
    //
    // gh#1354: this config previously relied on `extends: true` alone. That
    // resolves when vitest is invoked from the workspace root, because this
    // file is listed in the root config's `projects:` array and the root
    // spreads the defaults. It resolves to NOTHING on a direct
    // `vitest run --root scripts` — `root: __dirname` below means this
    // directory IS the root, so there is no parent to extend from. That is
    // precisely the shape `vitest.memory-safe.ts` documents as insufficient,
    // and precisely the shape (`--root packages/core`) that froze the machine
    // twice on 2026-08-06.
    //
    // It went unnoticed because gate 18 globbed root + `packages/*` only, so
    // the one file still inheriting was the one file the gate could not see.
    ...MEMORY_SAFE_TEST_DEFAULTS,
    extends: true,
    name: 'scripts',
    root: __dirname,
    include: ['__tests__/*.test.mjs'],
    environment: 'node',
  },
});
