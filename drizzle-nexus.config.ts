import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  schema: './src/store/nexus-schema.ts',
  out: './migrations/drizzle-nexus',
  dialect: 'sqlite',
});
