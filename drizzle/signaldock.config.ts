/**
 * Drizzle-kit config for the global signaldock.db schema.
 *
 * TODO(W2A-04): signaldock currently uses bare-SQL embedded migrations in
 * packages/core/src/store/signaldock-sqlite.ts (GLOBAL_EMBEDDED_MIGRATIONS).
 * A Drizzle ORM schema file needs to be authored to replace / shadow those
 * bare-SQL blocks before drizzle-kit generate / check can be used here.
 * See T1150 Wave 2A-04 for the bare-SQL → Drizzle schema conversion work.
 *
 * Once W2A-04 ships, update this config:
 *   schema: './packages/core/src/store/signaldock-schema.ts'
 *
 * @task T1163
 * @epic T1150
 */

import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  // TODO(W2A-04): replace with the Drizzle ORM schema file once extracted from
  // the bare-SQL embedded migrations in signaldock-sqlite.ts.
  schema: './packages/core/src/store/signaldock-sqlite.ts',
  out: './packages/core/migrations/drizzle-signaldock',
  dialect: 'sqlite',
  dbCredentials: {
    url:
      process.env.CLEO_DRIZZLE_BASELINE_SIGNALDOCK_DB ||
      '/tmp/cleo-drizzle-baseline/signaldock.db',
  },
});
