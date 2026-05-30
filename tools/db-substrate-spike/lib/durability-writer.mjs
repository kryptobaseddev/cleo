/**
 * Killable writer for the durability harness (T11325).
 *
 * Plain `.mjs` (NOT TypeScript) so it can be spawned as a bare child process
 * via `node`/`tsx` and reliably SIGKILLed mid-transaction without depending on
 * a loader being registered in the child. It:
 *
 *   1. Opens the consolidated file with the mandatory pragma set.
 *   2. Inserts a stream of rows, committing each.
 *   3. Opens a LONG transaction, performs a multi-statement write, signals the
 *      parent it is "mid-transaction" (via a sentinel row + stdout marker), and
 *      then spins so the parent can SIGKILL it BEFORE COMMIT.
 *
 * On SIGKILL the WAL is left in whatever state the OS flushed — exactly the
 * power-cut / crash scenario WAL recovery + `integrity_check` must survive.
 *
 * Argv: <dbPath> <committedRows>
 *
 * @task T11325
 * @saga T11242
 */
import { createRequire } from 'node:module';

const require_ = createRequire(import.meta.url);
const { DatabaseSync } = require_('node:sqlite');

const PRAGMAS = [
  ['journal_mode', 'WAL'],
  ['synchronous', 'NORMAL'],
  ['busy_timeout', '30000'],
  ['wal_autocheckpoint', '1000'],
  ['foreign_keys', 'ON'],
];

const dbPath = process.argv[2];
const committedRows = Number(process.argv[3] ?? 50);

const db = new DatabaseSync(dbPath);
for (const [name, value] of PRAGMAS) db.exec(`PRAGMA ${name} = ${value};`);

db.exec(`
  CREATE TABLE IF NOT EXISTS durability_log (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    committed  INTEGER NOT NULL,
    payload    TEXT NOT NULL
  );
`);

const insert = db.prepare('INSERT INTO durability_log (committed, payload) VALUES (?, ?)');

// 1. Commit a known number of rows so post-crash we can assert these survived.
for (let i = 0; i < committedRows; i++) {
  db.exec('BEGIN IMMEDIATE;');
  insert.run(1, `committed-${i}`);
  db.exec('COMMIT;');
}

// 2. Open a transaction, write uncommitted rows, then spin so the parent can
//    SIGKILL us mid-transaction (before COMMIT).
db.exec('BEGIN IMMEDIATE;');
for (let i = 0; i < 25; i++) {
  insert.run(0, `UNCOMMITTED-${i}`);
}
// Tell the parent we are now mid-transaction and safe to kill.
process.stdout.write('MID_TX\n');

// Spin forever (the parent kills us). Keep the event loop alive.
setInterval(() => {
  // hot loop touching the open transaction so the WAL has dirty frames
  try {
    insert.run(0, `SPIN-${Date.now()}`);
  } catch {
    // ignore
  }
}, 1);
