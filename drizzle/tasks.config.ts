import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  schema: './packages/core/src/store/tasks-schema.ts',
  out: './packages/core/migrations/drizzle-tasks',
  dialect: 'sqlite',
  dbCredentials: {
    url: process.env.CLEO_DRIZZLE_BASELINE_DB || '/tmp/cleo-drizzle-baseline/tasks.db',
  },
});
