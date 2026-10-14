/**
 * Regression — storeDecision's autoCrossLink must not block the next doc
 * write in the same process (T13565).
 *
 * Pre-fix, storeDecision fired autoCrossLinkDecision fire-and-forget. The
 * cross-link's first database touch is getBrainDb() → domain bind → cold-open
 * writer-lease claim (`BEGIN IMMEDIATE`). The fire-and-forget continuation
 * routinely outlived the caller: its graph writes stall at the autoCapture
 * config gate (async config reads) while the caller has already returned, so
 * at any handle teardown — a test boundary's closeAllDatabases, a session
 * end, a store eviction — the cross-link was still in flight. It then
 * re-binds the brain domain on a FRESH second connection to the same
 * consolidated cleo.db and claims the writer lease while the next writer
 * opens its own connection. The two connections busy-wait each other's
 * BEGIN IMMEDIATE for the full busy_timeout (30000 ms) —
 * `ERR_SQLITE_ERROR: database is locked` — and an orphaned-but-pid-alive
 * lease row makes the next writer queue behind a dead holder well past one
 * busy_timeout.
 *
 * Pre-fix repro numbers: with the cross-link NOT stubbed, the doc-write test
 * in triage.test.ts (the T13446 triage testing) blocked 60 s+ and failed its
 * 60 s vitest timeout; the orphaned fire-and-forget upsertGraphNode logged
 * `database is locked` four times at ~31 s intervals (one full busy_timeout
 * per writer-lease claim attempt, ~124 s total). The test below reproduces
 * the same stall pre-fix (~125 s, same four 31 s `database is locked`
 * claims) and completes in well under a second post-fix.
 *
 * Post-fix, storeDecision AWAITS the cross-link on the caller's own (still
 * bound) brain connection, so it can never outlive the call to race a
 * teardown or the next writer.
 *
 * @task T13565
 * @saga T13339
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { storeDecision } from '../../memory/decisions.js';
import { createAttachmentStore } from '../../store/attachment-store.js';
import { closeAllDatabases } from '../../store/sqlite.js';

let projectDir: string;
let homeDir: string;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), 'cleo-t13565-proj-'));
  homeDir = mkdtempSync(join(tmpdir(), 'cleo-t13565-home-'));
  for (const key of ['CLEO_HOME', 'CLEO_ROOT', 'CLEO_PROJECT_ROOT', 'CLEO_DIR'])
    saved[key] = process.env[key];
  process.env['CLEO_HOME'] = homeDir;
  process.env['CLEO_ROOT'] = projectDir;
  process.env['CLEO_PROJECT_ROOT'] = projectDir;
  process.env['CLEO_DIR'] = join(projectDir, '.cleo');
  // The cross-link's graph writes are gated on brain.autoCapture — enable it
  // explicitly so the regression exercises the real cross-link write path.
  mkdirSync(join(projectDir, '.cleo'), { recursive: true });
  writeFileSync(
    join(projectDir, '.cleo', 'config.json'),
    JSON.stringify({ brain: { autoCapture: true } }),
  );
});

afterEach(async () => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await closeAllDatabases();
  rmSync(projectDir, { recursive: true, force: true });
  rmSync(homeDir, { recursive: true, force: true });
});

describe('storeDecision cross-link vs the next doc write (T13565)', () => {
  it('a doc write after storeDecision + handle teardown completes promptly', async () => {
    // Seed a doc first (binds the tasks domain), like the docs.triage
    // --record path does.
    const store = createAttachmentStore();
    await store.put(
      Buffer.from('# seed\n\nSeed doc.\n', 'utf8'),
      { kind: 'blob', mime: 'text/markdown' } as Parameters<typeof store.put>[1],
      'task',
      'T13565',
      't13565-seed',
      projectDir,
      { slug: 't13565-seed', type: 'note' },
    );

    // Symbol-like rationale (the T13446 triage case): the cross-link
    // extracts camelCase symbols such as upsertGraphNode / addGraphEdge
    // and writes applies_to edges for each. A batch of decisions, like
    // `cleo docs triage --record` persists one per proposal.
    for (let i = 0; i < 3; i++) {
      await storeDecision(projectDir, {
        type: 'technical',
        decision: `Await the decision cross-link inside storeDecision (${i})`,
        rationale:
          'The extractReferencedSymbols pass matches identifiers like ' +
          'upsertGraphNode, addGraphEdge, and resolveKnowledgeSymbol, so the ' +
          'autoCrossLinkDecision applies_to edge writes into brain_page_edges ' +
          'must run before storeDecision returns.',
        confidence: 'high',
        confirmationState: 'accepted',
      });
    }

    // Handle teardown while the (pre-fix fire-and-forget) cross-link may
    // still be in flight — exactly what a test boundary's afterEach or a
    // session end does. Pre-fix the orphaned cross-link re-binds on a
    // second connection and its writer-lease claim busy-waits the full
    // busy_timeout against the next writer.
    await closeAllDatabases();

    const regressionStore = createAttachmentStore();
    const started = Date.now();
    await regressionStore.put(
      Buffer.from('# T13565\n\nRegression doc.\n', 'utf8'),
      { kind: 'blob', mime: 'text/markdown' } as Parameters<typeof regressionStore.put>[1],
      'task',
      'T13565',
      't13565-regression',
      projectDir,
      { slug: 't13565-regression', type: 'note' },
    );
    const elapsed = Date.now() - started;
    // Pre-fix this blocked for the full busy_timeout (~30 s per lease claim
    // attempt, 60 s+ total) — see the file header for the repro numbers.
    // Post-fix the write lands in milliseconds.
    expect(elapsed).toBeLessThan(5_000);
  }, 180_000);
});
