/**
 * Drizzle-kit config for CLEO telemetry.db (opt-in command analytics).
 *
 * Schema: packages/core/src/telemetry/schema.ts
 * Tables: telemetry_events, telemetry_schema_meta
 *
 * @task T1163
 * @epic T1150
 */

import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  schema: './packages/core/src/telemetry/schema.ts',
  out: './packages/core/migrations/drizzle-telemetry',
  dialect: 'sqlite',
  dbCredentials: {
    url:
      process.env.CLEO_DRIZZLE_BASELINE_TELEMETRY_DB ||
      '/tmp/cleo-drizzle-baseline/telemetry.db',
  },
});
