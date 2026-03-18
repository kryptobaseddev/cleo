import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  schema: './packages/core/src/store/tasks-schema.ts',
  out: './migrations/drizzle-tasks',
  dialect: 'sqlite',
});
