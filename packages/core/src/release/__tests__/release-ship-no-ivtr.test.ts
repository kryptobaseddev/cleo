/**
 * Regression tests for T9537 — IVTR decoupling from the release pipeline.
 *
 * Verifies that:
 *   1. `releaseShip` succeeds when epic child tasks have NO `ivtr_state` row
 *      (the legacy E_IVTR_INCOMPLETE blocker is gone — ADR-051 evidence atoms
 *      via `runReleaseGates` are the sole gate).
 *   2. `releaseShip` succeeds even when tasks would have been "blocked" under
 *      the pre-T9537 IVTR gate (currentPhase !== 'released'): IVTR state is
 *      observation-only.
 *   3. On first invocation per project, a sentinel file
 *      `.cleo/audit/ivtr-decoupled.flag` and a JSONL audit row are written;
 *      subsequent invocations are no-ops.
 *   4. The `writeIvtrDecouplingAuditOnce` helper is safe to call on a
 *      read-only or missing directory (never throws, returns false).
 *
 * @task T9537 — Phase 5 / 1 of 3 of T9498
 * @adr ADR-051 (evidence atoms are sole gate surface)
 * @spec SPEC-T9345 §7 (R-310 through R-316)
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Task } from '@cleocode/contracts';
import {
  createSqliteDataAccessor,
  IVTR_DECOUPLED_AUDIT_FILE,
  IVTR_DECOUPLED_SENTINEL_FILE,
  releaseShip,
  resetDbState,
  writeIvtrDecouplingAuditOnce,
} from '@cleocode/core/internal';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { seedTasks } from '../../store/__tests__/test-db-helper.js';

// Hoist mocks before module loads.
vi.mock('../changelog-writer.js', () => ({
  writeChangelogSection: vi.fn().mockResolvedValue(undefined),
  parseChangelogBlocks: vi.fn().mockReturnValue({ customBlocks: [], strippedContent: '' }),
}));

vi.mock('../guards.js', () => ({
  checkEpicCompleteness: vi
    .fn()
    .mockResolvedValue({ hasIncomplete: false, epics: [], orphanTasks: [] }),
  checkDoubleListing: vi.fn().mockReturnValue({ hasDoubleListing: false, duplicates: [] }),
}));

vi.mock('../release-manifest.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@cleocode/core/internal')>();
  return {
    ...actual,
    runReleaseGates: vi.fn(),
    showManifestRelease: vi.fn(),
    generateReleaseChangelog: vi.fn(),
    listManifestReleases: vi.fn(),
    markReleasePushed: vi.fn(),
  };
});

let TEST_ROOT: string;
let CLEO_DIR: string;

function writeConfig(config: Record<string, unknown>): void {
  mkdirSync(CLEO_DIR, { recursive: true });
  writeFileSync(join(CLEO_DIR, 'config.json'), JSON.stringify(config, null, 2), 'utf-8');
}

/**
 * Sample epic + child task fixture where the child has NO IVTR state. Under
 * the pre-T9537 gate this would have surfaced as "unchecked" (non-blocking)
 * but the gate also tripped on `blocked` tasks. We seed the child with
 * `status: 'done'` so the pipeline gate-runner sees no incomplete work, then
 * leave `ivtrState` undefined so `getIvtrState` returns null.
 */
const SAMPLE_TASKS: Array<Partial<Task> & { id: string }> = [
  {
    id: 'T-EPIC-NOIVTR',
    type: 'epic',
    title: 'Test epic — no IVTR state on children',
    status: 'done',
    priority: 'medium',
    createdAt: '2026-01-01T00:00:00Z',
    completedAt: '2026-02-01T00:00:00Z',
  },
  {
    id: 'T-CHILD-NOIVTR-A',
    parentId: 'T-EPIC-NOIVTR',
    title: 'feat: child A with no IVTR row',
    status: 'done',
    priority: 'medium',
    createdAt: '2026-01-01T00:00:00Z',
    completedAt: '2026-02-01T00:00:00Z',
  },
  {
    id: 'T-CHILD-NOIVTR-B',
    parentId: 'T-EPIC-NOIVTR',
    title: 'fix: child B with no IVTR row',
    status: 'done',
    priority: 'medium',
    createdAt: '2026-01-01T00:00:00Z',
    completedAt: '2026-02-01T00:00:00Z',
  },
];

async function setupTestDb(): Promise<void> {
  resetDbState();
  const accessor = await createSqliteDataAccessor(TEST_ROOT);
  await seedTasks(accessor, SAMPLE_TASKS);
  await accessor.close();
  resetDbState();
}

describe('releaseShip — IVTR decoupling (T9537)', () => {
  beforeEach(async () => {
    TEST_ROOT = mkdtempSync(join(tmpdir(), 'cleo-release-no-ivtr-'));
    CLEO_DIR = join(TEST_ROOT, '.cleo');
    await setupTestDb();
    writeConfig({ release: { push: { enabled: true, requireCleanTree: false } } });
    const manifest = await import('@cleocode/core/internal');
    vi.mocked(manifest.runReleaseGates).mockResolvedValue({
      version: '2026.5.99',
      allPassed: true,
      gates: [],
      passedCount: 0,
      failedCount: 0,
      metadata: {
        channel: 'latest',
        requiresPR: false,
        targetBranch: 'main',
        currentBranch: 'main',
      },
    });
    vi.mocked(manifest.showManifestRelease).mockResolvedValue({
      tasks: ['T-CHILD-NOIVTR-A', 'T-CHILD-NOIVTR-B'],
      version: 'v2026.5.99',
    } as never);
    vi.mocked(manifest.generateReleaseChangelog).mockResolvedValue({
      changelog: '### Features\n- feat: child A with no IVTR row (T-CHILD-NOIVTR-A)\n',
      taskCount: 2,
    } as never);
    vi.mocked(manifest.listManifestReleases).mockResolvedValue({ releases: [] } as never);
    vi.mocked(manifest.markReleasePushed).mockResolvedValue(undefined);
  });

  afterEach(() => {
    resetDbState();
    rmSync(TEST_ROOT, { recursive: true, force: true });
  });

  it('succeeds when ALL child tasks have no ivtr_state row (was E_IVTR_INCOMPLETE pre-T9537)', async () => {
    const result = await releaseShip(
      { version: '2026.5.99', epicId: 'T-EPIC-NOIVTR', dryRun: true },
      TEST_ROOT,
    );

    // Pre-T9537 this would have failed with E_LIFECYCLE_GATE_FAILED for any
    // task whose IVTR phase wasn't 'released'. Post-T9537 the IVTR gate is
    // gone; the only ADR-051 gate is the mocked-pass `runReleaseGates`.
    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    expect(data.dryRun).toBe(true);
    expect(data.epicId).toBe('T-EPIC-NOIVTR');
  });

  it('does NOT include any "Check IVTR gate" or E_IVTR_INCOMPLETE step in the release log', async () => {
    const result = await releaseShip(
      { version: '2026.5.99', epicId: 'T-EPIC-NOIVTR', dryRun: true },
      TEST_ROOT,
    );

    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    const steps =
      (data.steps as string[] | undefined) ?? (data.wouldDo as string[] | undefined) ?? [];
    for (const step of steps) {
      expect(step).not.toMatch(/Check IVTR gate/i);
      expect(step).not.toMatch(/IVTR gate (?:rejected|FAILED|BYPASSED)/i);
    }
    if (result.error) {
      expect(result.error.code).not.toBe('E_IVTR_INCOMPLETE');
    }
  });

  it('writes the IVTR-decoupled sentinel + JSONL audit row on first run (and only first)', async () => {
    const sentinelPath = join(TEST_ROOT, IVTR_DECOUPLED_SENTINEL_FILE);
    const auditPath = join(TEST_ROOT, IVTR_DECOUPLED_AUDIT_FILE);

    expect(existsSync(sentinelPath)).toBe(false);

    const first = await releaseShip(
      { version: '2026.5.99', epicId: 'T-EPIC-NOIVTR', dryRun: true },
      TEST_ROOT,
    );
    expect(first.success).toBe(true);
    expect(existsSync(sentinelPath)).toBe(true);
    expect(existsSync(auditPath)).toBe(true);
    const auditFirst = readFileSync(auditPath, 'utf-8').trim().split('\n');
    expect(auditFirst).toHaveLength(1);
    const parsedFirst = JSON.parse(auditFirst[0] ?? '{}') as Record<string, unknown>;
    expect(parsedFirst.event).toBe('ivtr-decoupled');
    expect(parsedFirst.task).toBe('T9537');
    expect(parsedFirst.firstEpic).toBe('T-EPIC-NOIVTR');

    // Second run must not re-append.
    const second = await releaseShip(
      { version: '2026.5.99', epicId: 'T-EPIC-NOIVTR', dryRun: true },
      TEST_ROOT,
    );
    expect(second.success).toBe(true);
    const auditSecond = readFileSync(auditPath, 'utf-8').trim().split('\n');
    expect(auditSecond).toHaveLength(1);
  });
});

describe('writeIvtrDecouplingAuditOnce — unit', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cleo-ivtr-audit-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('returns true on first call and false on subsequent calls (idempotent sentinel)', () => {
    expect(writeIvtrDecouplingAuditOnce(root, 'T-EPIC-1')).toBe(true);
    expect(writeIvtrDecouplingAuditOnce(root, 'T-EPIC-1')).toBe(false);
    expect(writeIvtrDecouplingAuditOnce(root, 'T-EPIC-2')).toBe(false);
  });

  it('writes a JSON payload pointing to T9537 and SPEC-T9345 §7', () => {
    expect(writeIvtrDecouplingAuditOnce(root, 'T-EPIC-X')).toBe(true);
    const sentinelPath = join(root, IVTR_DECOUPLED_SENTINEL_FILE);
    const payload = JSON.parse(readFileSync(sentinelPath, 'utf-8')) as Record<string, unknown>;
    expect(payload.event).toBe('ivtr-decoupled');
    expect(payload.task).toBe('T9537');
    expect(typeof payload.spec).toBe('string');
    expect(payload.firstEpic).toBe('T-EPIC-X');
  });

  it('never throws on filesystem failure — returns false', () => {
    // Pass a path containing a NUL byte — Node refuses to operate on it and
    // throws ERR_INVALID_ARG_VALUE deterministically on every platform. The
    // helper must swallow this and return false rather than crashing the
    // release.
    expect(() => writeIvtrDecouplingAuditOnce('/tmp/cleo-bad\0path', 'T-EPIC-Z')).not.toThrow();
    expect(writeIvtrDecouplingAuditOnce('/tmp/cleo-bad\0path', 'T-EPIC-Z')).toBe(false);
  });
});
