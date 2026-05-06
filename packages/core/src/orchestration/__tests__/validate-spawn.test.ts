/**
 * Tests for {@link validateSpawnReadiness}.
 *
 * Verifies:
 *  - Worker role + no files → V_ATOMIC_SCOPE_MISSING error (T894)
 *  - Worker role + > MAX_WORKER_FILES → V_ATOMIC_SCOPE_TOO_LARGE error (T894)
 *  - Worker role + ≤ MAX_WORKER_FILES → valid (no atomic error) (T894)
 *  - Orchestrator role bypasses the file-scope gate (T894)
 *  - Lead role bypasses the file-scope gate (T894)
 *  - Epic type bypasses the file-scope gate regardless of role (T894)
 *  - Existing checks (V_MISSING_DESC, V_ALREADY_DONE, etc.) still work
 *  - Agent pre-flight skips gracefully when DB unavailable (T1933)
 *  - Agent pre-flight emits V_AGENT_NOT_FOUND only when all 5 tiers miss (T1933)
 *  - Agent pre-flight passes when fallback/universal tier resolves the agent (T1933)
 *
 * Uses an in-memory fake DataAccessor to keep the tests fast and hermetic.
 *
 * @task T894 Atomic task enforcement
 * @task T1933 Resolver fallback path + universal-tier pre-flight (ADR-068 D6)
 * @epic T889 / T1929
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Task } from '@cleocode/contracts';
import { describe, expect, it } from 'vitest';
import type { DataAccessor } from '../../store/data-accessor.js';
import { MAX_WORKER_FILES } from '../atomicity.js';
import { validateSpawnReadiness } from '../validate-spawn.js';

// ---------------------------------------------------------------------------
// Minimal in-memory accessor stub
// ---------------------------------------------------------------------------

function makeAccessor(tasks: Task[]): DataAccessor {
  const map = new Map(tasks.map((t) => [t.id, t]));
  return {
    loadSingleTask: async (id: string) => map.get(id) ?? null,
    loadTasks: async (ids: string[]) => ids.flatMap((id) => (map.get(id) ? [map.get(id)!] : [])),
    queryTasks: async () => ({ tasks: [...map.values()], total: map.size }),
    getChildren: async () => [],
  } as unknown as DataAccessor;
}

// ---------------------------------------------------------------------------
// Base task fixtures
// ---------------------------------------------------------------------------

function baseTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'T9801',
    title: 'Validate-spawn test task',
    description: 'A test task for validate-spawn.',
    status: 'pending',
    priority: 'medium',
    type: 'task',
    size: 'small',
    createdAt: '2026-04-17T00:00:00Z',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Existing checks still work
// ---------------------------------------------------------------------------

describe('validateSpawnReadiness — existing checks (regression)', () => {
  it('returns V_NOT_FOUND when task is missing', async () => {
    const accessor = makeAccessor([]);
    const result = await validateSpawnReadiness('T9801', undefined, accessor);
    expect(result.ready).toBe(false);
    expect(result.issues.some((i) => i.code === 'V_NOT_FOUND')).toBe(true);
  });

  it('returns V_ALREADY_DONE for a completed task', async () => {
    const accessor = makeAccessor([baseTask({ status: 'done' })]);
    const result = await validateSpawnReadiness('T9801', undefined, accessor);
    expect(result.ready).toBe(false);
    expect(result.issues.some((i) => i.code === 'V_ALREADY_DONE')).toBe(true);
  });

  it('returns V_MISSING_DESC when description is missing', async () => {
    const accessor = makeAccessor([baseTask({ description: undefined })]);
    const result = await validateSpawnReadiness('T9801', undefined, accessor);
    expect(result.ready).toBe(false);
    expect(result.issues.some((i) => i.code === 'V_MISSING_DESC')).toBe(true);
  });

  it('is ready when task is valid and no role is supplied', async () => {
    const accessor = makeAccessor([baseTask()]);
    const result = await validateSpawnReadiness('T9801', undefined, accessor);
    expect(result.ready).toBe(true);
    expect(result.issues).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// T894: Atomic scope enforcement — worker role
// ---------------------------------------------------------------------------

describe('validateSpawnReadiness — T894 atomic scope (worker role)', () => {
  it('worker role + no files field → V_ATOMIC_SCOPE_MISSING', async () => {
    const accessor = makeAccessor([baseTask({ files: undefined })]);
    const result = await validateSpawnReadiness('T9801', undefined, accessor, {
      role: 'worker',
    });
    expect(result.ready).toBe(false);
    const issue = result.issues.find((i) => i.code === 'V_ATOMIC_SCOPE_MISSING');
    expect(issue).toBeDefined();
    expect(issue?.severity).toBe('error');
    expect(issue?.message).toContain('T9801');
  });

  it('worker role + empty files array → V_ATOMIC_SCOPE_MISSING', async () => {
    const accessor = makeAccessor([baseTask({ files: [] })]);
    const result = await validateSpawnReadiness('T9801', undefined, accessor, {
      role: 'worker',
    });
    expect(result.ready).toBe(false);
    expect(result.issues.some((i) => i.code === 'V_ATOMIC_SCOPE_MISSING')).toBe(true);
  });

  it(`worker role + ${MAX_WORKER_FILES + 1} files → V_ATOMIC_SCOPE_TOO_LARGE`, async () => {
    const tooManyFiles = Array.from(
      { length: MAX_WORKER_FILES + 1 },
      (_, i) => `packages/core/src/file-${i}.ts`,
    );
    const accessor = makeAccessor([baseTask({ files: tooManyFiles })]);
    const result = await validateSpawnReadiness('T9801', undefined, accessor, {
      role: 'worker',
    });
    expect(result.ready).toBe(false);
    const issue = result.issues.find((i) => i.code === 'V_ATOMIC_SCOPE_TOO_LARGE');
    expect(issue).toBeDefined();
    expect(issue?.severity).toBe('error');
    expect(issue?.message).toContain(String(tooManyFiles.length));
  });

  it(`worker role + exactly ${MAX_WORKER_FILES} files → valid`, async () => {
    const exactFiles = Array.from(
      { length: MAX_WORKER_FILES },
      (_, i) => `packages/core/src/file-${i}.ts`,
    );
    const accessor = makeAccessor([baseTask({ files: exactFiles })]);
    const result = await validateSpawnReadiness('T9801', undefined, accessor, {
      role: 'worker',
    });
    expect(result.ready).toBe(true);
    expect(result.issues.some((i) => i.code.startsWith('V_ATOMIC'))).toBe(false);
  });

  it('worker role + 1 file → valid', async () => {
    const accessor = makeAccessor([baseTask({ files: ['packages/core/src/foo.ts'] })]);
    const result = await validateSpawnReadiness('T9801', undefined, accessor, {
      role: 'worker',
    });
    expect(result.ready).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// T894: Role and type exemptions
// ---------------------------------------------------------------------------

describe('validateSpawnReadiness — T894 exemptions (orchestrator, lead, epic)', () => {
  it('orchestrator role with no files → valid (exempt)', async () => {
    const accessor = makeAccessor([baseTask({ files: undefined })]);
    const result = await validateSpawnReadiness('T9801', undefined, accessor, {
      role: 'orchestrator',
    });
    expect(result.issues.some((i) => i.code.startsWith('V_ATOMIC'))).toBe(false);
    expect(result.ready).toBe(true);
  });

  it('lead role with no files → valid (exempt)', async () => {
    const accessor = makeAccessor([baseTask({ files: undefined })]);
    const result = await validateSpawnReadiness('T9801', undefined, accessor, {
      role: 'lead',
    });
    expect(result.issues.some((i) => i.code.startsWith('V_ATOMIC'))).toBe(false);
    expect(result.ready).toBe(true);
  });

  it('epic type with worker role + no files → valid (epic is exempt)', async () => {
    const accessor = makeAccessor([baseTask({ type: 'epic', files: undefined })]);
    const result = await validateSpawnReadiness('T9801', undefined, accessor, {
      role: 'worker',
    });
    expect(result.issues.some((i) => i.code.startsWith('V_ATOMIC'))).toBe(false);
    expect(result.ready).toBe(true);
  });

  it('worker role + >3 files but epic type → valid (epic exempt)', async () => {
    const manyFiles = ['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts'];
    const accessor = makeAccessor([baseTask({ type: 'epic', files: manyFiles })]);
    const result = await validateSpawnReadiness('T9801', undefined, accessor, {
      role: 'worker',
    });
    expect(result.issues.some((i) => i.code === 'V_ATOMIC_SCOPE_TOO_LARGE')).toBe(false);
    expect(result.ready).toBe(true);
  });

  it('no role supplied → no V_ATOMIC checks run at all', async () => {
    // Without a role the caller has not yet resolved the spawn role — skip.
    const accessor = makeAccessor([baseTask({ files: undefined })]);
    const result = await validateSpawnReadiness('T9801', undefined, accessor);
    expect(result.issues.some((i) => i.code.startsWith('V_ATOMIC'))).toBe(false);
    expect(result.ready).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// T1933: Spawn validator pre-flight — agent-existence check (ADR-068 D6)
// ---------------------------------------------------------------------------

describe('validateSpawnReadiness — T1933 agent-existence pre-flight (ADR-068 D6)', () => {
  /**
   * When the global signaldock.db cannot be opened (common in unit tests that
   * have not initialised the global DB), the agent-existence check MUST be
   * skipped silently rather than blocking spawn.
   */
  it('skips agent-existence check gracefully when signaldock.db unavailable', async () => {
    // The makeAccessor stub does not initialise the global signaldock.db, so
    // openSignaldockDbForPreflight() will return null and the check is skipped.
    const accessor = makeAccessor([baseTask()]);
    const result = await validateSpawnReadiness('T9801', undefined, accessor);
    // Ready — no V_AGENT_NOT_FOUND emitted because DB was unavailable → skipped.
    expect(result.ready).toBe(true);
    expect(result.issues.some((i) => i.code === 'V_AGENT_NOT_FOUND')).toBe(false);
  });

  /**
   * When the universal base is unreachable AND the global DB is available,
   * the validator MUST emit V_AGENT_NOT_FOUND because all 5 tiers fail.
   * This test uses real SQLite (via DatabaseSync) with a tmp directory.
   */
  it('emits V_AGENT_NOT_FOUND when all 5 tiers miss (catastrophic state)', async () => {
    const { DatabaseSync } = await import('node:sqlite');
    const { ensureGlobalSignaldockDb: _ensure, _resetGlobalSignaldockDb_TESTING_ONLY: _reset } =
      await import('../../store/signaldock-sqlite.js');
    const { getCleoHome: _getCleoHome } = await import('../../paths.js');

    // Set up a minimal tmp environment with a real signaldock.db.
    const base = mkdtempSync(join(tmpdir(), 'cleo-vs-t1933-'));
    const cleoHome = join(base, 'cleo-home');
    const templatesDir = join(base, 'templates');
    const missingUniversalBase = join(base, 'no-such-cleo-subagent.cant');

    try {
      mkdirSync(cleoHome, { recursive: true });
      mkdirSync(templatesDir, { recursive: true });
      writeFileSync(join(cleoHome, 'machine-key'), Buffer.alloc(32, 0xab), { mode: 0o600 });
      writeFileSync(join(cleoHome, 'global-salt'), Buffer.alloc(32, 0xcd), { mode: 0o600 });

      // Mock paths so ensureGlobalSignaldockDb uses our tmp cleoHome.
      const { vi } = await import('vitest');
      vi.doMock('../../paths.js', async () => {
        const actual = await vi.importActual<typeof import('../../paths.js')>('../../paths.js');
        return { ...actual, getCleoHome: () => cleoHome };
      });

      // Re-import to pick up the mock.
      vi.resetModules();
      const { ensureGlobalSignaldockDb, _resetGlobalSignaldockDb_TESTING_ONLY } = await import(
        '../../store/signaldock-sqlite.js'
      );
      _resetGlobalSignaldockDb_TESTING_ONLY();
      await ensureGlobalSignaldockDb();

      const dbPath = join(cleoHome, 'signaldock.db');
      const db = new DatabaseSync(dbPath);
      db.exec('PRAGMA foreign_keys = ON');
      db.close();

      const { validateSpawnReadiness: vsr } = await import('../validate-spawn.js');
      const accessor = makeAccessor([
        baseTask({ title: 'T1933 preflight test', files: ['some-file.ts'] }),
      ]);

      const result = await vsr('T9801', base, accessor, {
        packagedSeedDir: templatesDir, // empty — fallback misses
        universalBasePath: missingUniversalBase, // missing — universal misses
      });

      // V_AGENT_NOT_FOUND MUST be emitted when all 5 tiers fail.
      const agentIssue = result.issues.find((i) => i.code === 'V_AGENT_NOT_FOUND');
      expect(agentIssue).toBeDefined();
      expect(agentIssue?.severity).toBe('error');
      expect(result.ready).toBe(false);

      _resetGlobalSignaldockDb_TESTING_ONLY();
      vi.restoreAllMocks();
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  /**
   * When the fallback tier resolves the agent (e.g. `project-docs-worker.cant`
   * exists in `templates/`), the pre-flight MUST NOT emit V_AGENT_NOT_FOUND.
   */
  it('passes pre-flight when fallback tier resolves the agent', async () => {
    const { DatabaseSync } = await import('node:sqlite');
    const { _resetGlobalSignaldockDb_TESTING_ONLY } = await import(
      '../../store/signaldock-sqlite.js'
    );
    const { vi } = await import('vitest');

    const base = mkdtempSync(join(tmpdir(), 'cleo-vs-t1933-fallback-'));
    const cleoHome = join(base, 'cleo-home');
    const templatesDir = join(base, 'templates');

    const PROJECT_DOCS_WORKER_CANT = `---
kind: agent
version: 1
---

agent project-docs-worker:
  role: worker
  prompt: "Docs worker."
  skills: []
`;

    try {
      mkdirSync(cleoHome, { recursive: true });
      mkdirSync(templatesDir, { recursive: true });
      writeFileSync(join(cleoHome, 'machine-key'), Buffer.alloc(32, 0xab), { mode: 0o600 });
      writeFileSync(join(cleoHome, 'global-salt'), Buffer.alloc(32, 0xcd), { mode: 0o600 });
      // Plant the template file in the templates dir (fallback tier).
      writeFileSync(
        join(templatesDir, 'project-docs-worker.cant'),
        PROJECT_DOCS_WORKER_CANT,
        'utf-8',
      );

      vi.doMock('../../paths.js', async () => {
        const actual = await vi.importActual<typeof import('../../paths.js')>('../../paths.js');
        return { ...actual, getCleoHome: () => cleoHome };
      });

      vi.resetModules();
      const { ensureGlobalSignaldockDb, _resetGlobalSignaldockDb_TESTING_ONLY: resetDb } =
        await import('../../store/signaldock-sqlite.js');
      resetDb();
      await ensureGlobalSignaldockDb();

      const dbPath = join(cleoHome, 'signaldock.db');
      const db = new DatabaseSync(dbPath);
      db.exec('PRAGMA foreign_keys = ON');
      db.close();

      const { validateSpawnReadiness: vsr } = await import('../validate-spawn.js');
      // Use a task whose classifier will emit 'project-docs-worker' or fall back
      // to cleo-subagent. Either way, cleo-subagent is the universal fallback;
      // we pin universalBasePath to a real file so the universal tier also works.
      const universalBasePath = join(base, 'cleo-subagent-fixture.cant');
      writeFileSync(
        universalBasePath,
        `---\nkind: agent\nversion: 1\n---\n\nagent cleo-subagent:\n  role: worker\n  prompt: "Universal."\n  skills: []\n`,
        'utf-8',
      );

      const accessor = makeAccessor([
        baseTask({ title: 'T1933 fallback pre-flight', files: ['some-file.ts'] }),
      ]);

      const result = await vsr('T9801', base, accessor, {
        packagedSeedDir: templatesDir,
        universalBasePath,
      });

      // No V_AGENT_NOT_FOUND — agent resolved via fallback or universal tier.
      expect(result.issues.some((i) => i.code === 'V_AGENT_NOT_FOUND')).toBe(false);

      resetDb();
      vi.restoreAllMocks();
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});
