import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  schema: './packages/core/src/store/brain-schema.ts',
  out: './packages/core/migrations/drizzle-brain',
  dialect: 'sqlite',
  dbCredentials: { url: '/tmp/msr-rcasd-pathb/brain.db' },
});
