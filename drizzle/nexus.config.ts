import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  schema: './packages/core/src/store/nexus-schema.ts',
  out: './drizzle/migrations/drizzle-nexus',
  dialect: 'sqlite',
});
