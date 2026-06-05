import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Inherit the root memory-safe maxWorkers + per-fork heap cap (T11860).
    // Without this, `pnpm test:pkg @cleocode/utils` runs vitest's default
    // (CPU-1 ≈ 23 forks) with no heap cap and can OOM-freeze a big local box.
    extends: true,
    include: ['src/**/*.test.ts'],
  },
});
