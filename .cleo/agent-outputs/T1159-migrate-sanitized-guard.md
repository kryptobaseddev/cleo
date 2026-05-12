# T1159: Runtime guard — sanitize whitespace-only migration statements

## Summary

Defense-in-depth guard that filters whitespace-only SQL statement chunks before they reach drizzle's `session.run()`. A trailing `--> statement-breakpoint` in a migration file causes `readMigrationFiles` to emit a `"\n"` array entry; `session.run(sql.raw("\n"))` crashes with "Failed to run the query '\n'".

## Commit

SHA: `58cd348d48e245ae6e1510e6e72c29e4564212bb`
Message: `feat(T1159): runtime guard sanitizes whitespace-only migration statements`

## Files Changed

| File | Change |
|------|--------|
| `packages/core/src/store/migration-manager.ts` | Already had `sanitizeMigrationStatements` + `migrateSanitized` + `migrateWithRetry` update in HEAD (from T1158). No new changes needed here. |
| `packages/core/src/store/migration-sqlite.ts` | Replaced `import { migrate } from 'drizzle-orm/node-sqlite/migrator'` + `migrate(db, { migrationsFolder })` with `migrateSanitized` |
| `packages/core/src/store/nexus-sqlite.ts` | Replaced `import { migrate } from 'drizzle-orm/node-sqlite/migrator'` + `migrate(db, { migrationsFolder })` with `migrateSanitized` |
| `packages/core/src/store/__tests__/sanitize-migration-statements.test.ts` | NEW: 9 unit tests for `sanitizeMigrationStatements` |
| `packages/core/src/store/__tests__/migrate-sanitized-smoke.test.ts` | NEW: 2 integration smoke tests (migrateSanitized succeeds; raw migrate crashes) |

## Test Results

- Before: 5350 passing (pre-task baseline)
- After: 5362 passing, 0 failing, 35 skipped, 33 todo
- New tests added: 11 (9 unit + 2 integration smoke)
- Zero new failures introduced

## Call Sites Converted

| File | Status |
|------|--------|
| `packages/core/src/store/sqlite.ts` | Uses `migrateWithRetry` which internally calls `migrateSanitized` — already covered |
| `packages/core/src/store/memory-sqlite.ts` | Uses `migrateWithRetry` — already covered |
| `packages/core/src/store/nexus-sqlite.ts` | Converted to `migrateSanitized` directly |
| `packages/core/src/telemetry/sqlite.ts` | Uses `migrateWithRetry` — already covered |
| `packages/core/src/store/migration-sqlite.ts` | Converted to `migrateSanitized` directly |

## Call Sites NOT Converted (flag for follow-up)

- `packages/core/src/store/migration-sqlite.ts` `migrateJsonToSqliteAtomic` function also had a raw `migrate()` call (line 189) — this WAS converted.
- Signaldock migration runner: `packages/core/src/store/signaldock-sqlite.ts` had no direct `migrate()` drizzle call (only a comment referencing "migration window").

## Export Path for T1160

`migrateSanitized` and `sanitizeMigrationStatements` are exported from:
- `packages/core/src/store/migration-manager.ts` (direct import)
- Available via `@cleocode/core/internal` once `internal.ts` includes the store exports (check if needed for T1160)

## Architecture Note

`migrateSanitized` accesses drizzle's `@internal` `dialect` and `session` properties via a typed assertion (`DrizzleNodeSQLiteInternals` interface). These properties exist at runtime but are not surfaced in the public TypeScript type. The interface documents the minimal subset required.
