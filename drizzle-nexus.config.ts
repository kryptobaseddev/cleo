import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  schema: './packages/core/src/store/nexus-schema.ts',
  out: './migrations/drizzle-nexus',
  dialect: 'sqlite',
});
