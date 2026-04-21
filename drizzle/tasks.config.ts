import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  schema: './packages/core/src/store/tasks-schema.ts',
  out: './packages/core/migrations/drizzle-tasks',
  dialect: 'sqlite',
  dbCredentials: { url: '/tmp/msr-rcasd-pathb/tasks.db' },
});
