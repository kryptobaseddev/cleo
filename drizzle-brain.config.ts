import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  schema: './src/store/brain-schema.ts',
  out: './drizzle-brain',
  dialect: 'sqlite',
});
