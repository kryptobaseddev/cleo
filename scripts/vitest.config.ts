import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

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
    extends: true,
    name: 'scripts',
    root: __dirname,
    include: ['__tests__/*.test.mjs'],
    environment: 'node',
  },
});
