import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  schema: './packages/core/src/store/nexus-schema.ts',
  out: './packages/core/migrations/drizzle-nexus',
  dialect: 'sqlite',
  dbCredentials: {
    url: process.env.CLEO_DRIZZLE_BASELINE_NEXUS_DB || '/tmp/cleo-drizzle-baseline/nexus.db',
  },
});
