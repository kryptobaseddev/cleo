import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    extends: true,
    name: '@cleocode/paths',
    include: ['src/**/*.test.ts'],
    environment: 'node',
  },
});
