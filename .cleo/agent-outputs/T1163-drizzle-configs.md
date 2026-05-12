# T1163: Fix drizzle configs for all 5 DBs

**Commit**: 5fa9864ff
**Status**: complete
**Branch**: main

## Files Changed

- `drizzle/tasks.config.ts` — out fixed to `packages/core/migrations/drizzle-tasks`, added dbCredentials (env: CLEO_DRIZZLE_BASELINE_DB)
- `drizzle/brain.config.ts` — schema corrected from non-existent `brain-schema.ts` to `memory-schema.ts`, out fixed to `packages/core/migrations/drizzle-brain`, added dbCredentials (env: CLEO_DRIZZLE_BASELINE_BRAIN_DB)
- `drizzle/nexus.config.ts` — out fixed to `packages/core/migrations/drizzle-nexus`, added dbCredentials (env: CLEO_DRIZZLE_BASELINE_NEXUS_DB)
- `drizzle/signaldock.config.ts` (NEW) — stub with TODO(W2A-04); signaldock uses bare-SQL embedded migrations in signaldock-sqlite.ts, no Drizzle ORM schema file exists yet
- `drizzle/telemetry.config.ts` (NEW) — schema: `packages/core/src/telemetry/schema.ts`, out: `packages/core/migrations/drizzle-telemetry`, dbCredentials (env: CLEO_DRIZZLE_BASELINE_TELEMETRY_DB)
- `package.json` — added `db:new` (T1164 placeholder: node scripts/new-migration.mjs) and `db:check` (loops all 5 configs)

## drizzle-kit check results

| Config | Result |
|--------|--------|
| tasks | FAIL — pre-existing: snapshot.json missing `renames` key (malformed, version 7 incomplete format) |
| brain | FAIL — pre-existing: same snapshot format issue |
| nexus | PASS |
| signaldock | PASS (no drizzle tables exported from signaldock-sqlite.ts) |
| telemetry | FAIL — pre-existing: same snapshot format issue |

## Signaldock Blocker for W2A-04

`signaldock-sqlite.ts` uses bare-SQL embedded migrations (GLOBAL_EMBEDDED_MIGRATIONS array). No Drizzle ORM schema file (`signaldock-schema.ts`) exists. The config stub points at `signaldock-sqlite.ts` itself with a `TODO(W2A-04)` comment. W2A-04 must extract the schema as a proper Drizzle ORM schema file before `drizzle-kit generate` can work for signaldock.

## Pre-existing snapshot failures (out of scope)

The tasks/brain/telemetry snapshot.json files are malformed — they have `version: 7` but are missing the `renames` key present in valid nexus snapshots. This is a pre-existing state issue in `packages/core/migrations/drizzle-{tasks,brain,telemetry}/`. W2A-03 (baseline reset) is the correct scope to address this.
