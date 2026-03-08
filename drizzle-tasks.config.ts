import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  schema: './src/store/tasks-schema.ts',
  out: './migrations/drizzle-tasks',
  dialect: 'sqlite',
});
