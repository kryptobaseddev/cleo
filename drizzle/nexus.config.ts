import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  schema: './packages/core/src/store/nexus-schema.ts',
  out: './packages/core/migrations/drizzle-nexus',
  dialect: 'sqlite',
  dbCredentials: { url: '/tmp/msr-rcasd-pathb/nexus.db' },
});
