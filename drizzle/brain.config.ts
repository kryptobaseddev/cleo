import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  schema: './packages/core/src/store/brain-schema.ts',
  out: './drizzle/migrations/drizzle-brain',
  dialect: 'sqlite',
});
