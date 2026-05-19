import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  schema: './packages/core/src/store/skills-schema.ts',
  out: './packages/core/migrations/drizzle-skills',
  dialect: 'sqlite',
  dbCredentials: {
    url: process.env.CLEO_DRIZZLE_BASELINE_SKILLS_DB || '/tmp/cleo-drizzle-baseline/skills.db',
  },
});
