import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  schema: './packages/core/src/store/memory-schema.ts',
  out: './packages/core/migrations/drizzle-brain',
  dialect: 'sqlite',
  dbCredentials: {
    url: process.env.CLEO_DRIZZLE_BASELINE_BRAIN_DB || '/tmp/cleo-drizzle-baseline/brain.db',
  },
});
