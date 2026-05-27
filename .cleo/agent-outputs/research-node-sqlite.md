# Node.js 24 `node:sqlite` -- Complete Technical Research

> Research Date: 2026-03-19
> Node.js Documentation Version: v25.8.1 (latest stable docs)

---

## 1. Current Status

**Stability: 1.2 -- Release Candidate** (as of Node.js v25.7.0)

| Milestone | Version | Date |
|---|---|---|
| Initial release (experimental) | v22.5.0 | July 2024 |
| No longer behind `--experimental-sqlite` flag | v23.4.0 / v22.13.0 | Late 2024 |
| New aggregate functions, `isTransaction` | v24.0.0 | May 2025 |
| SQLTagStore, session dispose | v24.9.0 | 2025 |
| Authorizer API | v24.10.0 | 2025 |
| Defensive mode default | v25.5.0 | 2026 |
| **Release Candidate** | v25.7.0 | 2026 |
| Runtime limits API | v25.8.0 | 2026 |

**Key fact:** As of Node.js v23.4.0 and v22.13.0, the `--experimental-sqlite` flag is **no longer required**. The module is importable directly. However, it is still not Stability 2 (Stable) -- it is 1.2 (Release Candidate), meaning the API surface is essentially frozen but has not yet been promoted to fully stable.

**Import:** Available only via the `node:` scheme:
```js
import { DatabaseSync } from 'node:sqlite';
// or
const { DatabaseSync } = require('node:sqlite');
```

---

## 2. Full API Surface

### 2.1 Module Exports

```js
import sqlite from 'node:sqlite';
// sqlite.DatabaseSync   -- Main database class
// sqlite.backup          -- Async backup function
// sqlite.constants       -- SQLite constants
```

### 2.2 Class: `DatabaseSync`

Represents a single synchronous connection to a SQLite database. All APIs execute synchronously.

#### Constructor

```js
new DatabaseSync(location[, options])
```

**Parameters:**
- `location` `<string | Buffer | URL>` -- File path, or `':memory:'` for in-memory database

**Options (all optional):**

```js
{
  open: true,                              // Auto-open on construction
  readOnly: false,                         // Open in read-only mode
  enableForeignKeyConstraints: true,       // PRAGMA foreign_keys = ON
  enableDoubleQuotedStringLiterals: false, // Non-standard double-quoted strings
  allowExtension: false,                   // Enable loadExtension()
  timeout: 0,                             // Busy timeout in ms (sqlite3_busy_timeout)
  readBigInts: false,                     // Return INTEGERs as BigInt
  returnArrays: false,                    // Return rows as arrays vs objects
  allowBareNamedParameters: true,         // Allow `foo` instead of `:foo`
  allowUnknownNamedParameters: false,     // Silently ignore unknown params
  defensive: true,                        // Prevent schema corruption (v25.5.0+)
  limits: {                               // SQLite resource limits
    length: <number>,
    sqlLength: <number>,
    column: <number>,
    exprDepth: <number>,
    compoundSelect: <number>,
    vdbeOp: <number>,
    functionArg: <number>,
    attach: <number>,
    likePatternLength: <number>,
    variableNumber: <number>,
    triggerDepth: <number>
  }
}
```

#### Methods

| Method | Added | Description |
|---|---|---|
| `exec(sql)` | v22.5.0 | Execute SQL without results (wraps `sqlite3_exec`) |
| `prepare(sql[, options])` | v22.5.0 | Create prepared statement (wraps `sqlite3_prepare_v2`) |
| `close()` | v22.5.0 | Close connection (wraps `sqlite3_close_v2`) |
| `open()` | v22.5.0 | Open database (when `open: false` in constructor) |
| `function(name[, options], fn)` | v23.5.0 | Register scalar user-defined function |
| `aggregate(name, options)` | v24.0.0 | Register aggregate/window function |
| `loadExtension(path)` | v23.5.0 | Load shared library extension |
| `enableLoadExtension(allow)` | v23.5.0 | Enable/disable extension loading |
| `enableDefensive(active)` | v25.1.0 | Enable/disable defensive mode |
| `setAuthorizer(callback)` | v24.10.0 | Set authorization callback |
| `location([dbName])` | v24.0.0 | Get database file path |
| `createSession([options])` | v23.3.0 | Create changeset session |
| `applyChangeset(changeset[, options])` | v23.3.0 | Apply binary changeset |
| `createTagStore([maxSize])` | v24.9.0 | Create LRU prepared statement cache |
| `[Symbol.dispose]()` | v23.11.0 | Close (supports `using` keyword) |

#### Properties

| Property | Added | Type | Description |
|---|---|---|---|
| `isOpen` | v23.11.0 | `boolean` | Whether connection is open |
| `isTransaction` | v24.0.0 | `boolean` | Whether inside a transaction |
| `limits` | v25.8.0 | `Object` | Runtime limit getter/setter |

---

### 2.3 Class: `StatementSync`

Created via `database.prepare()`. Cannot be constructed directly.

#### Methods

| Method | Added | Returns | Description |
|---|---|---|---|
| `all([named][, ...anon])` | v22.5.0 | `Array<Object>` | All matching rows |
| `get([named][, ...anon])` | v22.5.0 | `Object \| undefined` | First row |
| `run([named][, ...anon])` | v22.5.0 | `{ changes, lastInsertRowid }` | Execute DML |
| `iterate([named][, ...anon])` | v23.4.0 | `Iterator` | Lazy row iterator |
| `columns()` | v23.11.0 | `Array<ColumnMeta>` | Column metadata |
| `setReadBigInts(enabled)` | v22.5.0 | `void` | Toggle BigInt return |
| `setReturnArrays(enabled)` | v24.0.0 | `void` | Toggle array return |
| `setAllowBareNamedParameters(enabled)` | v22.5.0 | `void` | Toggle bare params |
| `setAllowUnknownNamedParameters(enabled)` | v23.11.0 | `void` | Toggle unknown params |

#### Properties

| Property | Type | Description |
|---|---|---|
| `sourceSQL` | `string` | Original SQL text |
| `expandedSQL` | `string` | SQL with bound values expanded |

#### Parameter Binding

Parameters can be anonymous (positional) or named:

```js
// Anonymous (positional with ?)
const stmt = db.prepare('INSERT INTO t VALUES (?, ?)');
stmt.run(1, 'hello');

// Named with prefix
const stmt2 = db.prepare('INSERT INTO t VALUES (:id, :name)');
stmt2.run({ id: 1, name: 'hello' });

// Bare named (allowBareNamedParameters: true, the default)
stmt2.run({ id: 1, name: 'hello' }); // No colon prefix needed in JS object
```

#### Return Values from `run()`

```js
const result = stmt.run(1, 'hello');
// result.changes       -- number of rows modified (number or bigint)
// result.lastInsertRowid -- rowid of last insert (number or bigint)
```

---

### 2.4 Class: `Session`

Created via `database.createSession()`. Tracks changes for replication/sync.

```js
const session = database.createSession({ table: 'myTable', db: 'main' });
// ... perform operations ...
const changeset = session.changeset();   // Uint8Array
const patchset = session.patchset();     // Uint8Array (compact)
session.close();
```

Apply to another database:
```js
targetDb.applyChangeset(changeset, {
  filter: (tableName) => tableName === 'myTable',
  onConflict: (conflictType) => sqlite.constants.SQLITE_CHANGESET_REPLACE
});
```

---

### 2.5 Class: `SQLTagStore`

Added in v24.9.0. An LRU cache for prepared statements using tagged template literals.

```js
const sql = db.createTagStore(1000); // max 1000 cached statements

// All standard query methods as template tags:
sql.run`INSERT INTO users VALUES (${id}, ${name})`;
const user = sql.get`SELECT * FROM users WHERE id = ${1}`;
const all = sql.all`SELECT * FROM users ORDER BY id`;

for (const row of sql.iterate`SELECT * FROM users`) {
  console.log(row);
}

// Properties
sql.size;      // current cache size
sql.capacity;  // max cache size
sql.db;        // associated DatabaseSync

sql.clear();   // flush cache
```

**Key advantage:** Automatic parameterization via template literals prevents SQL injection and reuses prepared statements.

---

### 2.6 Module-Level: `sqlite.backup()`

Added in v23.8.0. Asynchronous database backup.

```js
import sqlite, { DatabaseSync } from 'node:sqlite';

const db = new DatabaseSync('mydb.sqlite');
const totalPages = await sqlite.backup(db, 'backup.sqlite', {
  source: 'main',        // source db name
  target: 'main',        // target db name
  rate: 100,             // pages per batch
  progress: ({ totalPages, remainingPages }) => {
    console.log(`${remainingPages}/${totalPages} remaining`);
  }
});
```

---

### 2.7 Type Conversion Table

| SQLite Type | JS -> SQLite | SQLite -> JS |
|---|---|---|
| NULL | `null` | `null` |
| INTEGER | `number \| bigint` | `number` (or `bigint` if `readBigInts: true`) |
| REAL | `number` | `number` |
| TEXT | `string` | `string` |
| BLOB | `TypedArray \| DataView` | `Uint8Array` |

**Warning:** SQLite INTEGERs can store values up to 2^63-1, but JS numbers lose precision beyond 2^53-1. Use `readBigInts: true` if you need full INTEGER range.

---

## 3. Usage Patterns

### 3.1 Basic CRUD

```js
import { DatabaseSync } from 'node:sqlite';

const db = new DatabaseSync(':memory:');

// Schema creation
db.exec(`
  CREATE TABLE users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    email TEXT UNIQUE
  ) STRICT
`);

// Insert
const insert = db.prepare('INSERT INTO users (name, email) VALUES (?, ?)');
const result = insert.run('Alice', 'alice@example.com');
console.log(result.lastInsertRowid); // 1

// Query single
const getUser = db.prepare('SELECT * FROM users WHERE id = ?');
const user = getUser.get(1);
// { id: 1, name: 'Alice', email: 'alice@example.com' }

// Query all
const getAllUsers = db.prepare('SELECT * FROM users');
const users = getAllUsers.all();

// Iterate (lazy -- does not load all rows into memory)
for (const row of getAllUsers.iterate()) {
  console.log(row.name);
}

// Update
const update = db.prepare('UPDATE users SET name = ? WHERE id = ?');
update.run('Bob', 1);

// Delete
const del = db.prepare('DELETE FROM users WHERE id = ?');
del.run(1);

db.close();
```

### 3.2 Using `using` for Automatic Cleanup

```js
import { DatabaseSync } from 'node:sqlite';

{
  using db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE t(x)');
  // db.close() called automatically at end of block
}
```

### 3.3 Named Parameters

```js
const stmt = db.prepare('INSERT INTO users (name, email) VALUES (:name, :email)');

// With prefix (always works)
stmt.run({ ':name': 'Alice', ':email': 'alice@example.com' });

// Bare named (default: allowBareNamedParameters = true)
stmt.run({ name: 'Alice', email: 'alice@example.com' });
```

### 3.4 Transactions

`node:sqlite` does not have a built-in `transaction()` helper like `better-sqlite3`. You must use explicit SQL:

```js
db.exec('BEGIN');
try {
  const insert = db.prepare('INSERT INTO users (name) VALUES (?)');
  insert.run('Alice');
  insert.run('Bob');
  db.exec('COMMIT');
} catch (err) {
  db.exec('ROLLBACK');
  throw err;
}
```

You can check transaction state with `db.isTransaction`.

### 3.5 User-Defined Functions

```js
// Scalar function
db.function('double', (value) => value * 2);
db.prepare('SELECT double(21)').get(); // { 'double(21)': 42 }

// Deterministic (can be optimized by SQLite)
db.function('upper2', { deterministic: true }, (s) => s.toUpperCase());

// Aggregate function
db.aggregate('sumint', {
  start: 0,
  step: (accumulator, value) => accumulator + value,
});
db.prepare('SELECT sumint(amount) as total FROM orders').get();

// Window function (requires inverse)
db.aggregate('mywindow', {
  start: 0,
  step: (acc, val) => acc + val,
  inverse: (acc, val) => acc - val,
  result: (acc) => acc,
});
```

### 3.6 Authorization

```js
import sqlite, { DatabaseSync } from 'node:sqlite';
const { constants } = sqlite;

const db = new DatabaseSync(':memory:');
db.exec('CREATE TABLE secrets (data TEXT)');

db.setAuthorizer((actionCode, p1, p2, dbName, trigger) => {
  // Block all DELETE operations
  if (actionCode === constants.SQLITE_DELETE) {
    return constants.SQLITE_DENY;
  }
  // Block reading the 'secrets' table
  if (actionCode === constants.SQLITE_READ && p1 === 'secrets') {
    return constants.SQLITE_DENY;
  }
  return constants.SQLITE_OK;
});
```

---

## 4. WAL Mode and Pragma Settings

`node:sqlite` uses `exec()` to set PRAGMAs, just like raw SQL. There is no `.pragma()` convenience method like `better-sqlite3`.

### 4.1 Enable WAL Mode

```js
const db = new DatabaseSync('myapp.db');

// Enable WAL mode (critical for concurrent read performance)
db.exec('PRAGMA journal_mode = WAL');

// Verify
const result = db.prepare('PRAGMA journal_mode').get();
// { journal_mode: 'wal' }
```

### 4.2 Recommended Production Pragmas

```js
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA synchronous = NORMAL;
  PRAGMA cache_size = -64000;
  PRAGMA busy_timeout = 5000;
  PRAGMA foreign_keys = ON;
  PRAGMA temp_store = MEMORY;
  PRAGMA mmap_size = 268435456;
`);
```

| Pragma | Value | Effect |
|---|---|---|
| `journal_mode = WAL` | WAL | Allows concurrent reads during writes |
| `synchronous = NORMAL` | NORMAL | Reduced fsync calls; safe with WAL |
| `cache_size = -64000` | 64 MB | Larger page cache in memory |
| `busy_timeout = 5000` | 5 seconds | Wait for locks instead of failing |
| `foreign_keys = ON` | Enabled | Enforce FK constraints (also via constructor option) |
| `temp_store = MEMORY` | Memory | Temp tables in RAM |
| `mmap_size = 268435456` | 256 MB | Memory-mapped I/O |

**Note:** The `timeout` constructor option also sets `busy_timeout`, so you can use either:
```js
// These are equivalent:
new DatabaseSync('db.sqlite', { timeout: 5000 });
// or
db.exec('PRAGMA busy_timeout = 5000');
```

**Note:** `enableForeignKeyConstraints: true` (the default) automatically sets `PRAGMA foreign_keys = ON`.

### 4.3 WAL Checkpoint

```js
// Manual checkpoint (useful under heavy concurrent load)
db.exec('PRAGMA wal_checkpoint(RESTART)');
```

---

## 5. Drizzle ORM Integration

### 5.1 Installation

```bash
pnpm add drizzle-orm
pnpm add -D drizzle-kit
```

### 5.2 Driver Path

```
drizzle-orm/node-sqlite
```

### 5.3 Basic Setup (Async API)

```js
import { drizzle } from 'drizzle-orm/node-sqlite';

// Simple -- Drizzle creates the DatabaseSync internally
const db = drizzle('sqlite.db');

const result = await db.select().from(users);
```

### 5.4 Explicit Client Setup

```js
import { drizzle } from 'drizzle-orm/node-sqlite';
import { DatabaseSync } from 'node:sqlite';

const sqlite = new DatabaseSync('sqlite.db');
const db = drizzle({ client: sqlite });

const result = await db.select().from(users);
```

### 5.5 Synchronous API

Drizzle is unique among ORMs in offering a synchronous API for synchronous drivers like `node:sqlite`:

```js
import { drizzle } from 'drizzle-orm/node-sqlite';
import { DatabaseSync } from 'node:sqlite';

const sqlite = new DatabaseSync('sqlite.db');
const db = drizzle({ client: sqlite });

// Synchronous query methods
const allResults = db.select().from(users).all();
const singleResult = db.select().from(users).get();
const values = db.select().from(users).values();
const runResult = db.insert(users).values({ name: 'Alice' }).run();
```

### 5.6 Schema Definition

```js
// schema.ts
import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core';

export const users = sqliteTable('users', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(),
  email: text('email').unique(),
});
```

### 5.7 drizzle.config.ts

```ts
import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  schema: './src/schema.ts',
  out: './drizzle',
  dialect: 'sqlite',
  dbCredentials: {
    url: 'sqlite.db',
  },
});
```

### 5.8 Known Limitation (as of March 2026)

**`drizzle-kit` does not fully support `node:sqlite` yet.** When running `drizzle-kit push`, `drizzle-kit migrate`, or `drizzle-kit studio`, you may get:

> "Please install either 'better-sqlite3', 'bun', '@libsql/client' or '@tursodatabase/database' for Drizzle Kit to connect to SQLite databases."

**Workaround:** Install `better-sqlite3` as a dev dependency for `drizzle-kit` operations:
```bash
pnpm add -D better-sqlite3
```

The runtime ORM layer (`drizzle-orm/node-sqlite`) works with `node:sqlite` at runtime. Only the CLI tooling (`drizzle-kit`) needs the fallback driver.

This is tracked in [GitHub Issue #5471](https://github.com/drizzle-team/drizzle-orm/issues/5471).

---

## 6. Performance Characteristics

### 6.1 Benchmark Summary

Based on expanded benchmarks conducted by the `better-sqlite3` maintainers (May 2025):

> "Performance is almost indistinguishable, at least for the expanded set of benchmarks that I could come up with, between this library [`better-sqlite3`] and `node:sqlite`."

| Library | Architecture | Performance |
|---|---|---|
| `node:sqlite` | Synchronous, built into Node.js | Near-identical to better-sqlite3 |
| `better-sqlite3` | Synchronous, native addon | Industry benchmark leader |
| `node-sqlite3` | Asynchronous, native addon | Significantly slower (mutex thrashing) |

### 6.2 Why Both Are Fast

Both `node:sqlite` and `better-sqlite3` use synchronous C bindings to SQLite, avoiding the overhead of async wrappers and thread pool dispatching. The synchronous model eliminates:
- Mutex contention from multi-threaded access
- Memory copying between threads
- Event loop overhead for callback scheduling

### 6.3 SQLite General Performance

With proper tuning (WAL mode, indexing, appropriate pragmas):
- 2000+ queries/second with 5-way joins on 60 GB databases
- Bulk inserts: hundreds of thousands of rows per second when wrapped in transactions
- Single-digit microsecond latency for simple key-value lookups

---

## 7. Limitations Compared to `better-sqlite3`

### 7.1 What `node:sqlite` Lacks

| Feature | `better-sqlite3` | `node:sqlite` |
|---|---|---|
| **Transaction helper** | `db.transaction(fn)` -- auto BEGIN/COMMIT/ROLLBACK | Manual `BEGIN`/`COMMIT`/`ROLLBACK` via `exec()` |
| **`.pragma()` method** | `db.pragma('journal_mode = WAL')` returns parsed result | Must use `exec()` + `prepare().get()` separately |
| **`.backup()` sync** | `db.backup(dest)` synchronous | `sqlite.backup()` is async (Promise-based) |
| **Stability** | Stable, production-proven for years | Release Candidate (Stability 1.2) |
| **Custom collation** | Supported | Not available |
| **Verbose/trace** | `db.verbose()` for debugging | Not available |
| **WAL checkpoint control** | Built-in checkpoint methods | Via PRAGMA only |
| **Worker thread patterns** | Well-documented patterns | No specific guidance |
| **Ecosystem maturity** | Extensive docs, community, Stack Overflow answers | Limited ecosystem |
| **Prebuilt binaries** | Available for all major platforms | N/A (built into Node.js) |

### 7.2 What `node:sqlite` Has That `better-sqlite3` Does Not

| Feature | `node:sqlite` | `better-sqlite3` |
|---|---|---|
| **Zero dependencies** | Built into Node.js | Requires native addon compilation |
| **Session/Changeset API** | Full session, changeset, patchset support | Not available |
| **SQLTagStore** | Template literal query builder with LRU cache | Not available |
| **Authorizer** | `setAuthorizer()` for fine-grained access control | Not available |
| **`using` keyword** | `Symbol.dispose` support | Not available |
| **Runtime limits** | `db.limits` getter/setter | Not available |
| **Defensive mode** | Built-in `defensive` option | Not available |
| **No native compilation** | Works everywhere Node.js works | Requires node-gyp / prebuild |

### 7.3 When to Use Which

**Choose `node:sqlite` when:**
- You want zero external dependencies
- You need Session/Changeset APIs for replication
- You are building for environments where native compilation is difficult (e.g., CI, containers, serverless)
- You are using Node.js 22.13.0+ and are comfortable with Release Candidate stability

**Choose `better-sqlite3` when:**
- You need the `transaction()` helper for ergonomic transaction management
- You need `.pragma()` convenience methods
- You need maximum ecosystem support and documentation
- You need Drizzle Kit CLI support without workarounds
- You are on an older Node.js version

---

## 8. Configuration Reference (Quick Copy)

### Minimal Production Setup

```js
import { DatabaseSync } from 'node:sqlite';

const db = new DatabaseSync('app.db', {
  timeout: 5000,
  enableForeignKeyConstraints: true,
});

db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA synchronous = NORMAL;
  PRAGMA cache_size = -64000;
  PRAGMA temp_store = MEMORY;
  PRAGMA mmap_size = 268435456;
`);
```

### With Drizzle ORM

```js
import { DatabaseSync } from 'node:sqlite';
import { drizzle } from 'drizzle-orm/node-sqlite';
import * as schema from './schema.js';

const sqlite = new DatabaseSync('app.db', {
  timeout: 5000,
  enableForeignKeyConstraints: true,
});

sqlite.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA synchronous = NORMAL;
  PRAGMA cache_size = -64000;
  PRAGMA temp_store = MEMORY;
  PRAGMA mmap_size = 268435456;
`);

const db = drizzle({ client: sqlite, schema });

// Async
const users = await db.select().from(schema.users);

// Sync
const usersSync = db.select().from(schema.users).all();
```

---

## Sources

- [Node.js SQLite Official Documentation (v25.8.1)](https://nodejs.org/api/sqlite.html)
- [Node.js GitHub -- sqlite.md source](https://github.com/nodejs/node/blob/main/doc/api/sqlite.md)
- [10 Node.js 24 Features -- LogRocket Blog](https://blog.logrocket.com/node-js-24-features/)
- [Getting Started with Native SQLite in Node.js -- Better Stack](https://betterstack.com/community/guides/scaling-nodejs/nodejs-sqlite/)
- [Drizzle ORM -- SQLite Getting Started](https://orm.drizzle.team/docs/get-started-sqlite)
- [Drizzle ORM -- Connect Node SQLite](https://orm.drizzle.team/docs/connect-node-sqlite)
- [drizzle-kit node:sqlite support bug -- GitHub Issue #5471](https://github.com/drizzle-team/drizzle-orm/issues/5471)
- [drizzle-orm node:sqlite feature request -- GitHub Issue #2648](https://github.com/drizzle-team/drizzle-orm/issues/2648)
- [node:sqlite benchmarking -- better-sqlite3 Issue #1266](https://github.com/WiseLibs/better-sqlite3/issues/1266)
- [better-sqlite3 vs node:sqlite discussion -- GitHub Discussion #1245](https://github.com/WiseLibs/better-sqlite3/discussions/1245)
- [future of better-sqlite3 vs node:sqlite -- GitHub Issue #1234](https://github.com/WiseLibs/better-sqlite3/issues/1234)
- [Intro to Node's built-in SQLite module -- InfoWorld](https://www.infoworld.com/article/3537050/intro-to-nodes-built-in-sqlite-module.html)
