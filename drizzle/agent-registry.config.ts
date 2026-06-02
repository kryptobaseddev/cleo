/**
 * Drizzle-kit config for the global Agent Registry schema (formerly "signaldock").
 *
 * The Agent Registry holds cross-project agent identity, the capabilities/skills
 * catalog, and cloud-sync tables. Project-local messaging state lives in conduit.db.
 *
 * Schema: packages/core/src/store/schema/agent-registry-schema.ts (legacy bare shape)
 * Migrations: packages/core/migrations/drizzle-agent-registry/
 *
 * @task T1166
 * @task T11622 (Signaldock → Agent Registry rename)
 * @epic T1150
 * @related ADR-037 (conduit/agent-registry split)
 */

import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  schema: './packages/core/src/store/schema/agent-registry-schema.ts',
  out: './packages/core/migrations/drizzle-agent-registry',
  dialect: 'sqlite',
  dbCredentials: {
    url:
      process.env.CLEO_DRIZZLE_BASELINE_AGENT_REGISTRY_DB ||
      '/tmp/cleo-drizzle-baseline/agent-registry.db',
  },
});
