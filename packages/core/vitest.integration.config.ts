/**
 * Vitest configuration for @cleocode/core integration tests.
 *
 * Integration tests (`*-integration.test.ts` and `*.integration.test.ts`) are
 * EXCLUDED from the standard unit-test run (`vitest.config.ts`) because they
 * touch a real filesystem/DB or perform a real network turn against a resolved
 * credential. This config inverts the filter so ONLY integration tests run.
 *
 * Covered (each SKIPS when its credential or host infra is absent, so the CI
 * job `integration-tests` runs them without secrets):
 *   - `src/llm/pi/__tests__/*.integration.test.ts` — the AC3 end-to-end Pi turn
 *     (real `PiAgentAdapter` + `resolveLLMForSystem` + `ModelRunner`; runs a
 *     real Anthropic turn when creds are present) (T11898), and the opt-in
 *     Gondolin real-VM test (`CLEO_GONDOLIN_INTEGRATION=1` + KVM + QEMU).
 *   - `src/llm/transports/__tests__/*.integration.test.ts` — the live Bedrock
 *     transport (`AWS_BEDROCK_TEST_KEY` + AWS credentials).
 *
 * The store suites that lived here need no network and run in the unit suite
 * now as `*-int.test.ts` (T14410).
 *
 * Invoked from the repo root so the base config's source aliases resolve:
 *   `vitest run --config packages/core/vitest.integration.config.ts`
 *
 * We re-derive `alias` / `setupFiles` / `globalSetup` from the base config
 * rather than `mergeConfig` — merge unions `include`/`exclude` arrays (which
 * would re-introduce the `*.integration.test.ts` exclusion and orphan the suite
 * again) instead of overriding them.
 *
 * @epic T10403
 * @task T11761
 * @task T11898
 * @task T14410
 */

import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
import baseConfig from './vitest.config.js';

// Re-derive the inherited blocks from the base config. We deliberately do NOT
// mergeConfig (that unions include/exclude arrays rather than overriding them).
const baseTestConfig = baseConfig.test ?? {};

// Pin `root` to THIS package directory so the package-relative `include`,
// `setupFiles`, and `globalSetup` paths resolve identically whether the runner
// is launched from the package or (as `test:integration` does) from the repo
// root via `--config`.
const packageRoot = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
  root: packageRoot,
  test: {
    globals: true,
    environment: 'node',
    testTimeout: 60_000,
    hookTimeout: 60_000,
    // Pin CLEO_HOME / NEXUS_HOME to a per-fork tmpdir + sweep stale dirs, exactly
    // as the unit suite does — the Pi integration test resolves a credential and
    // must not read/write the user's global stores.
    setupFiles: baseTestConfig.setupFiles,
    globalSetup: baseTestConfig.globalSetup,
    // ONLY integration tests — invert the unit-suite exclusion.
    include: [
      'src/llm/pi/__tests__/*.integration.test.ts',
      'src/llm/transports/__tests__/*.integration.test.ts',
    ],
    // Do NOT exclude *.integration.test.ts here — that is the whole point.
    exclude: ['node_modules', 'dist', '**/node_modules/**'],
    // Same source aliases as the unit suite so workspace packages resolve to TS
    // source without a build step.
    alias: baseTestConfig.alias,
  },
});
