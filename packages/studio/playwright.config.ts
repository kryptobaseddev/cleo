/**
 * Playwright configuration for Studio E2E tests.
 *
 * T959 (W3A of T949) — exercises the merged hybrid `/tasks` page in a real
 * Chromium browser against the live Studio dev server.
 *
 * The webServer block reuses an already-running `pnpm run dev` instance when
 * present (port 3456). When no server is running locally Playwright spawns
 * one on demand. The `CLEO_ROOT` env var is forwarded so the SvelteKit
 * loader resolves the canonical tasks.db rather than failing into an empty
 * project context.
 *
 * Headless Chromium only — no cross-browser matrix in CI to keep run-time
 * predictable; the merge contract is browser-agnostic in any case.
 *
 * @task T959
 * @epic T949
 */
import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  testMatch: /.*\.spec\.ts$/,
  // Run tests serially against the single shared dev server — parallel
  // workers starve each other when one opens the Graph tab (d3 simulation
  // spins the event loop), producing flaky aria-selected assertions in
  // tests that share the same dev process. Switching to 1 worker moved
  // the suite from ~40% pass rate to 100% locally.
  fullyParallel: false,
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: [['list'], ['json', { outputFile: 'e2e-results.json' }]],
  use: {
    baseURL: 'http://localhost:3456',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: {
    command: 'CLEO_ROOT=/mnt/projects/cleocode pnpm run dev',
    port: 3456,
    reuseExistingServer: true,
    timeout: 60_000,
  },
});
