import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    extends: true,
    name: '@cleocode/worktree',
    globals: true,
    environment: 'node',
    include: [
      'src/**/*.test.ts',
      'src/**/__tests__/*.test.ts',
      'tests/**/*.test.ts',
    ],
  },
});
