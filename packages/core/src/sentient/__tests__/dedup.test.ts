/**
 * Tests for the per-parent proposal-dedup gate (T1592).
 *
 * Reproduces the T1555 burst failure mode (sentient proposer running twice
 * on the same audit output → 4 dup pairs T1544/T1550, T1545/T1551, ...) and
 * verifies that the second run rejects every duplicate, persists rejections
 * to `.cleo/audit/sentient-dedup.jsonl`, and continues to allow legitimately
 * new proposals (different parent OR outside the 24h window).
 *
 * Tests use an in-memory `node:sqlite` DatabaseSync — no real tasks.db is
 * opened.
 *
 * @task T1592 (Foundation Lockdown · Wave A · Worker 4)
 */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  checkDedupCollision,
  computeDedupHash,
  DEFAULT_DEDUP_WINDOW_HOURS,
  type DedupRejectionRecord,
  normalizeForDedup,
  recordDedupRejection,
  SENTIENT_DEDUP_AUDIT_FILE,
} from '../proposal-dedup.js';
import { SENTIENT_TIER2_TAG } from '../proposal-rate-limiter.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'cleo-dedup-'));
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

/**
 * Create an in-memory tasks table with the columns dedup queries against.
 * Mirrors the live schema for: id, parent_id, labels_json, notes_json,
 * created_at, status.
 */
function createTasksDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE tasks (
      id TEXT PRIMARY KEY,
      parent_id TEXT,
      title TEXT NOT NULL,
      description TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      priority TEXT NOT NULL DEFAULT 'medium',
      labels_json TEXT NOT NULL DEFAULT '[]',
      notes_json TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL,
      updated_at TEXT,
      role TEXT NOT NULL DEFAULT 'work',
      scope TEXT NOT NULL DEFAULT 'feature'
    )
  `);
  return db;
}

/**
 * Insert a Tier-2-style proposal carrying the given dedup hash and creation
 * timestamp. Mirrors what `runProposeTick` writes after T1592.
 */
function insertExistingProposal(
  db: DatabaseSync,
  args: {
    id: string;
    parentId: string | null;
    title: string;
    rationale: string;
    dedupHash: string;
    createdAt?: string;
  },
) {
  const meta = JSON.stringify({
    kind: 'proposal-meta',
    proposedBy: 'sentient-tier2',
    source: 'brain',
    sourceId: 'O-fixture',
    weight: 0.5,
    proposedAt: args.createdAt ?? new Date().toISOString(),
    dedupHash: args.dedupHash,
  });
  db.prepare(
    `INSERT INTO tasks (
      id, parent_id, title, description, status,
      labels_json, notes_json, created_at, role, scope
    ) VALUES (
      :id, :parentId, :title, :rationale, 'proposed',
      :labelsJson, :notesJson, :createdAt, 'work', 'feature'
    )`,
  ).run({
    id: args.id,
    parentId: args.parentId,
    title: args.title,
    rationale: args.rationale,
    labelsJson: JSON.stringify([SENTIENT_TIER2_TAG, 'source:brain']),
    notesJson: JSON.stringify([meta]),
    createdAt: args.createdAt ?? new Date().toISOString(),
  });
}

// ---------------------------------------------------------------------------
// normalizeForDedup
// ---------------------------------------------------------------------------

describe('normalizeForDedup', () => {
  it('lowercases', () => {
    expect(normalizeForDedup('Hello World')).toBe('hello world');
  });

  it('strips punctuation', () => {
    expect(normalizeForDedup('hello, world!')).toBe('hello world');
    expect(normalizeForDedup('[T2-BRAIN] auth: failures (4x)')).toBe('t2 brain auth failures 4x');
  });

  it('collapses whitespace', () => {
    expect(normalizeForDedup('a   b\tc\n\nd')).toBe('a b c d');
  });

  it('handles null / undefined', () => {
    expect(normalizeForDedup(null)).toBe('');
    expect(normalizeForDedup(undefined)).toBe('');
  });
});

// ---------------------------------------------------------------------------
// computeDedupHash — determinism
// ---------------------------------------------------------------------------

describe('computeDedupHash', () => {
  it('is stable across calls with identical inputs', () => {
    const a = computeDedupHash({ parentId: 'T100', title: 'foo', acceptance: 'bar' });
    const b = computeDedupHash({ parentId: 'T100', title: 'foo', acceptance: 'bar' });
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it('treats null vs empty string parentId identically (root scope)', () => {
    const a = computeDedupHash({ parentId: null, title: 't', acceptance: 'a' });
    const b = computeDedupHash({ parentId: '', title: 't', acceptance: 'a' });
    expect(a).toBe(b);
  });

  it('changes when parent changes', () => {
    const a = computeDedupHash({ parentId: 'T100', title: 't', acceptance: 'a' });
    const b = computeDedupHash({ parentId: 'T200', title: 't', acceptance: 'a' });
    expect(a).not.toBe(b);
  });

  it('changes when title changes', () => {
    const a = computeDedupHash({ parentId: 'T1', title: 'one', acceptance: 'a' });
    const b = computeDedupHash({ parentId: 'T1', title: 'two', acceptance: 'a' });
    expect(a).not.toBe(b);
  });

  it('treats punctuation/whitespace variations as identical', () => {
    const a = computeDedupHash({
      parentId: 'T1',
      title: '[T2-BRAIN] Auth!',
      acceptance: 'fix it.',
    });
    const b = computeDedupHash({ parentId: 'T1', title: 't2 brain auth', acceptance: 'fix it' });
    expect(a).toBe(b);
  });
});

// ---------------------------------------------------------------------------
// checkDedupCollision
// ---------------------------------------------------------------------------

describe('checkDedupCollision', () => {
  it('returns isDuplicate=false when DB is null', () => {
    const r = checkDedupCollision({
      tasksDb: null,
      candidate: { parentId: null, title: 't', acceptance: 'a' },
    });
    expect(r.isDuplicate).toBe(false);
    expect(r.dedupHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('returns isDuplicate=false when no existing rows', () => {
    const db = createTasksDb();
    const r = checkDedupCollision({
      tasksDb: db,
      candidate: { parentId: null, title: 't', acceptance: 'a' },
    });
    expect(r.isDuplicate).toBe(false);
    db.close();
  });

  it('detects a same-hash + same-parent collision (root)', () => {
    const db = createTasksDb();
    const hash = computeDedupHash({
      parentId: null,
      title: '[T2-BRAIN] auth failures',
      acceptance: 'fix the thing',
    });
    insertExistingProposal(db, {
      id: 'T1544',
      parentId: null,
      title: '[T2-BRAIN] auth failures',
      rationale: 'fix the thing',
      dedupHash: hash,
    });

    const r = checkDedupCollision({
      tasksDb: db,
      candidate: {
        parentId: null,
        title: '[T2-BRAIN] auth failures',
        acceptance: 'fix the thing',
      },
    });
    expect(r.isDuplicate).toBe(true);
    expect(r.existingTaskId).toBe('T1544');
    expect(r.dedupHash).toBe(hash);
    db.close();
  });

  it('does NOT collide when parent differs (different parent → not deduped)', () => {
    const db = createTasksDb();
    const sharedTitle = '[T2-BRAIN] same title';
    const sharedRationale = 'same rationale';

    // Existing proposal under T100
    const hashUnderT100 = computeDedupHash({
      parentId: 'T100',
      title: sharedTitle,
      acceptance: sharedRationale,
    });
    insertExistingProposal(db, {
      id: 'T1544',
      parentId: 'T100',
      title: sharedTitle,
      rationale: sharedRationale,
      dedupHash: hashUnderT100,
    });

    // New proposal under T200 — same title/rationale, different parent
    const r = checkDedupCollision({
      tasksDb: db,
      candidate: {
        parentId: 'T200',
        title: sharedTitle,
        acceptance: sharedRationale,
      },
    });
    expect(r.isDuplicate).toBe(false);
    expect(r.dedupHash).not.toBe(hashUnderT100);
    db.close();
  });

  it('does NOT collide when the existing row is older than the window (>24h)', () => {
    const db = createTasksDb();
    const candidate = {
      parentId: null,
      title: '[T2-BRAIN] stale dup',
      acceptance: 'old',
    };
    const hash = computeDedupHash(candidate);

    // Insert with created_at 25h ago
    const stale = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
    insertExistingProposal(db, {
      id: 'T1500',
      parentId: null,
      title: candidate.title,
      rationale: candidate.acceptance,
      dedupHash: hash,
      createdAt: stale,
    });

    const r = checkDedupCollision({
      tasksDb: db,
      candidate,
      windowHours: DEFAULT_DEDUP_WINDOW_HOURS,
    });
    expect(r.isDuplicate).toBe(false);
    db.close();
  });

  it('DOES collide when within the window (<24h)', () => {
    const db = createTasksDb();
    const candidate = {
      parentId: null,
      title: '[T2-BRAIN] fresh dup',
      acceptance: 'recent',
    };
    const hash = computeDedupHash(candidate);

    const recent = new Date(Date.now() - 1 * 60 * 60 * 1000).toISOString();
    insertExistingProposal(db, {
      id: 'T1600',
      parentId: null,
      title: candidate.title,
      rationale: candidate.acceptance,
      dedupHash: hash,
      createdAt: recent,
    });

    const r = checkDedupCollision({ tasksDb: db, candidate });
    expect(r.isDuplicate).toBe(true);
    expect(r.existingTaskId).toBe('T1600');
    db.close();
  });

  it('reproduces the T1555 burst (4 distinct dups all rejected on second run)', () => {
    // First run: insert four distinct proposals (T1544..T1547) under root.
    const db = createTasksDb();
    const proposals = [
      { id: 'T1544', title: '[T2-BRAIN] auth failures', rationale: 'reason A' },
      { id: 'T1545', title: '[T2-NEXUS] over-coupled buildQuery', rationale: 'reason B' },
      { id: 'T1546', title: '[T2-TEST] flaky gate T100.testsPassed', rationale: 'reason C' },
      { id: 'T1547', title: '[T2-BRAIN] cited entry O-007', rationale: 'reason D' },
    ];

    for (const p of proposals) {
      const hash = computeDedupHash({
        parentId: null,
        title: p.title,
        acceptance: p.rationale,
      });
      insertExistingProposal(db, {
        id: p.id,
        parentId: null,
        title: p.title,
        rationale: p.rationale,
        dedupHash: hash,
      });
    }

    // Second run with identical candidates (the T1555 reproduction): every
    // candidate must be detected as a duplicate.
    let rejected = 0;
    const collisions: string[] = [];
    for (const p of proposals) {
      const r = checkDedupCollision({
        tasksDb: db,
        candidate: { parentId: null, title: p.title, acceptance: p.rationale },
      });
      if (r.isDuplicate) {
        rejected++;
        if (r.existingTaskId) collisions.push(r.existingTaskId);
      }
    }

    expect(rejected).toBe(4);
    expect(collisions).toEqual(['T1544', 'T1545', 'T1546', 'T1547']);
    db.close();
  });
});

// ---------------------------------------------------------------------------
// recordDedupRejection — audit log
// ---------------------------------------------------------------------------

describe('recordDedupRejection', () => {
  it('appends a single NDJSON line to .cleo/audit/sentient-dedup.jsonl', async () => {
    await recordDedupRejection({
      projectRoot: tmpRoot,
      parentId: null,
      title: '[T2-BRAIN] auth failures',
      source: 'brain',
      sourceId: 'O-001',
      dedupHash: 'a'.repeat(64),
      existingTaskId: 'T1544',
    });

    const auditPath = join(tmpRoot, SENTIENT_DEDUP_AUDIT_FILE);
    const lines = readFileSync(auditPath, 'utf-8').trim().split('\n');
    expect(lines).toHaveLength(1);

    const record = JSON.parse(lines[0] as string) as DedupRejectionRecord;
    expect(record.reason).toBe('per-parent-dedup');
    expect(record.dedupHash).toBe('a'.repeat(64));
    expect(record.parentId).toBeNull();
    expect(record.title).toBe('[T2-BRAIN] auth failures');
    expect(record.source).toBe('brain');
    expect(record.sourceId).toBe('O-001');
    expect(record.existingTaskId).toBe('T1544');
    expect(record.windowHours).toBe(DEFAULT_DEDUP_WINDOW_HOURS);
    expect(record.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('creates the audit directory if it does not exist', async () => {
    // tmpRoot is a fresh dir — `.cleo/audit/` does not exist yet.
    await recordDedupRejection({
      projectRoot: tmpRoot,
      parentId: 'T100',
      title: 'x',
      source: 'nexus',
      sourceId: 'N-1',
      dedupHash: 'b'.repeat(64),
      existingTaskId: 'T999',
    });
    const auditPath = join(tmpRoot, SENTIENT_DEDUP_AUDIT_FILE);
    expect(readFileSync(auditPath, 'utf-8')).toContain('"reason":"per-parent-dedup"');
  });

  it('appends rather than overwriting on repeated rejections', async () => {
    for (let i = 0; i < 4; i++) {
      await recordDedupRejection({
        projectRoot: tmpRoot,
        parentId: null,
        title: `dup-${i}`,
        source: 'brain',
        sourceId: `O-${i}`,
        dedupHash: String(i).repeat(64).slice(0, 64),
        existingTaskId: `T${1544 + i}`,
      });
    }
    const auditPath = join(tmpRoot, SENTIENT_DEDUP_AUDIT_FILE);
    const lines = readFileSync(auditPath, 'utf-8').trim().split('\n');
    expect(lines).toHaveLength(4);
    for (const line of lines) {
      const rec = JSON.parse(line) as DedupRejectionRecord;
      expect(rec.reason).toBe('per-parent-dedup');
    }
  });
});
