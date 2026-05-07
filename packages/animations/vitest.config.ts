import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    extends: true,
    name: '@cleocode/animations',
    globals: true,
    environment: 'node',
    include: [
      'src/**/*.test.ts',
      'src/**/__tests__/*.test.ts',
      'tests/**/*.test.ts',
    ],
    exclude: ['node_modules', 'dist', '**/node_modules/**', '**/e2e/**', '**/*.integration.test.ts', '**/*-integration.test.ts'],
  },
});
