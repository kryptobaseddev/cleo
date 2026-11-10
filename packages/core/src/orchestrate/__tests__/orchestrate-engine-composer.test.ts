/**
 * Integration tests for T932 — orchestrate-engine routes every spawn through
 * {@link composeSpawnPayload}.
 *
 * These tests spin up a real on-disk tasks.db + signaldock.db, seed a ready
 * worker task with an explicit `files` scope (so the atomicity gate permits
 * the spawn), then invoke the engine's spawn API. They assert that the
 * response envelope exposes the T932 composer contract:
 *
 *  - `data.meta.composerVersion === '3.0.0'`
 *  - `data.atomicity.allowed === true`
 *  - `data.prompt` is a fully-resolved spawn prompt (contains the task id)
 *  - `data.role` + `data.tier` are populated by the composer
 *
 * We also verify the negative path: a worker task with no `files` is blocked
 * by the atomicity gate with the `E_ATOMICITY_NO_SCOPE` LAFS code.
 *
 * @task T932
 * @epic T910
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { composeSpawnForTask, orchestrateSpawn } from '@cleocode/core/internal';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Minimal task shape seeded through the store during setup.
 *
 * Mirrors the columns actually persisted by `createTask`: the rest of the
 * task envelope is filled in with sensible defaults by the store.
 */
interface SeededTask {
  id: string;
  title: string;
  description?: string;
  status: string;
  priority: string;
  parentId?: string;
  depends?: string[];
  files?: string[];
  type?: string;
  createdAt: string;
  updatedAt: string | null;
}

/**
 * Seed a set of tasks via `createTask`. Each task is inserted into the
 * on-disk tasks.db for the given project root.
 */
async function seedTasks(testRoot: string, tasks: SeededTask[]): Promise<void> {
  const cleoDir = join(testRoot, '.cleo');
  await mkdir(cleoDir, { recursive: true });
  const { createTask, getDb } = await import('@cleocode/core/internal');
  await getDb(testRoot);
  for (const task of tasks) {
    // `createTask` accepts a partial Task shape — cast narrowed to the known
    // fixture columns we seed above.
    await createTask(task as unknown as Parameters<typeof createTask>[0], testRoot);
  }
}

let TEST_ROOT: string;

const PARENT_EPIC: SeededTask = {
  id: 'T9320',
  title: 'T932 integration epic',
  description: 'Parent epic for composer integration test',
  status: 'active',
  priority: 'high',
  createdAt: '2026-04-17T00:00:00Z',
  updatedAt: null,
};

const READY_WORKER: SeededTask = {
  id: 'T9321',
  title: 'T932 worker with explicit files',
  description: 'Ready worker task with declared AC.files',
  status: 'pending',
  priority: 'medium',
  parentId: 'T9320',
  // Atomicity gate permits ≤ MAX_WORKER_FILES (3) files.
  files: ['packages/cleo/src/sample.ts', 'packages/cleo/src/sample.test.ts'],
  createdAt: '2026-04-17T00:00:00Z',
  updatedAt: null,
};

const READY_WORKER_NO_SCOPE: SeededTask = {
  id: 'T9322',
  title: 'T932 worker without files',
  description: 'Ready worker task with NO declared AC.files',
  status: 'pending',
  priority: 'medium',
  parentId: 'T9320',
  createdAt: '2026-04-17T00:00:00Z',
  updatedAt: null,
};

/**
 * T1014: Epic task with no files. Must auto-promote to role=lead so atomicity
 * gate is bypassed (leads have broad scope by design).
 */
const EPIC_NO_FILES: SeededTask = {
  id: 'T9323',
  title: 'T932 standalone epic with no files',
  description: 'Epic for T1014 role auto-promotion test',
  type: 'epic',
  status: 'active',
  priority: 'high',
  createdAt: '2026-04-17T00:00:00Z',
  updatedAt: null,
};

// Each scenario owns its seeded task store and explicitly selected project.
beforeEach(() => {
  vi.stubEnv('CLEO_ROOT', undefined);
  vi.stubEnv('CLEO_DIR', undefined);
});
afterEach(() => vi.unstubAllEnvs());

describe('T932 — orchestrate-engine integration with composeSpawnPayload', () => {
  beforeEach(async () => {
    TEST_ROOT = await mkdtemp(join(tmpdir(), 'cleo-t932-'));
    // T9581: validateProjectRoot legacy-fallback path requires `.cleo/` +
    // `.git/` siblings. seedTasks() creates `.cleo/`; add the `.git/` dir
    // so getProjectRoot() accepts TEST_ROOT as a project root.
    await mkdir(join(TEST_ROOT, '.git'), { recursive: true });
    await seedTasks(TEST_ROOT, [PARENT_EPIC, READY_WORKER, READY_WORKER_NO_SCOPE, EPIC_NO_FILES]);
  });

  afterEach(async () => {
    try {
      const { closeAllDatabases } = await import('@cleocode/core/internal');
      await closeAllDatabases();
      // Drain void cleanupBrainRefsOnTaskDelete promises from seedTasks()
      // and any conduit.db opens from orchestrateSpawn (T9182).
      await new Promise((r) => setTimeout(r, 50));
      await closeAllDatabases();
    } catch {
      /* ignore */
    }
    // maxRetries: Windows WAL sidecar files stay locked briefly (T9182).
    await rm(TEST_ROOT, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
  });

  it('emits payload with composerVersion 3.0.0 meta', async () => {
    const result = await orchestrateSpawn('T9321', undefined, TEST_ROOT, undefined, true);

    expect(result.success).toBe(true);
    const data = result.data as {
      taskId: string;
      prompt: string;
      role: string;
      tier: number;
      harnessHint: string;
      atomicity: { allowed: boolean; code?: string };
      meta: {
        composerVersion: string;
        dedupSavedChars: number;
        promptChars: number;
        protocol: string;
        sourceTier: string;
      };
    };

    // The composer contract is what T932 asserts: composerVersion === 3.0.0.
    expect(data.meta.composerVersion).toBe('3.0.0');
    expect(data.atomicity.allowed).toBe(true);

    // The composer populates diagnostic meta even on happy-path spawns.
    expect(data.meta.promptChars).toBeGreaterThan(0);
    expect(data.meta.protocol).toBeTruthy();
    expect(data.meta.dedupSavedChars).toBeGreaterThanOrEqual(0);

    // The prompt is fully-rendered and contains the task id.
    expect(data.prompt).toContain('T9321');
    expect(data.taskId).toBe('T9321');
    // Role surfaces the composer's derivation (worker by default).
    expect(data.role).toBeDefined();
    expect(typeof data.tier).toBe('number');
  });

  it('T13494 — names the agent identity, persona and role separately and consistently', async () => {
    const result = await orchestrateSpawn('T9321', undefined, TEST_ROOT, undefined, true);
    expect(result.success).toBe(true);
    const data = result.data as {
      agentId: string;
      persona: string;
      role: string;
      sessionId: string | null;
      worktreeEnv: Record<string, string> | null;
      meta: { classify: { agentId: string } };
    };
    // The identity is the per-agent session's handle, the same id the worktree env exports.
    expect(data.agentId).toBe('agent-t9321');
    if (data.worktreeEnv) expect(data.worktreeEnv.CLEO_AGENT_ID).toBe(data.agentId);
    // The persona is the classifier's routing decision, reported once, consistently.
    expect(data.persona).toBe(data.meta.classify.agentId);
    expect(['orchestrator', 'lead', 'worker']).toContain(data.role);
  });

  it('rejects worker spawn when AC.files is missing (E_ATOMICITY_NO_SCOPE)', async () => {
    const result = await orchestrateSpawn('T9322', undefined, TEST_ROOT, undefined, true);

    // Composer rejects; engine surfaces the atomicity code as a first-class
    // LAFS envelope.
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('E_ATOMICITY_NO_SCOPE');

    const details = result.error?.details as { atomicity?: { allowed: boolean } } | undefined;
    expect(details?.atomicity?.allowed).toBe(false);
  });

  it('T13510 — refuses before any session, claim or worktree when the worker has no file scope', async () => {
    // With a worktree requested (noWorktree=false). TEST_ROOT's .git is an empty
    // dir, so reaching provisioning would fail with a worktree error instead.
    const result = await orchestrateSpawn('T9322', undefined, TEST_ROOT, undefined, false);
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('E_ATOMICITY_NO_SCOPE');
    const { getTaskAccessor } = await import('@cleocode/core/internal');
    const acc = await getTaskAccessor(TEST_ROOT);
    expect((await acc.loadSingleTask('T9322'))?.claim).toBeUndefined();
    const sessions = await acc.loadSessions();
    expect(sessions.filter((x) => x.agentHandle === 'agent-t9322')).toHaveLength(0);
  });

  it('T10430 — atomicityScope=orchestrator-defer waives E_ATOMICITY_NO_SCOPE for worker without files', async () => {
    // Re-uses READY_WORKER_NO_SCOPE (T9322) — a worker task with no AC.files.
    // Without the waiver this spawn returns E_ATOMICITY_NO_SCOPE (verified by
    // the test above). Passing atomicityScope='orchestrator-defer' through
    // the seventh positional arg routes the waiver into composeSpawnPayload
    // → checkAtomicity so the spawn is granted with an audit-trail waiver.
    const result = await orchestrateSpawn(
      'T9322',
      undefined,
      TEST_ROOT,
      undefined,
      true, // noWorktree — keep the test hermetic
      undefined, // spawnScope (sparse-checkout) — distinct from atomicityScope
      'orchestrator-defer',
    );

    expect(result.success).toBe(true);
    const data = result.data as {
      atomicity: {
        allowed: boolean;
        atomicity_waiver?: string;
        meta?: { fileCount: number; hasScope: boolean };
      };
    };
    expect(data.atomicity.allowed).toBe(true);
    // The waiver reason is stamped on the spawn payload so the manifest entry
    // remains auditable downstream.
    expect(data.atomicity.atomicity_waiver).toBe('orchestrator-scope-tier1-call');
    expect(data.atomicity.meta).toEqual({ fileCount: 0, hasScope: false });
  });

  it('T1014 — epic spawn auto-promotes to role=lead, bypassing atomicity file-scope gate', async () => {
    // T9323 is type=epic with no files declared. Without the T1014 fix this
    // would return E_ATOMICITY_NO_SCOPE because the default resolved role is
    // worker (cleo-subagent.orchLevel = 2). With the fix the engine detects
    // task.type === 'epic' and forces role=lead before entering the atomicity
    // gate (leads pass through unconditionally).
    const result = await orchestrateSpawn('T9323', undefined, TEST_ROOT, undefined, true);

    expect(result.success).toBe(true);
    const data = result.data as {
      role: string;
      atomicity: { allowed: boolean };
      prompt: string;
    };
    expect(data.role).toBe('lead');
    expect(data.atomicity.allowed).toBe(true);
    // Prompt contains the task id so we know the right task was rendered.
    expect(data.prompt).toContain('T9323');
  });

  describe('T14379 — lead mailbox defaults from project config', () => {
    const lead = (prompt: string) => /Your lead's mailbox: `([^`]+)`/.exec(prompt)?.[1];
    // Only tier 1/2 prompts carry the Agent Coordination block that names the
    // lead (T13943); T9321's auto tier is 0, so every case asks for tier 1.
    const TIER = 1;
    const writeConfig = (v1: boolean) =>
      writeFile(
        join(TEST_ROOT, '.cleo', 'config.json'),
        JSON.stringify({
          orchestrate: {
            leadWorker: { v1 },
            leadMailbox: { name: 'proj-lead', projectId: 'p1', cli: 'claude' },
          },
        }),
      );

    it('spawn names the recorded lead mailbox when --lead-mbx is not given', async () => {
      await writeConfig(true);
      const result = await orchestrateSpawn('T9321', undefined, TEST_ROOT, TIER, true);
      expect(result.success).toBe(true);
      expect(lead((result.data as { prompt: string }).prompt)).toBe('proj-lead');
    });

    it('fanout path (composer with no leadMailbox) names it too; --lead-mbx wins', async () => {
      await writeConfig(true);
      // orchestrateSpawnExecute, which fanout calls, composes with no leadMailbox.
      expect(lead((await composeSpawnForTask('T9321', TEST_ROOT, { tier: TIER })).prompt)).toBe(
        'proj-lead',
      );
      const explicit = await composeSpawnForTask('T9321', TEST_ROOT, {
        tier: TIER,
        leadMailbox: 'other',
      });
      expect(lead(explicit.prompt)).toBe('other');
    });

    it('with orchestrate.leadWorker.v1 off, spawn and fanout name no recorded mailbox', async () => {
      await writeConfig(false);
      const result = await orchestrateSpawn('T9321', undefined, TEST_ROOT, TIER, true);
      const prompt = (result.data as { prompt: string }).prompt;
      expect(prompt).toContain('No lead mailbox was given at spawn');
      expect(lead(prompt)).toBeUndefined();
      expect(
        lead((await composeSpawnForTask('T9321', TEST_ROOT, { tier: TIER })).prompt),
      ).toBeUndefined();
    });
  });
});
