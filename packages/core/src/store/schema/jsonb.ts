/**
 * Reusable Drizzle `jsonb<T>()` custom column type for SQLite JSONB storage.
 *
 * ## Why this exists
 *
 * SQLite 3.45.0+ (bundled in node:sqlite 3.53.0, the runtime CLEO targets)
 * fully supports the JSONB binary encoding plus the `jsonb_*()` SQL function
 * family. Storing a JSON document as a JSONB BLOB rather than as serialized
 * TEXT avoids re-parsing the text on every `json_extract` / `json_each` call —
 * the parse happens once, at write time. For columns that are queried or
 * mutated *inside SQL* (membership tests, append-heavy id-lists, scalar
 * extraction in a WHERE clause), JSONB is the correct storage class.
 *
 * Drizzle's beta/rc line ships **no native `jsonb()` builder**, so we express
 * the storage class through {@link customType}: a `blob` column whose
 * `toDriver` wraps the serialized value in the SQL `jsonb()` constructor.
 *
 * ## The load-bearing read rule
 *
 * The on-disk JSONB encoding is an **opaque, version-unstable** binary format.
 * Application code MUST NEVER `JSON.parse` the raw BLOB bytes returned by a
 * plain `SELECT col`. Whole-value reads MUST round-trip the value back through
 * the SQL `json(col)` function, which emits canonical, parseable TEXT
 * regardless of the writer's SQLite version. Two safe read paths exist:
 *
 *   1. **Whole-value reads** — project the column with `SELECT json(col)` (or
 *      use {@link jsonbText} as a select helper) and `JSON.parse` the TEXT.
 *   2. **In-SQL reads** — `jsonb_extract(col, '$.path')`, `json_each(col)`,
 *      etc., operate on the BLOB directly with no application-side parsing.
 *
 * {@link jsonb} guards the unsafe path: its `fromDriver` rejects a raw BLOB and
 * directs callers to `json(col)`, so a `SELECT *` that forgets the rule fails
 * loudly instead of silently parsing version-unstable bytes. When a JSONB
 * column is genuinely read whole, project it with {@link jsonbText} so Drizzle
 * receives TEXT (`json(col)`) and `fromDriver` parses it normally.
 *
 * ## Backup / export discipline (version-instability constraint)
 *
 * Because the binary format is not cross-version-portable, **every backup or
 * export of a JSONB column MUST emit `json(col)`**, never the raw BLOB. A
 * `VACUUM INTO` snapshot preserves the bytes verbatim (same SQLite engine, so
 * safe), but any logical dump / cross-machine export / JSON serialization path
 * MUST project through `json(col)` first.
 *
 * @see {@link https://sqlite.org/json1.html#jsonb} SQLite JSONB documentation
 * @see `.cleo/rcasd/json-storage-jsonb-audit.md` per-field decision matrix
 * @task T11354
 * @epic T11286
 * @saga T11283
 */

import type { SQL } from 'drizzle-orm';
import { sql } from 'drizzle-orm';
import { customType } from 'drizzle-orm/sqlite-core';

/**
 * Raw driver-side representation of a JSONB column.
 *
 * node:sqlite hands back a `Uint8Array`/`Buffer` for BLOB columns. We never
 * decode it directly — see the module docs for why.
 */
type JsonbDriverData = Buffer | Uint8Array;

/**
 * Drizzle custom column type for a SQLite JSONB BLOB holding a value of type `T`.
 *
 * Storage class is `blob`. Writes wrap the JSON-serialized value in the SQL
 * `jsonb()` constructor so SQLite stores the parsed binary form. Reads of the
 * raw BLOB are intentionally rejected by `fromDriver`: callers MUST project the
 * column with `json(col)` (use {@link jsonbText}) for whole-value reads, or use
 * `jsonb_extract` / `json_each` for in-SQL access.
 *
 * @typeParam T - The TypeScript shape of the stored JSON document.
 * @param name - The physical column name.
 * @returns A Drizzle column builder for the JSONB column.
 *
 * @example
 * ```ts
 * const myTable = sqliteTable('my_table', {
 *   id: text('id').primaryKey(),
 *   payload: jsonb<{ tags: string[] }>('payload').default(sql`jsonb('{}')`),
 * });
 *
 * // Write — toDriver wraps in jsonb():
 * await db.insert(myTable).values({ id: 'x', payload: { tags: ['a'] } });
 *
 * // Whole-value read — project json(col):
 * const rows = await db
 *   .select({ id: myTable.id, payload: jsonbText(myTable.payload) })
 *   .from(myTable);
 * ```
 */
export const jsonb = <T>(name: string) =>
  customType<{ data: T; driverData: JsonbDriverData }>({
    dataType: () => 'blob',
    /**
     * Serialize the value and wrap it in SQLite's `jsonb()` constructor so the
     * engine stores the parsed binary encoding rather than raw text bytes.
     */
    toDriver: (value: T): SQL => sql`jsonb(${JSON.stringify(value)})`,
    /**
     * Guard the unsafe read path. A raw BLOB reaching application code means a
     * query projected the column directly instead of through `json(col)`. The
     * on-disk JSONB format is version-unstable, so parsing those bytes is a
     * latent corruption bug — fail loudly instead.
     *
     * @throws {Error} Always — directs the caller to `json(col)` / `jsonbText`.
     */
    fromDriver: (_value: JsonbDriverData): T => {
      throw new Error(
        'jsonb column read as raw BLOB — project it with json(col) (see jsonbText) for ' +
          'whole-value reads, or use jsonb_extract / json_each for in-SQL access. ' +
          'The on-disk JSONB format is version-unstable and MUST NOT be JSON.parse-d directly.',
      );
    },
  })(name);

/**
 * Build a `json(col)` projection for a JSONB column and decode the resulting
 * TEXT back into the parsed document `T`.
 *
 * SQLite's `json(col)` emits canonical, version-stable TEXT for a JSONB BLOB;
 * the `.mapWith(JSON.parse)` decoder then yields the live object so callers
 * never see (or have to parse) the raw bytes. Use this in the `.select({ ... })`
 * map for any whole-value read of a column declared with {@link jsonb}. It
 * satisfies both the read rule and the backup/export rule by routing through
 * SQLite's `json()` function.
 *
 * @typeParam T - The stored JSON document shape.
 * @param column - A column reference (or SQL expression) for the JSONB column.
 * @returns A typed SQL expression yielding the parsed JSON document of type `T`.
 *
 * @example
 * ```ts
 * const rows = await db
 *   .select({ tags: jsonbText<string[]>(myTable.tags) })
 *   .from(myTable);
 * // rows[0].tags is string[] — already parsed
 * ```
 */
export function jsonbText<T = unknown>(column: SQL | SQL.Aliased): SQL<T> {
  // `sql` interpolates a column reference, an aliased expression, or a raw SQL
  // fragment uniformly — all are valid `json()` arguments. The decoder parses
  // the TEXT json() emits so consumers receive the live document.
  return sql`json(${column})`.mapWith((text: string): T => JSON.parse(text) as T);
}
