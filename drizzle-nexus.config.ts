import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  schema: './src/store/nexus-schema.ts',
  out: './drizzle-nexus',
  dialect: 'sqlite',
});
