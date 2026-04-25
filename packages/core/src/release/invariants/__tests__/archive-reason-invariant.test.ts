/**
 * Tests for the archive-reason post-release invariant + the registry
 * plumbing it relies on.
 *
 * Strategy:
 *   - Stub the git plumbing by overriding `process.env` is NOT enough — the
 *     invariant calls `execFileSync('git', …)` directly. Instead we drive
 *     the invariant via a tiny in-process registry of two replacement
 *     invariants whose `check` functions exercise the public surface
 *     (registerInvariant / getInvariants / runInvariants) without any git
 *     state, plus we exercise the production archive-reason invariant with
 *     a mocked task DB whose tag/commit corpus is injected via a custom
 *     `git` shim placed first on PATH.
 *
 *   - For DB writes we use `createTestDb()` which creates an isolated
 *     temp project root with its own `.cleo/tasks.db`.
 *
 * @task T1411
 * @epic T1407
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ARCHIVE_REASON_TOMBSTONE_ENV,
  ArchiveReasonTombstoneError,
  assertArchiveReason,
} from '@cleocode/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestDb, type TestDbEnv } from '../../../store/__tests__/test-db-helper.js';
import {
  ARCHIVE_REASON_INVARIANT_ID,
  extractTaskIds,
  RECONCILE_AUDIT_FILE,
  registerArchiveReasonInvariant,
} from '../archive-reason-invariant.js';
import { clearInvariants, getInvariants, registerInvariant, runInvariants } from '../registry.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Create a tiny git repository at `repoRoot` and return its absolute path.
 *
 * The repo seeded with:
 *  - one initial commit
 *  - one or more "release" commits whose messages cite `taskIds`
 *  - an annotated tag pointing at the most recent commit
 */
function seedGitRepo(args: {
  repoRoot: string;
  initialCommitMsg: string;
  releaseCommits: string[];
  tag: string;
  tagAnnotation?: string;
}): void {
  const { repoRoot, initialCommitMsg, releaseCommits, tag, tagAnnotation } = args;
  const run = (cmd: string[]): string =>
    execFileSync('git', cmd, {
      cwd: repoRoot,
      encoding: 'utf-8',
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 'Test',
        GIT_AUTHOR_EMAIL: 'test@example.invalid',
        GIT_COMMITTER_NAME: 'Test',
        GIT_COMMITTER_EMAIL: 'test@example.invalid',
      },
    });

  run(['init', '--quiet', '--initial-branch=main']);
  // Seed an empty initial commit (allows --allow-empty).
  run(['commit', '--quiet', '--allow-empty', '-m', initialCommitMsg]);

  for (const msg of releaseCommits) {
    run(['commit', '--quiet', '--allow-empty', '-m', msg]);
  }

  // Annotated tag (matters because the invariant reads `tag -l --format='%(contents)'`).
  run(['tag', '-a', tag, '-m', tagAnnotation ?? `Release ${tag}`]);
}

// ---------------------------------------------------------------------------
// Registry tests
// ---------------------------------------------------------------------------

describe('release.invariants registry', () => {
  beforeEach(() => {
    clearInvariants();
  });

  it('registers and lists invariants in insertion order', () => {
    registerInvariant({
      id: 'first',
      description: 'first invariant',
      severity: 'info',
      check: async () => ({
        id: 'first',
        severity: 'info',
        message: 'ok',
        processed: 1,
        reconciled: 1,
        unreconciled: 0,
        errors: 0,
      }),
    });
    registerInvariant({
      id: 'second',
      description: 'second invariant',
      severity: 'warning',
      check: async () => ({
        id: 'second',
        severity: 'warning',
        message: 'meh',
        processed: 0,
        reconciled: 0,
        unreconciled: 1,
        errors: 0,
      }),
    });

    const list = getInvariants();
    expect(list.map((i) => i.id)).toEqual(['first', 'second']);
  });

  it('aggregates per-invariant counts in runInvariants()', async () => {
    registerInvariant({
      id: 'a',
      description: 'a',
      severity: 'info',
      check: async () => ({
        id: 'a',
        severity: 'info',
        message: 'a-ok',
        processed: 3,
        reconciled: 2,
        unreconciled: 1,
        errors: 0,
      }),
    });
    registerInvariant({
      id: 'b',
      description: 'b',
      severity: 'info',
      check: async () => ({
        id: 'b',
        severity: 'info',
        message: 'b-ok',
        processed: 4,
        reconciled: 4,
        unreconciled: 0,
        errors: 0,
      }),
    });

    const report = await runInvariants('vTEST', { dryRun: true });
    expect(report.processed).toBe(7);
    expect(report.reconciled).toBe(6);
    expect(report.unreconciled).toBe(1);
    expect(report.errors).toBe(0);
    expect(report.results).toHaveLength(2);
  });

  it('captures thrown errors as a result with severity=error', async () => {
    registerInvariant({
      id: 'boom',
      description: 'always throws',
      severity: 'error',
      check: async () => {
        throw new Error('synthetic failure');
      },
    });

    const report = await runInvariants('vTEST', { dryRun: true });
    expect(report.errors).toBe(1);
    expect(report.results[0]?.severity).toBe('error');
    expect(report.results[0]?.message).toContain('synthetic failure');
  });
});

// ---------------------------------------------------------------------------
// extractTaskIds — pure function tests
// ---------------------------------------------------------------------------

describe('extractTaskIds', () => {
  it('extracts unique task IDs in first-occurrence order', () => {
    const corpus = 'feat(T1411): registry\n\nRefs: T1407, T1410, T1411\n\nT1407 again';
    expect(extractTaskIds(corpus)).toEqual(['T1411', 'T1407', 'T1410']);
  });

  it('does NOT match T-prefixed dashed identifiers', () => {
    const corpus = 'see T-RECONCILE-FOLLOWUP-v1-0 and T-ARCHIVE-FIX';
    expect(extractTaskIds(corpus)).toEqual([]);
  });

  it('returns empty array on empty corpus', () => {
    expect(extractTaskIds('')).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Tombstone gate (contract-level enforcement) — written via the contract
// helper so we stay decoupled from the SQLite CHECK constraint.
// ---------------------------------------------------------------------------

describe('archive-reason invariant tombstone protection', () => {
  it('rejects completed-unverified writes from non-migration code paths', () => {
    // Ensure the tombstone-allow env var is NOT set (default operating mode).
    const previous = process.env[ARCHIVE_REASON_TOMBSTONE_ENV];
    delete process.env[ARCHIVE_REASON_TOMBSTONE_ENV];
    try {
      expect(() => assertArchiveReason('completed-unverified', 'T9999')).toThrow(
        ArchiveReasonTombstoneError,
      );
    } finally {
      if (previous !== undefined) process.env[ARCHIVE_REASON_TOMBSTONE_ENV] = previous;
    }
  });

  it("permits 'verified' (the value the invariant actually writes)", () => {
    expect(assertArchiveReason('verified', 'T9999')).toBe('verified');
  });
});

// ---------------------------------------------------------------------------
// End-to-end invariant tests against a real git repo + tasks.db
// ---------------------------------------------------------------------------

describe('archive-reason invariant — end-to-end', () => {
  let env: TestDbEnv;
  let workspace: string; // contains both git repo and .cleo/tasks.db

  beforeEach(async () => {
    clearInvariants();
    registerArchiveReasonInvariant();

    // Build a workspace where the git repo root === project root === cwd.
    workspace = mkdtempSync(join(tmpdir(), 'cleo-reconcile-'));

    // Create the .cleo directory + config.json BEFORE initializing the
    // SQLite accessor (the test helper does this in a separate temp dir,
    // so we instead set things up inline so git + tasks.db share one root).
    const cleoDir = join(workspace, '.cleo');
    mkdirSync(cleoDir, { recursive: true });
    writeFileSync(
      join(cleoDir, 'config.json'),
      JSON.stringify({
        enforcement: {
          session: { requiredForMutate: false },
          acceptance: { mode: 'off' },
        },
        lifecycle: { mode: 'off' },
        verification: { enabled: false },
      }),
    );

    // Reuse the test helper's accessor wiring.
    env = await createTestDb();
    // Switch the accessor to our workspace path so the invariant resolves
    // the same DB by passing `cwd: workspace` at run time.
    // (createTestDb gives us an accessor against its own tempDir; we need
    // the accessor to be opened against `workspace`. Easiest path: close
    // the helper's accessor + re-open on `workspace`.)
    await env.cleanup();
    const { resetDbState } = await import('../../../store/sqlite.js');
    resetDbState();

    const { createSqliteDataAccessor } = await import('../../../store/sqlite-data-accessor.js');
    env = {
      tempDir: workspace,
      cleoDir,
      accessor: await createSqliteDataAccessor(workspace),
      cleanup: async () => {
        await env.accessor.close();
        resetDbState();
        rmSync(workspace, { recursive: true, force: true });
      },
    };
  });

  afterEach(async () => {
    await env.cleanup();
  });

  it('reconciles a verified pending task and writes one audit row', async () => {
    // Seed a verified-pending task in the DB.
    const now = new Date().toISOString();
    await env.accessor.upsertSingleTask({
      id: 'T8001',
      title: 'Verified work shipped in v0',
      description: 'Verified work shipped in the test release',
      status: 'pending',
      priority: 'medium',
      createdAt: now,
      verification: {
        passed: true,
        round: 1,
        gates: { implemented: true, testsPassed: true },
        lastAgent: null,
        lastUpdated: now,
        failureLog: [],
      },
    });

    // Seed a git repo whose tag references T8001.
    seedGitRepo({
      repoRoot: workspace,
      initialCommitMsg: 'chore: init',
      releaseCommits: ['feat(T8001): ship verified thing\n\nRefs: T8001'],
      tag: 'v-test-1',
    });

    const report = await runInvariants('v-test-1', { dryRun: false, cwd: workspace });
    expect(report.errors).toBe(0);
    expect(report.reconciled).toBe(1);
    expect(report.unreconciled).toBe(0);
    expect(report.results[0]?.id).toBe(ARCHIVE_REASON_INVARIANT_ID);

    // DB side-effect — task is now archived as 'verified'.
    // (The invariant first stamps status='done' then calls archiveSingleTask
    // which transitions status='archived' inside the same transaction.)
    const task = await env.accessor.loadSingleTask('T8001');
    expect(task?.status).toBe('archived');

    // Audit log written exactly once for this task.
    const auditPath = join(workspace, RECONCILE_AUDIT_FILE);
    expect(existsSync(auditPath)).toBe(true);
    const auditLines = readFileSync(auditPath, 'utf-8').trim().split('\n');
    const reconciledRows = auditLines
      .map((l) => JSON.parse(l) as { taskId: string; action: string; reason?: string })
      .filter((r) => r.taskId === 'T8001' && r.action === 'reconciled');
    expect(reconciledRows).toHaveLength(1);
    expect(reconciledRows[0]?.reason).toBe('verified');
  });

  it('creates a follow-up task for an unverified pending task', async () => {
    const now = new Date().toISOString();
    await env.accessor.upsertSingleTask({
      id: 'T8002',
      title: 'Unverified work',
      description: 'Pending task with no verification gates set',
      status: 'pending',
      priority: 'medium',
      createdAt: now,
    });

    seedGitRepo({
      repoRoot: workspace,
      initialCommitMsg: 'chore: init',
      releaseCommits: ['feat(T8002): no gates\n\nRefs: T8002'],
      tag: 'v-test-2',
    });

    const report = await runInvariants('v-test-2', { dryRun: false, cwd: workspace });
    expect(report.errors).toBe(0);
    expect(report.reconciled).toBe(0);
    expect(report.unreconciled).toBe(1);

    // Original task is still pending — invariant did NOT touch it.
    const original = await env.accessor.loadSingleTask('T8002');
    expect(original?.status).toBe('pending');

    // Follow-up task was created.
    const followUp = await env.accessor.loadSingleTask('T-RECONCILE-FOLLOWUP-v-test-2-0');
    expect(followUp).not.toBeNull();
    expect(followUp?.status).toBe('pending');
    expect(followUp?.relates?.[0]?.taskId).toBe('T8002');

    // Audit log records exactly one followup-created row for T8002.
    const auditPath = join(workspace, RECONCILE_AUDIT_FILE);
    const rows = readFileSync(auditPath, 'utf-8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as { taskId: string; action: string });
    expect(
      rows.filter((r) => r.taskId === 'T8002' && r.action === 'followup-created'),
    ).toHaveLength(1);
  });

  it('is a no-op when the tag has no T-IDs in commits or annotation', async () => {
    seedGitRepo({
      repoRoot: workspace,
      initialCommitMsg: 'chore: init',
      releaseCommits: ['chore: misc cleanup'],
      tag: 'v-test-noref',
      tagAnnotation: 'no task references here',
    });

    const report = await runInvariants('v-test-noref', { dryRun: false, cwd: workspace });
    expect(report.processed).toBe(0);
    expect(report.reconciled).toBe(0);
    expect(report.unreconciled).toBe(0);
    expect(report.errors).toBe(0);

    // Audit log should NOT have been created (no mutations).
    const auditPath = join(workspace, RECONCILE_AUDIT_FILE);
    expect(existsSync(auditPath)).toBe(false);
  });

  it('dry-run reports findings but does not mutate the DB or audit log', async () => {
    const now = new Date().toISOString();
    await env.accessor.upsertSingleTask({
      id: 'T8003',
      title: 'Verified work (dry-run case)',
      description: 'Pending task that would be reconciled if not for --dry-run',
      status: 'pending',
      priority: 'medium',
      createdAt: now,
      verification: {
        passed: true,
        round: 1,
        gates: { implemented: true },
        lastAgent: null,
        lastUpdated: now,
        failureLog: [],
      },
    });

    seedGitRepo({
      repoRoot: workspace,
      initialCommitMsg: 'chore: init',
      releaseCommits: ['feat(T8003): would-reconcile\n\nRefs: T8003'],
      tag: 'v-test-dry',
    });

    const report = await runInvariants('v-test-dry', { dryRun: true, cwd: workspace });
    expect(report.reconciled).toBe(1);
    expect(report.errors).toBe(0);

    // DB state is unchanged.
    const task = await env.accessor.loadSingleTask('T8003');
    expect(task?.status).toBe('pending');

    // Audit log is NOT written on dry run (no mutations).
    // Implementation note: the invariant currently writes audit rows ONLY
    // when it performs a mutation. On dry-run no mutation runs, so no row
    // is appended.
    const auditPath = join(workspace, RECONCILE_AUDIT_FILE);
    if (existsSync(auditPath)) {
      const lines = readFileSync(auditPath, 'utf-8').trim();
      expect(lines).toBe('');
    }
  });
});
