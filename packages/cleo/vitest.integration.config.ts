/**
 * Vitest configuration for @cleocode/cleo integration tests.
 *
 * Integration tests (`*-integration.test.ts`) are excluded from the
 * standard unit-test run because they touch a real tasks.db and
 * filesystem. This config inverts the filter so only integration
 * tests run.
 *
 * @epic T947
 */

import { defineConfig } from 'vitest/config';
import baseConfig from './vitest.config.js';

// Re-derive the alias block from the base config (we can't mergeConfig because
// that unions include/exclude arrays rather than overriding them).
const baseTestConfig = baseConfig.test ?? {};

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    testTimeout: 60_000,
    hookTimeout: 60_000,
    include: ['packages/cleo/src/**/*-integration.test.ts'],
    exclude: ['node_modules', 'dist', '**/node_modules/**'],
    alias: baseTestConfig.alias,
  },
});
