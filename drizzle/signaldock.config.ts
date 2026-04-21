/**
 * Drizzle-kit config for the global signaldock.db schema.
 *
 * signaldock.db holds cross-project agent identity, capabilities catalog,
 * and cloud-sync tables. Project-local messaging state lives in conduit.db.
 *
 * Schema: packages/core/src/store/signaldock-schema.ts
 * Migrations: packages/core/migrations/drizzle-signaldock/
 *
 * @task T1166
 * @epic T1150
 * @related ADR-037 (signaldock/conduit split)
 */

import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  schema: './packages/core/src/store/signaldock-schema.ts',
  out: './packages/core/migrations/drizzle-signaldock',
  dialect: 'sqlite',
  dbCredentials: {
    url:
      process.env.CLEO_DRIZZLE_BASELINE_SIGNALDOCK_DB ||
      '/tmp/cleo-drizzle-baseline/signaldock.db',
  },
});
