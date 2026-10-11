// T13548: takes the database write lock, says so on stderr, then stalls mid-"publish".
import { DatabaseSync } from 'node:sqlite';
process.once('message', (input) => {
  const db = new DatabaseSync(input.repoPath);
  db.exec('BEGIN IMMEDIATE; INSERT INTO t VALUES (1);');
  process.stderr.write('locked\n');
  for (;;) {}
});
