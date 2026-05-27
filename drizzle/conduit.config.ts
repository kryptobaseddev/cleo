/**
 * Drizzle-kit config for the project-tier conduit.db schema.
 *
 * conduit.db holds project-local messaging, delivery queues, attachments,
 * and project-scoped agent reference overrides. Cross-project agent identity
 * lives in signaldock.db.
 *
 * Schema: packages/core/src/store/conduit-schema.ts
 * Migrations: packages/core/migrations/drizzle-conduit/
 *
 * @task T1407
 * @related ADR-037 (signaldock/conduit split)
 * @related T1166 (signaldock-config — pattern reference)
 */

import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  schema: './packages/core/src/store/conduit-schema.ts',
  out: './packages/core/migrations/drizzle-conduit',
  dialect: 'sqlite',
  dbCredentials: {
    url: process.env.CLEO_DRIZZLE_BASELINE_CONDUIT_DB || '/tmp/cleo-drizzle-baseline/conduit.db',
  },
});
