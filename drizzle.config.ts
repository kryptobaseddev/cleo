import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  schema: './src/store/schema.ts',
  out: './drizzle',
  dialect: 'sqlite',
});
