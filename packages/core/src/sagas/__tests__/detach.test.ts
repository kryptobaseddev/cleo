/**
 * Tests for {@link detachSagaMember} — the repair verb that clears the
 * `parentId` containment edge between a saga and a member Epic.
 *
 * The function is idempotent — re-running against an already-detached
 * member succeeds with `removed: false` — and always appends a JSON line
 * to `.cleo/audit/saga-detach.jsonl`.
 *
 * @task T10118
 * @saga T10113
 * @epic T10209
 * @see ADR-073-above-epic-naming.md §1.2 invariant I7
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createTask } from '@cleocode/core/internal';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestDb, type TestDbEnv } from '../../store/__tests__/test-db-helper.js';
import { detachSagaMember, SAGA_DETACH_AUDIT_FILE, SAGA_DETACH_DEFAULT_REASON } from '../detach.js';

let TEST_ROOT: string;
let env: TestDbEnv;

/**
 * Seed one saga (T9100) + two member epics (T9201, T9202).
 */
async function seedFixture(testRoot: string): Promise<void> {
  const ts = '2026-05-22T00:00:00Z';
  const rows = [
    {
      id: 'T9100',
      title: 'Saga',
      description: 'Saga with two members',
      type: 'saga' as const,
      status: 'active' as const,
      priority: 'high' as const,
      createdAt: ts,
      updatedAt: null,
    },
    {
      id: 'T9201',
      title: 'Epic One',
      description: 'Member one',
      type: 'epic' as const,
      status: 'active' as const,
      priority: 'medium' as const,
      parentId: 'T9100',
      createdAt: ts,
      updatedAt: null,
    },
    {
      id: 'T9202',
      title: 'Epic Two',
      description: 'Member two',
      type: 'epic' as const,
      status: 'active' as const,
      priority: 'medium' as const,
      parentId: 'T9100',
      createdAt: ts,
      updatedAt: null,
    },
  ];
  for (const row of rows) {
    await createTask(row as Parameters<typeof createTask>[0], testRoot);
  }
}

interface SagaDetachAuditLine {
  timestamp: string;
  sagaId: string;
  memberId: string;
  removed: boolean;
  reason: string;
}

/** Read every JSON line currently present in the saga-detach audit log. */
function readAuditLines(testRoot: string): SagaDetachAuditLine[] {
  const file = join(testRoot, SAGA_DETACH_AUDIT_FILE);
  if (!existsSync(file)) {
    return [];
  }
  return readFileSync(file, 'utf-8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as SagaDetachAuditLine);
}

beforeEach(async () => {
  env = await createTestDb();
  TEST_ROOT = env.tempDir;
  await seedFixture(TEST_ROOT);
});

afterEach(async () => {
  try {
    const { closeAllDatabases } = await import('@cleocode/core/internal');
    await closeAllDatabases();
  } catch {
    // ignore cleanup errors
  }
  await env.cleanup();
});

describe('detachSagaMember — parent_id detach + audit log', () => {
  it('clears a member parentId on first call (removed: true)', async () => {
    const result = await detachSagaMember(TEST_ROOT, { sagaId: 'T9100', memberId: 'T9201' });
    expect(result.success, JSON.stringify(result)).toBe(true);
    if (!result.success) return;
    expect(result.data?.removed).toBe(true);
    expect(result.data?.sagaId).toBe('T9100');
    expect(result.data?.memberId).toBe('T9201');
    expect(result.data?.reason).toBe(SAGA_DETACH_DEFAULT_REASON);
    expect(typeof result.data?.timestamp).toBe('string');

    const { taskShow } = await import('../../tasks/show.js');
    const detached = await taskShow(TEST_ROOT, 'T9201');
    const remaining = await taskShow(TEST_ROOT, 'T9202');
    expect(detached.data?.task.parentId ?? null).toBeNull();
    expect(remaining.data?.task.parentId).toBe('T9100');
  });

  it('is idempotent — re-running returns removed=false without error', async () => {
    const first = await detachSagaMember(TEST_ROOT, { sagaId: 'T9100', memberId: 'T9201' });
    expect(first.success).toBe(true);
    if (first.success) expect(first.data?.removed).toBe(true);

    const second = await detachSagaMember(TEST_ROOT, { sagaId: 'T9100', memberId: 'T9201' });
    expect(second.success, JSON.stringify(second)).toBe(true);
    if (!second.success) return;
    expect(second.data?.removed).toBe(false);
    expect(second.data?.sagaId).toBe('T9100');
    expect(second.data?.memberId).toBe('T9201');
  });

  it('appends a JSON-line entry to .cleo/audit/saga-detach.jsonl per invocation', async () => {
    await detachSagaMember(TEST_ROOT, { sagaId: 'T9100', memberId: 'T9201' });
    await detachSagaMember(TEST_ROOT, { sagaId: 'T9100', memberId: 'T9201' });

    const lines = readAuditLines(TEST_ROOT);
    expect(lines).toHaveLength(2);
    expect(lines[0]?.sagaId).toBe('T9100');
    expect(lines[0]?.memberId).toBe('T9201');
    expect(lines[0]?.removed).toBe(true);
    expect(lines[0]?.reason).toBe(SAGA_DETACH_DEFAULT_REASON);
    expect(lines[1]?.removed).toBe(false);
  });

  it('records a caller-supplied reason in the audit log entry', async () => {
    const customReason = 'manual repair for T9831/T9799 nesting';
    const result = await detachSagaMember(TEST_ROOT, {
      sagaId: 'T9100',
      memberId: 'T9202',
      reason: customReason,
    });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data?.reason).toBe(customReason);

    const lines = readAuditLines(TEST_ROOT);
    expect(lines).toHaveLength(1);
    expect(lines[0]?.reason).toBe(customReason);
  });

  it('rejects missing sagaId or memberId with E_INVALID_INPUT', async () => {
    const a = await detachSagaMember(TEST_ROOT, { sagaId: '', memberId: 'T9201' });
    expect(a.success).toBe(false);
    if (!a.success) expect(a.error?.code).toBe('E_INVALID_INPUT');

    const b = await detachSagaMember(TEST_ROOT, { sagaId: 'T9100', memberId: '' });
    expect(b.success).toBe(false);
    if (!b.success) expect(b.error?.code).toBe('E_INVALID_INPUT');
  });
});
