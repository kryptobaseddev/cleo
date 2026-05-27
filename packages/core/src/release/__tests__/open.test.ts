/**
 * Tests for {@link releaseOpen} — SPEC-T9345 §4.3 release open verb.
 *
 * Covers:
 *  - Happy path: workflow dispatched, releases row UPDATEd to `pr-opened`,
 *    `workflow_run_url` persisted, LAFS envelope returned.
 *  - `E_PLAN_NOT_FOUND` when `.cleo/release/<version>.plan.json` is absent (R-050).
 *  - `E_INVALID_STATE` when the releases row status is not `planned` (R-051).
 *  - `E_GH_NOT_AUTHENTICATED` when `gh auth status` exits non-zero (R-052).
 *  - `E_WORKFLOW_NOT_FOUND` when `.github/workflows/release-prepare.yml` is missing (R-053).
 *  - Idempotency — re-running on a row already at `pr-opened` is a no-op.
 *
 * @task T9530
 * @epic T9494
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  E_GH_NOT_AUTHENTICATED,
  E_INVALID_STATE,
  E_PLAN_NOT_FOUND,
  E_WORKFLOW_NOT_FOUND,
  type ReleasePlan,
} from '@cleocode/contracts';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { closeDb, getDb, resetDbState } from '../../store/sqlite.js';
import * as schema from '../../store/tasks-schema.js';
import { DEFAULT_OPEN_WORKFLOW, type ReleaseOpenRunner, releaseOpen } from '../open.js';

let testDir: string;

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/**
 * Construct a minimum-valid {@link ReleasePlan} for a given version. All
 * required fields per the canonical schema are populated; downstream verbs
 * never need to touch the structural details of the plan.
 */
function makePlan(version: string, epicId = 'T9999'): ReleasePlan {
  const nowIso = new Date().toISOString();
  return {
    $schema: 'https://cleocode.io/schemas/release-plan/v1.json',
    version,
    resolvedVersion: version,
    suffixApplied: false,
    scheme: 'calver',
    channel: 'latest',
    epicId,
    releaseKind: 'regular',
    createdAt: nowIso,
    createdBy: 'test',
    previousVersion: null,
    previousTag: null,
    previousShippedAt: null,
    tasks: [
      {
        id: 'T10001',
        kind: 'feat',
        impact: 'minor',
        userFacingSummary: 'Test feature',
        evidenceAtoms: ['commit:abc1234567'],
        epicAncestor: epicId,
      },
    ],
    changelog: { features: ['T10001'], fixes: [], chores: [], breaking: [] },
    gates: [
      { name: 'test', atom: 'tool:test', status: 'passed', lastVerifiedAt: nowIso },
      { name: 'build', atom: 'tool:build', status: 'passed', lastVerifiedAt: nowIso },
      { name: 'lint', atom: 'tool:lint', status: 'passed', lastVerifiedAt: nowIso },
      { name: 'typecheck', atom: 'tool:typecheck', status: 'passed', lastVerifiedAt: nowIso },
      { name: 'audit', atom: 'tool:audit', status: 'skipped', lastVerifiedAt: nowIso },
      {
        name: 'security-scan',
        atom: 'tool:security-scan',
        status: 'skipped',
        lastVerifiedAt: nowIso,
      },
    ],
    platformMatrix: [{ platform: 'any', publisher: 'npm', package: '@cleocode/cleo' }],
    preflightSummary: {
      esbuildExternalsDrift: false,
      lockfileDrift: false,
      epicCompletenessClean: true,
      doubleListingClean: true,
      preflightWarnings: [],
    },
    workflowRunUrl: null,
    prUrl: null,
    mergeCommitSha: null,
    status: 'planned',
    meta: { firstEverRelease: true, archetype: 'node' },
  };
}

/** Write `.cleo/release/<version>.plan.json` with the given plan body. */
function writePlanFile(version: string, plan: ReleasePlan): string {
  const releaseDir = join(testDir, '.cleo', 'release');
  mkdirSync(releaseDir, { recursive: true });
  const planPath = join(releaseDir, `${version}.plan.json`);
  writeFileSync(planPath, `${JSON.stringify(plan, null, 2)}\n`, { encoding: 'utf-8' });
  return planPath;
}

/** Stage a placeholder `release-prepare.yml` workflow file. */
function writeWorkflowFile(name: string = DEFAULT_OPEN_WORKFLOW): string {
  const workflowDir = join(testDir, '.github', 'workflows');
  mkdirSync(workflowDir, { recursive: true });
  const path = join(workflowDir, name);
  writeFileSync(path, 'name: release-prepare\non: workflow_dispatch\njobs: {}\n', {
    encoding: 'utf-8',
  });
  return path;
}

/** Seed a `releases` row at the given status. */
async function seedReleaseRow(version: string, status: schema.ReleaseStatus): Promise<void> {
  const db = await getDb(testDir);
  await db
    .insert(schema.releases)
    .values({
      id: `testhash:${version}`,
      version,
      scheme: 'calver',
      channel: 'latest',
      epicId: null,
      releaseKind: 'regular',
      status,
      plannedAt: new Date().toISOString(),
      projectHash: 'testhash',
    })
    .run();
}

/** Construct a {@link ReleaseOpenRunner} that records calls. */
function makeStubRunner(opts?: {
  authOk?: boolean;
  runListResponse?: string;
  workflowRunThrows?: Error;
}): ReleaseOpenRunner & {
  calls: Array<{ cmd: string; args: readonly string[] }>;
} {
  const calls: Array<{ cmd: string; args: readonly string[] }> = [];
  const authOk = opts?.authOk !== false;
  return {
    calls,
    checkGhAuth: () => {
      calls.push({ cmd: 'gh', args: ['auth', 'status'] });
      return authOk;
    },
    runGh: (args) => {
      calls.push({ cmd: 'gh', args });
      if (args[0] === 'workflow' && args[1] === 'run') {
        if (opts?.workflowRunThrows) throw opts.workflowRunThrows;
        return '';
      }
      if (args[0] === 'run' && args[1] === 'list') {
        return (
          opts?.runListResponse ??
          JSON.stringify([
            {
              url: 'https://github.com/cleocode/cleo/actions/runs/12345',
              databaseId: 12345,
              status: 'in_progress',
            },
          ])
        );
      }
      if (args[0] === 'run' && args[1] === 'watch') {
        return '';
      }
      return '';
    },
  };
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

beforeEach(async () => {
  testDir = await mkdtemp(join(tmpdir(), 'cleo-release-open-'));
  await mkdir(join(testDir, '.cleo'), { recursive: true });
  writeFileSync(
    join(testDir, '.cleo', 'config.json'),
    JSON.stringify({
      enforcement: { session: { requiredForMutate: false } },
      lifecycle: { mode: 'off' },
      verification: { enabled: false },
    }),
  );
  writeFileSync(
    join(testDir, '.cleo', 'project-info.json'),
    JSON.stringify({
      projectHash: 'testhash',
      projectId: 'test-project-id',
      projectRoot: testDir,
      projectName: 'test',
    }),
  );
  execFileSync('git', ['init', '--quiet', testDir], { encoding: 'utf-8' });
  execFileSync('git', ['-C', testDir, 'config', 'user.email', 'test@example.com']);
  execFileSync('git', ['-C', testDir, 'config', 'user.name', 'Test']);
  execFileSync('git', ['-C', testDir, 'config', 'commit.gpgsign', 'false']);
  resetDbState();
});

afterEach(async () => {
  try {
    closeDb();
  } catch {
    // best-effort
  }
  await rm(testDir, { recursive: true, force: true });
});

// =============================================================================
// Happy path
// =============================================================================

describe('releaseOpen — happy path', () => {
  it('dispatches the workflow, UPDATEs releases.status to pr-opened, and persists workflow_run_url', async () => {
    const version = 'v2026.6.0';
    writePlanFile(version, makePlan(version));
    writeWorkflowFile();
    await seedReleaseRow(version, 'planned');

    const runner = makeStubRunner();

    const result = await releaseOpen({ version, projectRoot: testDir }, runner);

    expect(result.success).toBe(true);
    if (!result.success) throw new Error('unreachable');
    expect(result.data.version).toBe(version);
    expect(result.data.workflowRunUrl).toContain('actions/runs/');
    expect(result.data.watching).toBe(false);
    expect(result.data.planBlobSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(result.data.idempotent).toBeUndefined();

    // gh workflow run was invoked with the expected fields
    const dispatched = runner.calls.find((c) => c.args[0] === 'workflow' && c.args[1] === 'run');
    expect(dispatched).toBeDefined();
    expect(dispatched?.args).toContain(`version=${version}`);
    // T10105: `plan-blob-sha256` is NO LONGER passed as a workflow field
    // because the release-prepare.yml workflow_dispatch.inputs block does
    // not declare it (GitHub returns HTTP 422 for unknown fields). The
    // sha256 is still computed and returned in the result envelope for
    // downstream provenance tracking — see `planBlobSha256` assertion above.
    expect(dispatched?.args.some((a) => a.startsWith('plan-blob-sha256='))).toBe(false);

    // releases row updated
    const db = await getDb(testDir);
    const rows = await db
      .select()
      .from(schema.releases)
      .where(eq(schema.releases.version, version))
      .all();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe('pr-opened');
    expect(rows[0]?.workflowRunUrl).toMatch(/^https:\/\/github.com\//);
    expect(rows[0]?.prOpenedAt).toBeTruthy();
  });
});

// =============================================================================
// Error envelopes (R-050 .. R-053)
// =============================================================================

describe('releaseOpen — error envelopes', () => {
  it('returns E_PLAN_NOT_FOUND when the plan file is missing (R-050)', async () => {
    // No plan file; releases row seeded so we pass R-051 even if it ran.
    writeWorkflowFile();
    await seedReleaseRow('v2026.6.0', 'planned');

    const result = await releaseOpen(
      { version: 'v2026.6.0', projectRoot: testDir },
      makeStubRunner(),
    );

    expect(result.success).toBe(false);
    if (result.success) throw new Error('unreachable');
    expect(result.error.code).toBe(E_PLAN_NOT_FOUND);
    expect(result.error.fix).toContain('cleo release plan');
  });

  it('returns E_INVALID_STATE when the releases row is at a non-planned status (R-051)', async () => {
    const version = 'v2026.6.0';
    writePlanFile(version, makePlan(version));
    writeWorkflowFile();
    await seedReleaseRow(version, 'pr-merged');

    const result = await releaseOpen({ version, projectRoot: testDir }, makeStubRunner());

    expect(result.success).toBe(false);
    if (result.success) throw new Error('unreachable');
    expect(result.error.code).toBe(E_INVALID_STATE);
    expect(result.error.details).toMatchObject({
      currentStatus: 'pr-merged',
      expectedStatus: ['planned'],
    });
  });

  it('returns E_INVALID_STATE when no releases row exists (R-051)', async () => {
    const version = 'v2026.6.0';
    writePlanFile(version, makePlan(version));
    writeWorkflowFile();
    // intentionally NO seedReleaseRow

    const result = await releaseOpen({ version, projectRoot: testDir }, makeStubRunner());

    expect(result.success).toBe(false);
    if (result.success) throw new Error('unreachable');
    expect(result.error.code).toBe(E_INVALID_STATE);
    expect(result.error.fix).toContain('cleo release plan');
  });

  it('returns E_GH_NOT_AUTHENTICATED when gh auth status exits non-zero (R-052)', async () => {
    const version = 'v2026.6.0';
    writePlanFile(version, makePlan(version));
    writeWorkflowFile();
    await seedReleaseRow(version, 'planned');

    const result = await releaseOpen(
      { version, projectRoot: testDir },
      makeStubRunner({ authOk: false }),
    );

    expect(result.success).toBe(false);
    if (result.success) throw new Error('unreachable');
    expect(result.error.code).toBe(E_GH_NOT_AUTHENTICATED);
    expect(result.error.fix).toContain('gh auth login');
  });

  it('returns E_WORKFLOW_NOT_FOUND when the workflow yml is missing (R-053)', async () => {
    const version = 'v2026.6.0';
    writePlanFile(version, makePlan(version));
    // intentionally NO writeWorkflowFile()
    await seedReleaseRow(version, 'planned');

    const result = await releaseOpen({ version, projectRoot: testDir }, makeStubRunner());

    expect(result.success).toBe(false);
    if (result.success) throw new Error('unreachable');
    expect(result.error.code).toBe(E_WORKFLOW_NOT_FOUND);
  });
});

// =============================================================================
// Idempotency (re-run on already pr-opened row)
// =============================================================================

describe('releaseOpen — idempotency', () => {
  it('returns idempotent=true without re-dispatching when status is already pr-opened', async () => {
    const version = 'v2026.6.0';
    writePlanFile(version, makePlan(version));
    writeWorkflowFile();
    await seedReleaseRow(version, 'planned');

    const runner = makeStubRunner();
    const first = await releaseOpen({ version, projectRoot: testDir }, runner);
    expect(first.success).toBe(true);

    const dispatchCallsAfterFirst = runner.calls.filter(
      (c) => c.args[0] === 'workflow' && c.args[1] === 'run',
    ).length;
    expect(dispatchCallsAfterFirst).toBe(1);

    const second = await releaseOpen({ version, projectRoot: testDir }, runner);
    expect(second.success).toBe(true);
    if (!second.success) throw new Error('unreachable');
    expect(second.data.idempotent).toBe(true);
    expect(second.data.workflowRunUrl).toBeTruthy();

    // No additional `gh workflow run` invocation on the second call.
    const dispatchCallsAfterSecond = runner.calls.filter(
      (c) => c.args[0] === 'workflow' && c.args[1] === 'run',
    ).length;
    expect(dispatchCallsAfterSecond).toBe(1);
  });
});
