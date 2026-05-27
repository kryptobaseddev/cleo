/**
 * Deriver Queue — Unit and Integration Tests
 *
 * Tests the enqueue, claim, complete, fail, and stale-recovery operations
 * using real SQLite via DatabaseSync with an in-memory database.
 *
 * Uses DatabaseSync for synchronous SQLite operations (matching codebase pattern).
 *
 * @task T1145
 * @epic T1145
 */

import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { enqueueDerivation, enqueueObservationBatch } from '../enqueue.js';
import {
  claimNextItem,
  completeItem,
  failItem,
  MAX_RETRY_COUNT,
  recoverStaleItems,
  STALE_CLAIM_MINUTES,
} from '../queue-manager.js';
import { getQueueStatus, hasQueuePending, listQueueItems } from '../status.js';

// ---------------------------------------------------------------------------
// Test DB setup — in-memory SQLite with deriver_queue table
// ---------------------------------------------------------------------------

let db: DatabaseSync;

function setupDb(): DatabaseSync {
  const d = new DatabaseSync(':memory:');
  d.exec(`
    CREATE TABLE deriver_queue (
      id            TEXT PRIMARY KEY,
      item_type     TEXT NOT NULL,
      item_id       TEXT NOT NULL,
      priority      INTEGER NOT NULL DEFAULT 0,
      status        TEXT NOT NULL DEFAULT 'pending',
      claimed_at    TEXT,
      claimed_by    TEXT,
      error_msg     TEXT,
      retry_count   INTEGER NOT NULL DEFAULT 0,
      created_at    TEXT NOT NULL DEFAULT (datetime('now')),
      completed_at  TEXT
    );
    CREATE INDEX idx_deriver_queue_status_priority
      ON deriver_queue(status, priority DESC, created_at ASC);
    CREATE INDEX idx_deriver_queue_item
      ON deriver_queue(item_type, item_id);
    CREATE INDEX idx_deriver_queue_claimed_at
      ON deriver_queue(claimed_at);
  `);
  return d;
}

beforeEach(() => {
  db = setupDb();
});

afterEach(() => {
  db.close();
});

// ---------------------------------------------------------------------------
// Enqueue tests
// ---------------------------------------------------------------------------

describe('enqueueDerivation', () => {
  it('inserts a new pending item and returns inserted=true', () => {
    const result = enqueueDerivation('observation', 'obs-001', { db });
    expect(result.inserted).toBe(true);
    expect(result.id).toMatch(/^dq-/);

    const status = getQueueStatus({ db });
    expect(status.pending).toBe(1);
    expect(status.total).toBe(1);
  });

  it('deduplicates: returns existing ID if pending item exists for same (type, itemId)', () => {
    const first = enqueueDerivation('observation', 'obs-001', { db });
    const second = enqueueDerivation('observation', 'obs-001', { db });

    expect(second.inserted).toBe(false);
    expect(second.id).toBe(first.id);
    expect(getQueueStatus({ db }).pending).toBe(1);
  });

  it('deduplicates: returns existing ID if in_progress item exists', () => {
    const first = enqueueDerivation('observation', 'obs-002', { db });
    // Manually advance to in_progress
    db.prepare("UPDATE deriver_queue SET status='in_progress' WHERE id=?").run(first.id);

    const second = enqueueDerivation('observation', 'obs-002', { db });
    expect(second.inserted).toBe(false);
    expect(second.id).toBe(first.id);
  });

  it('allows re-enqueue after item is done', () => {
    const first = enqueueDerivation('observation', 'obs-003', { db });
    db.prepare("UPDATE deriver_queue SET status='done' WHERE id=?").run(first.id);

    const second = enqueueDerivation('observation', 'obs-003', { db });
    expect(second.inserted).toBe(true);
    expect(second.id).not.toBe(first.id);
  });
});

describe('enqueueObservationBatch', () => {
  it('enqueues multiple observations and returns inserted count', () => {
    const count = enqueueObservationBatch(['obs-a', 'obs-b', 'obs-c'], { db });
    expect(count).toBe(3);
    expect(getQueueStatus({ db }).pending).toBe(3);
  });

  it('counts only newly inserted items (deduplication excluded)', () => {
    enqueueDerivation('observation', 'obs-a', { db }); // pre-existing
    const count = enqueueObservationBatch(['obs-a', 'obs-b'], { db });
    expect(count).toBe(1); // only obs-b is new
  });
});

// ---------------------------------------------------------------------------
// Claim tests
// ---------------------------------------------------------------------------

describe('claimNextItem', () => {
  it('claims the next pending item and returns it', () => {
    enqueueDerivation('observation', 'obs-001', { db });
    const item = claimNextItem({ db, workerId: 'test-worker' });

    expect(item).not.toBeNull();
    expect(item!.itemType).toBe('observation');
    expect(item!.itemId).toBe('obs-001');

    const status = getQueueStatus({ db });
    expect(status.pending).toBe(0);
    expect(status.in_progress).toBe(1);
  });

  it('returns null if queue is empty', () => {
    const item = claimNextItem({ db });
    expect(item).toBeNull();
  });

  it('respects priority ordering (higher priority claimed first)', () => {
    enqueueDerivation('observation', 'low-priority', { db, priority: 0 });
    enqueueDerivation('observation', 'high-priority', { db, priority: 10 });

    const item = claimNextItem({ db, workerId: 'test-worker' });
    expect(item!.itemId).toBe('high-priority');
  });

  it('concurrent claim safety: two callers get different items', () => {
    enqueueDerivation('observation', 'obs-001', { db });
    enqueueDerivation('observation', 'obs-002', { db });

    const item1 = claimNextItem({ db, workerId: 'worker-1' });
    const item2 = claimNextItem({ db, workerId: 'worker-2' });

    expect(item1).not.toBeNull();
    expect(item2).not.toBeNull();
    expect(item1!.id).not.toBe(item2!.id);
  });
});

// ---------------------------------------------------------------------------
// Complete / fail tests
// ---------------------------------------------------------------------------

describe('completeItem', () => {
  it('marks an in_progress item as done', () => {
    enqueueDerivation('observation', 'obs-001', { db });
    const item = claimNextItem({ db, workerId: 'w1' })!;
    completeItem(item.id, { db });

    const status = getQueueStatus({ db });
    expect(status.done).toBe(1);
    expect(status.in_progress).toBe(0);
  });
});

describe('failItem', () => {
  it('re-queues to pending with incremented retry count if under max', () => {
    enqueueDerivation('observation', 'obs-001', { db });
    const item = claimNextItem({ db, workerId: 'w1' })!;
    failItem(item.id, 'test error', { db });

    const row = db
      .prepare<{ status: string; retry_count: number; error_msg: string }, [string]>(
        'SELECT status, retry_count, error_msg FROM deriver_queue WHERE id=?',
      )
      .get(item.id)!;

    expect(row.status).toBe('pending');
    expect(row.retry_count).toBe(1);
    expect(row.error_msg).toBe('test error');
  });

  it('moves to failed permanently after max retries', () => {
    enqueueDerivation('observation', 'obs-001', { db });
    // Manually set retry_count to max-1
    db.prepare('UPDATE deriver_queue SET retry_count=?, status=? WHERE item_id=?').run(
      MAX_RETRY_COUNT - 1,
      'in_progress',
      'obs-001',
    );

    const item = claimNextItem({ db, workerId: 'w1' }) ?? { id: '' };
    // Get the actual ID since claim may fail after manual update
    const existingRow = db
      .prepare<{ id: string }, []>('SELECT id FROM deriver_queue LIMIT 1')
      .get()!;
    failItem(existingRow.id, 'final error', { db });

    const row = db
      .prepare<{ status: string }, [string]>('SELECT status FROM deriver_queue WHERE id=?')
      .get(existingRow.id)!;
    expect(row.status).toBe('failed');
  });
});

// ---------------------------------------------------------------------------
// Stale recovery tests
// ---------------------------------------------------------------------------

describe('recoverStaleItems', () => {
  it('re-queues in_progress items with old claimed_at', () => {
    enqueueDerivation('observation', 'obs-stale', { db });
    claimNextItem({ db, workerId: 'w1' });

    // Manually backdate claimed_at to exceed stale threshold
    const staleTime = new Date(Date.now() - (STALE_CLAIM_MINUTES + 5) * 60_000).toISOString();
    db.prepare("UPDATE deriver_queue SET claimed_at=? WHERE item_id='obs-stale'").run(staleTime);

    const result = recoverStaleItems({ db });
    expect(result.requeued).toBe(1);
    expect(result.failed).toBe(0);

    expect(getQueueStatus({ db }).pending).toBe(1);
    expect(getQueueStatus({ db }).in_progress).toBe(0);
  });

  it('does not touch fresh in_progress items', () => {
    enqueueDerivation('observation', 'obs-fresh', { db });
    claimNextItem({ db, workerId: 'w1' });

    const result = recoverStaleItems({ db });
    expect(result.requeued).toBe(0);
    expect(getQueueStatus({ db }).in_progress).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Status / list tests
// ---------------------------------------------------------------------------

describe('getQueueStatus and hasQueuePending', () => {
  it('returns correct counts after mixed operations', () => {
    enqueueDerivation('observation', 'o1', { db });
    enqueueDerivation('observation', 'o2', { db });
    const item = claimNextItem({ db, workerId: 'w1' })!;
    completeItem(item.id, { db });

    const status = getQueueStatus({ db });
    expect(status.pending).toBe(1);
    expect(status.in_progress).toBe(0);
    expect(status.done).toBe(1);
    expect(status.total).toBe(2);
  });

  it('hasQueuePending returns true when pending items exist', () => {
    enqueueDerivation('observation', 'o1', { db });
    expect(hasQueuePending({ db })).toBe(true);
  });

  it('hasQueuePending returns false when queue is empty', () => {
    expect(hasQueuePending({ db })).toBe(false);
  });
});

describe('listQueueItems', () => {
  it('returns items filtered by status', () => {
    enqueueDerivation('observation', 'o1', { db });
    enqueueDerivation('observation', 'o2', { db });
    claimNextItem({ db, workerId: 'w1' });

    const pending = listQueueItems('pending', 10, { db });
    expect(pending).toHaveLength(1);

    const inProgress = listQueueItems('in_progress', 10, { db });
    expect(inProgress).toHaveLength(1);

    const all = listQueueItems('all', 10, { db });
    expect(all).toHaveLength(2);
  });
});
