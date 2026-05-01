/**
 * Tests for the cross-project hygiene engine — T1637.
 *
 * Coverage:
 *   Step 1 — NEXUS integrity: healthy project, unreachable project, degraded project
 *   Step 2 — Temp-project GC: candidate flagged (no .git, inactive), active project skipped,
 *             candidate written to audit JSONL
 *   Step 3 — Duplicate-epic detection: matching titles across projects, no-match paths
 *   Step 4 — Worktree pruning: delegates to pruneOrphanedWorktrees, active tasks preserved
 *   applyGcBatch: marks batch applied, calls nexusUnregister
 *   safeRunCrossProjectHygiene: swallows unexpected errors
 *
 * @task T1637
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Module-level mocks (hoisted before imports by Vitest).
// These intercept the static imports in cross-project-hygiene.ts.
//
// NOTE: factories use plain async functions (not vi.fn().mockResolvedValue())
// so vi.clearAllMocks() doesn't reset the default implementations.
// Per-test overrides use vi.spyOn(...).mockImplementationOnce(...).
// ---------------------------------------------------------------------------
vi.mock('../../nexus/registry.js', () => ({
  nexusList: vi.fn(async () => []),
  nexusUnregister: vi.fn(async () => undefined),
}));

vi.mock('../../store/data-accessor.js', () => ({
  getAccessor: vi.fn(async () => ({
    queryTasks: vi.fn(async () => ({ tasks: [] })),
    countTasks: vi.fn(async () => 0),
  })),
}));

vi.mock('../../spawn/branch-lock.js', () => ({
  pruneOrphanedWorktrees: vi.fn(() => ({
    removed: 0,
    removedPaths: [],
    errors: [],
  })),
}));

vi.mock('../../logger.js', () => ({
  getLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

import * as nexusRegistry from '../../nexus/registry.js';
import * as branchLock from '../../spawn/branch-lock.js';
import * as dataAccessor from '../../store/data-accessor.js';
import {
  applyGcBatch,
  getTempGcAuditPath,
  runDuplicateEpicDetection,
  runNexusIntegrityCheck,
  runTempProjectGc,
  runWorktreePrune,
  safeRunCrossProjectHygiene,
  TEMP_GC_INACTIVITY_DAYS,
  type TempGcCandidate,
} from '../cross-project-hygiene.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'cleo-hygiene-test-'));
}

/** Create a minimal project tree under dir. Returns the project root. */
async function makeProject(
  parent: string,
  name: string,
  opts: { tasksDb?: boolean; brainDb?: boolean; projectInfo?: boolean | 'invalid' } = {},
): Promise<string> {
  const root = join(parent, name);
  const cleoDir = join(root, '.cleo');
  await mkdir(cleoDir, { recursive: true });

  if (opts.tasksDb !== false) {
    writeFileSync(join(cleoDir, 'tasks.db'), 'placeholder');
  }
  if (opts.brainDb !== false) {
    writeFileSync(join(cleoDir, 'brain.db'), 'placeholder');
  }
  if (opts.projectInfo === 'invalid') {
    writeFileSync(join(cleoDir, 'project-info.json'), 'not-json');
  } else if (opts.projectInfo !== false) {
    writeFileSync(
      join(cleoDir, 'project-info.json'),
      JSON.stringify({ projectHash: 'abc123', projectId: 'uuid-test', schemaVersion: '1.0.0' }),
    );
  }
  return root;
}

/** Minimal mock NexusProject shape. */
function mockProject(
  hash: string,
  path: string,
  name: string,
  lastSeen = new Date().toISOString(),
): Awaited<ReturnType<typeof nexusRegistry.nexusList>>[number] {
  return {
    hash,
    path,
    name,
    lastSeen,
    projectId: '',
    registeredAt: new Date().toISOString(),
    healthStatus: 'unknown',
    healthLastCheck: null,
    permissions: 'read',
    lastSync: new Date().toISOString(),
    taskCount: 0,
    labels: [],
    brainDbPath: null,
    tasksDbPath: null,
    lastIndexed: null,
    stats: { nodeCount: 0, relationCount: 0, fileCount: 0 },
  };
}

// ---------------------------------------------------------------------------
// Step 1 — NEXUS integrity check
// ---------------------------------------------------------------------------

describe('runNexusIntegrityCheck', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = makeTmpDir();
    vi.clearAllMocks();
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('reports healthy when all files present', async () => {
    const root = await makeProject(tmp, 'proj-healthy');
    vi.spyOn(nexusRegistry, 'nexusList').mockResolvedValueOnce([
      mockProject('aaa111', root, 'proj-healthy'),
    ]);

    const result = await runNexusIntegrityCheck();
    expect(result.total).toBe(1);
    expect(result.healthy).toBe(1);
    expect(result.degraded).toBe(0);
    expect(result.unreachable).toBe(0);
    expect(result.issues).toHaveLength(0);
  });

  it('reports unreachable when project directory is missing', async () => {
    vi.spyOn(nexusRegistry, 'nexusList').mockResolvedValueOnce([
      mockProject('bbb222', '/nonexistent/project', 'ghost'),
    ]);

    const result = await runNexusIntegrityCheck();
    expect(result.unreachable).toBe(1);
    expect(result.healthy).toBe(0);
    expect(result.issues[0]?.problems[0]).toMatch(/not reachable/i);
  });

  it('reports degraded when tasks.db missing', async () => {
    const root = await makeProject(tmp, 'proj-notasks', { tasksDb: false });
    vi.spyOn(nexusRegistry, 'nexusList').mockResolvedValueOnce([
      mockProject('ccc333', root, 'proj-notasks'),
    ]);

    const result = await runNexusIntegrityCheck();
    expect(result.degraded).toBe(1);
    expect(result.issues[0]?.problems).toContain('tasks.db missing');
  });

  it('reports degraded when project-info.json is invalid JSON', async () => {
    const root = await makeProject(tmp, 'proj-badinfo', { projectInfo: 'invalid' });
    vi.spyOn(nexusRegistry, 'nexusList').mockResolvedValueOnce([
      mockProject('ddd444', root, 'proj-badinfo'),
    ]);

    const result = await runNexusIntegrityCheck();
    expect(result.degraded).toBe(1);
    expect(result.issues[0]?.problems.some((p) => p.includes('project-info.json'))).toBe(true);
  });

  it('returns empty result when nexusList throws', async () => {
    vi.spyOn(nexusRegistry, 'nexusList').mockRejectedValueOnce(new Error('db locked'));

    const result = await runNexusIntegrityCheck();
    expect(result.total).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Step 2 — Temp-project GC
// ---------------------------------------------------------------------------

describe('runTempProjectGc', () => {
  let tmp: string;
  let origXdg: string | undefined;

  beforeEach(() => {
    tmp = makeTmpDir();
    origXdg = process.env['XDG_DATA_HOME'];
    process.env['XDG_DATA_HOME'] = tmp;
    vi.clearAllMocks();
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
    if (origXdg === undefined) {
      delete process.env['XDG_DATA_HOME'];
    } else {
      process.env['XDG_DATA_HOME'] = origXdg;
    }
  });

  const oldDate = new Date(
    Date.now() - (TEMP_GC_INACTIVITY_DAYS + 5) * 24 * 60 * 60 * 1000,
  ).toISOString();

  it('flags a project with no .git and old lastSeen as a GC candidate', async () => {
    const root = await makeProject(tmp, 'temp-proj');
    vi.spyOn(nexusRegistry, 'nexusList').mockResolvedValueOnce([
      mockProject('eee555', root, 'temp-proj', oldDate),
    ]);

    const result = await runTempProjectGc();
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]?.projectHash).toBe('eee555');
  });

  it('skips projects that have a .git directory', async () => {
    const root = await makeProject(tmp, 'git-proj');
    await mkdir(join(root, '.git'), { recursive: true });
    vi.spyOn(nexusRegistry, 'nexusList').mockResolvedValueOnce([
      mockProject('fff666', root, 'git-proj', oldDate),
    ]);

    const result = await runTempProjectGc();
    expect(result.candidates).toHaveLength(0);
  });

  it('skips projects with recent lastSeen', async () => {
    const root = await makeProject(tmp, 'active-proj');
    vi.spyOn(nexusRegistry, 'nexusList').mockResolvedValueOnce([
      mockProject('ggg777', root, 'active-proj', new Date().toISOString()),
    ]);

    const result = await runTempProjectGc();
    expect(result.candidates).toHaveLength(0);
  });

  it('writes a pending_approval record to the audit JSONL', async () => {
    const root = await makeProject(tmp, 'audit-proj');
    vi.spyOn(nexusRegistry, 'nexusList').mockResolvedValueOnce([
      mockProject('hhh888', root, 'audit-proj', oldDate),
    ]);

    const result = await runTempProjectGc();
    expect(result.candidates).toHaveLength(1);

    // Verify audit file was written.
    const raw = await readFile(result.auditPath, 'utf-8');
    const parsed = JSON.parse(raw.trim()) as { batchId: string; status: string };
    expect(parsed.batchId).toBe(result.batchId);
    expect(parsed.status).toBe('pending_approval');
  });
});

// ---------------------------------------------------------------------------
// Step 3 — Duplicate epic detection
// ---------------------------------------------------------------------------

describe('runDuplicateEpicDetection', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = makeTmpDir();
    vi.clearAllMocks();
  });
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  it('detects epics with similar titles across projects', async () => {
    // Use very similar titles so Jaccard similarity exceeds the 0.8 threshold.
    // Both titles share all major words → unigrams and most bigrams match.
    const sharedTitle = 'User authentication oauth login epic';
    const rootA = await makeProject(tmp, 'proj-a');
    const rootB = await makeProject(tmp, 'proj-b');

    vi.spyOn(nexusRegistry, 'nexusList').mockResolvedValueOnce([
      mockProject('iii111', rootA, 'proj-a'),
      mockProject('jjj222', rootB, 'proj-b'),
    ]);

    vi.spyOn(dataAccessor, 'getAccessor')
      .mockResolvedValueOnce({
        queryTasks: vi.fn(async () => ({
          tasks: [{ id: 'E1', title: sharedTitle }],
        })),
        countTasks: vi.fn(async () => 1),
      } as Awaited<ReturnType<typeof dataAccessor.getAccessor>>)
      .mockResolvedValueOnce({
        queryTasks: vi.fn(async () => ({
          // Identical title → Jaccard = 1.0 — guaranteed detection.
          tasks: [{ id: 'E2', title: sharedTitle }],
        })),
        countTasks: vi.fn(async () => 1),
      } as Awaited<ReturnType<typeof dataAccessor.getAccessor>>);

    const result = await runDuplicateEpicDetection();
    expect(result.projectsScanned).toBe(2);
    // Identical titles → should detect a duplicate group.
    expect(result.groups.length).toBeGreaterThanOrEqual(1);
  });

  it('does not flag epics within the same project as duplicates', async () => {
    const rootA = await makeProject(tmp, 'proj-solo');
    vi.spyOn(nexusRegistry, 'nexusList').mockResolvedValueOnce([
      mockProject('kkk333', rootA, 'proj-solo'),
    ]);

    vi.spyOn(dataAccessor, 'getAccessor').mockImplementationOnce(
      async () =>
        ({
          queryTasks: vi.fn(async () => ({
            tasks: [
              { id: 'E1', title: 'Authentication epic' },
              { id: 'E2', title: 'Authentication epic' },
            ],
          })),
          countTasks: vi.fn(async () => 2),
        }) as Awaited<ReturnType<typeof dataAccessor.getAccessor>>,
    );

    const result = await runDuplicateEpicDetection();
    // No groups — only one project.
    expect(result.groups).toHaveLength(0);
  });

  it('returns empty when nexusList throws', async () => {
    vi.spyOn(nexusRegistry, 'nexusList').mockRejectedValueOnce(new Error('no registry'));

    const result = await runDuplicateEpicDetection();
    expect(result.projectsScanned).toBe(0);
    expect(result.groups).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Step 4 — Stale worktree pruning
// ---------------------------------------------------------------------------

describe('runWorktreePrune', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = makeTmpDir();
    vi.clearAllMocks();
  });
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  it('calls pruneOrphanedWorktrees for each reachable project', async () => {
    const rootA = await makeProject(tmp, 'wt-proj-a');
    const rootB = await makeProject(tmp, 'wt-proj-b');

    vi.spyOn(nexusRegistry, 'nexusList').mockResolvedValueOnce([
      mockProject('lll111', rootA, 'wt-proj-a'),
      mockProject('mmm222', rootB, 'wt-proj-b'),
    ]);

    vi.spyOn(dataAccessor, 'getAccessor').mockImplementation(
      async () =>
        ({
          queryTasks: vi.fn(async () => ({ tasks: [] })),
          countTasks: vi.fn(async () => 0),
        }) as Awaited<ReturnType<typeof dataAccessor.getAccessor>>,
    );

    const pruneSpy = vi.spyOn(branchLock, 'pruneOrphanedWorktrees').mockReturnValue({
      removed: 2,
      removedPaths: ['/some/path/T1', '/some/path/T2'],
      errors: [],
    });

    const result = await runWorktreePrune();
    expect(result.projectsScanned).toBe(2);
    expect(result.totalPruned).toBe(4); // 2 per project × 2 projects
    expect(pruneSpy).toHaveBeenCalledTimes(2);
  });

  it('skips unreachable project directories', async () => {
    vi.spyOn(nexusRegistry, 'nexusList').mockResolvedValueOnce([
      mockProject('nnn333', '/no/such/dir', 'ghost'),
    ]);

    const pruneSpy = vi.spyOn(branchLock, 'pruneOrphanedWorktrees');
    const result = await runWorktreePrune();
    expect(result.projectsScanned).toBe(0);
    expect(pruneSpy).not.toHaveBeenCalled();
  });

  it('preserves active task worktrees', async () => {
    const root = await makeProject(tmp, 'wt-active');
    vi.spyOn(nexusRegistry, 'nexusList').mockResolvedValueOnce([
      mockProject('ooo444', root, 'wt-active'),
    ]);

    vi.spyOn(dataAccessor, 'getAccessor').mockImplementationOnce(
      async () =>
        ({
          queryTasks: vi.fn(async () => ({
            tasks: [{ id: 'T1234', status: 'active' }],
          })),
          countTasks: vi.fn(async () => 1),
        }) as Awaited<ReturnType<typeof dataAccessor.getAccessor>>,
    );

    const pruneSpy = vi
      .spyOn(branchLock, 'pruneOrphanedWorktrees')
      .mockReturnValue({ removed: 0, removedPaths: [], errors: [] });

    await runWorktreePrune();
    // pruneOrphanedWorktrees should be called with the active task ID in the set.
    const [, passedSet] = pruneSpy.mock.calls[0] as [string, Set<string>];
    expect(passedSet.has('T1234')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// applyGcBatch
// ---------------------------------------------------------------------------

describe('applyGcBatch', () => {
  let tmp: string;
  let origXdg: string | undefined;

  beforeEach(() => {
    tmp = makeTmpDir();
    origXdg = process.env['XDG_DATA_HOME'];
    process.env['XDG_DATA_HOME'] = tmp;
    vi.clearAllMocks();
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
    if (origXdg === undefined) {
      delete process.env['XDG_DATA_HOME'];
    } else {
      process.env['XDG_DATA_HOME'] = origXdg;
    }
  });

  it('marks the batch as applied and calls nexusUnregister', async () => {
    const auditPath = getTempGcAuditPath();
    await mkdir(join(auditPath, '..'), { recursive: true });

    const candidate: TempGcCandidate = {
      projectHash: 'ppp555',
      projectPath: '/tmp/old-proj',
      projectName: 'old-proj',
      lastSeen: new Date(0).toISOString(),
      reason: 'test',
    };
    const batch = {
      batchId: 'batch-test-001',
      createdAt: new Date().toISOString(),
      status: 'pending_approval',
      candidates: [candidate],
    };
    await writeFile(auditPath, `${JSON.stringify(batch)}\n`, 'utf-8');

    const unregisterSpy = vi
      .spyOn(nexusRegistry, 'nexusUnregister')
      .mockResolvedValueOnce(undefined);

    const result = await applyGcBatch('batch-test-001');
    expect(result.unregistered).toBe(1);
    expect(unregisterSpy).toHaveBeenCalledWith('ppp555');

    // Verify audit file updated to 'applied'.
    const raw = await readFile(auditPath, 'utf-8');
    const updated = JSON.parse(raw.trim()) as { status: string };
    expect(updated.status).toBe('applied');
  });

  it('returns zero unregistered when batch not found', async () => {
    const auditPath = getTempGcAuditPath();
    await mkdir(join(auditPath, '..'), { recursive: true });
    await writeFile(auditPath, '', 'utf-8');

    const result = await applyGcBatch('nonexistent-batch');
    expect(result.unregistered).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// safeRunCrossProjectHygiene
// ---------------------------------------------------------------------------

describe('safeRunCrossProjectHygiene', () => {
  let origXdg: string | undefined;

  beforeEach(() => {
    origXdg = process.env['XDG_DATA_HOME'];
    process.env['XDG_DATA_HOME'] = tmpdir();
    vi.clearAllMocks();
  });
  afterEach(() => {
    if (origXdg === undefined) {
      delete process.env['XDG_DATA_HOME'];
    } else {
      process.env['XDG_DATA_HOME'] = origXdg;
    }
  });

  it('returns a valid digest even when all steps throw', async () => {
    vi.spyOn(nexusRegistry, 'nexusList').mockRejectedValue(new Error('total failure'));

    const digest = await safeRunCrossProjectHygiene();
    // Should not throw and should return a minimal digest with error summary.
    expect(digest.nexusIntegrity.total).toBe(0);
    expect(typeof digest.summary).toBe('string');
    expect(digest.completedAt).toBeTruthy();
  });

  it('returns healthy summary when registry is empty', async () => {
    vi.spyOn(nexusRegistry, 'nexusList').mockResolvedValue([]);

    const digest = await safeRunCrossProjectHygiene();
    expect(digest.nexusIntegrity.total).toBe(0);
    expect(digest.summary).toContain('0/0 projects healthy');
  });
});
