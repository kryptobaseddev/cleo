/**
 * T12543 — user-profile traits are scoped to the project they were derived
 * in, operation receipts are never stored as traits, and the receipt repair
 * is a reversible dry-run/apply.
 *
 * Every database here is opened through the real chokepoint
 * (`openDualScopeDbAtPath` / `getNexusDb`), so the T12543 migration runs
 * through `reconcileJournal` + the migration runner exactly as in production.
 *
 * @task T12543
 * @epic T12515
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { RetrievalBundle, UserProfileTrait } from '@cleocode/contracts';
import { formatPortableProjectId } from '@cleocode/paths';
import type { NodeSQLiteDatabase } from 'drizzle-orm/node-sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../memory/llm-backend-resolver.js', () => ({
  resolveLlmBackend: vi.fn(),
}));
vi.mock('ai', () => ({
  generateObject: vi.fn(),
}));

import { generateObject } from 'ai';
import { applyInsights, evaluateDialectic } from '../../memory/dialectic-evaluator.js';
import { resolveLlmBackend } from '../../memory/llm-backend-resolver.js';
import { buildRetrievalBundle } from '../../memory/retrieval/build-retrieval-bundle.js';
import { buildSpawnPrompt } from '../../orchestration/spawn-prompt.js';
import { _resetDualScopeDbCache, openDualScopeDbAtPath } from '../../store/dual-scope-db.js';
import { getNexusDb, resetNexusDbState } from '../../store/nexus-sqlite.js';
import { nexusInit } from '../registry.js';
import { getUserProfileTrait, listUserProfile, upsertUserProfileTrait } from '../user-profile.js';
import {
  classifyReceiptTrait,
  pruneReceiptTraits,
  restorePrunedTraits,
} from '../user-profile-hygiene.js';

const T12543 = '20260927010000_t12543-user-profile-project-scope';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'T12543-'));
  vi.clearAllMocks();
});

afterEach(() => {
  delete process.env['CLEO_HOME'];
  delete process.env['CLEO_DIR'];
  resetNexusDbState();
  _resetDualScopeDbCache();
  rmSync(root, { recursive: true, force: true });
});

/** Create a project directory declaring a portable id. */
function makeProject(name: string, projectId: string): string {
  const dir = join(root, name);
  mkdirSync(join(dir, '.cleo'), { recursive: true });
  writeFileSync(join(dir, '.cleo', 'project-id'), formatPortableProjectId(projectId));
  return dir;
}

/** A complete trait with defaults. */
function trait(key: string, overrides: Partial<UserProfileTrait> = {}): UserProfileTrait {
  const now = new Date().toISOString();
  return {
    traitKey: key,
    traitValue: `value of ${key}`,
    confidence: 0.9,
    source: 'manual',
    derivedFromMessageId: null,
    firstObservedAt: now,
    lastReinforcedAt: now,
    reinforcementCount: 1,
    supersededBy: null,
    ...overrides,
  };
}

/** Open an isolated, fully migrated GLOBAL cleo.db through the chokepoint. */
async function openGlobal(): Promise<{ db: NodeSQLiteDatabase; native: DatabaseSync }> {
  const handle = await openDualScopeDbAtPath('global', join(root, 'global', 'cleo.db'));
  const db = handle.db as unknown as NodeSQLiteDatabase;
  return { db, native: (handle.db as unknown as { $client: DatabaseSync }).$client };
}

/** Column names of `nexus_user_profile`. */
function columns(native: DatabaseSync): string[] {
  return (
    native.prepare('PRAGMA table_info(nexus_user_profile)').all() as Array<{ name: string }>
  ).map((c) => c.name);
}

// ---------------------------------------------------------------------------
// Migration
// ---------------------------------------------------------------------------

describe('T12543 migration (real openDualScopeDbAtPath path)', () => {
  it('adds project_id (nullable) and scope (default project, CHECKed)', async () => {
    const { native } = await openGlobal();
    expect(columns(native)).toEqual(expect.arrayContaining(['project_id', 'scope']));
    native
      .prepare(
        `INSERT INTO nexus_user_profile (trait_key, trait_value, confidence, source, first_observed_at, last_reinforced_at)
         VALUES ('k', 'v', 0.9, 'manual', '2026-09-27T00:00:00.000Z', '2026-09-27T00:00:00.000Z')`,
      )
      .run();
    expect(
      native.prepare("SELECT project_id, scope FROM nexus_user_profile WHERE trait_key='k'").get(),
    ).toEqual({ project_id: null, scope: 'project' });
    expect(() =>
      native.prepare("UPDATE nexus_user_profile SET scope = 'everyone' WHERE trait_key='k'").run(),
    ).toThrow(/CHECK/);
  }, 30_000);

  it('is detected as unapplied by the journal probe and upgrades a legacy row to unknown origin', async () => {
    const dbPath = join(root, 'global', 'cleo.db');
    const first = await openGlobal();
    // Rewind this store to its pre-T12543 shape: drop the journal entry, the
    // index and both columns, then write a legacy row.
    const removed = first.native
      .prepare(`DELETE FROM "__drizzle_migrations" WHERE name = ?`)
      .run(T12543).changes;
    expect(Number(removed)).toBe(1);
    first.native.exec('DROP INDEX `idx_nexus_user_profile_project`');
    first.native.exec('ALTER TABLE nexus_user_profile DROP COLUMN scope');
    first.native.exec('ALTER TABLE nexus_user_profile DROP COLUMN project_id');
    first.native
      .prepare(
        `INSERT INTO nexus_user_profile (trait_key, trait_value, confidence, source, first_observed_at, last_reinforced_at)
         VALUES ('legacy', 'Operation succeeded in domain ''check''', 0.99, 'dialectic:ses_x', '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z')`,
      )
      .run();
    expect(columns(first.native)).not.toContain('project_id');
    _resetDualScopeDbCache();

    const reopened = await openDualScopeDbAtPath('global', dbPath);
    const native = (reopened.db as unknown as { $client: DatabaseSync }).$client;
    expect(columns(native)).toEqual(expect.arrayContaining(['project_id', 'scope']));
    expect(
      native
        .prepare(
          "SELECT trait_value, project_id, scope FROM nexus_user_profile WHERE trait_key='legacy'",
        )
        .get(),
    ).toEqual({
      trait_value: "Operation succeeded in domain 'check'",
      project_id: null,
      scope: 'project',
    });
    expect(
      native.prepare(`SELECT COUNT(*) AS c FROM "__drizzle_migrations" WHERE name = ?`).get(T12543),
    ).toEqual({ c: 1 });
  }, 60_000);
});

// ---------------------------------------------------------------------------
// Reader: retrieval bundle + spawn prompt
// ---------------------------------------------------------------------------

describe('PSYCHE-MEMORY cold pass is project-scoped', () => {
  it('never shows project B traits in project A; shows user-global traits everywhere', async () => {
    process.env['CLEO_HOME'] = join(root, 'home');
    const projectA = makeProject('project-a', 'proj-aaaa');
    const projectB = makeProject('project-b', 'proj-bbbb');
    process.env['CLEO_DIR'] = join(projectA, '.cleo');
    resetNexusDbState();
    await nexusInit();
    const db = await getNexusDb();

    // Written through the real dialectic writer while working in project B.
    await applyInsights(
      {
        globalTraits: [
          { key: 'zoho-mail-filter-order', value: 'support@ before admin@', confidence: 0.9 },
        ],
        peerInsights: [],
      },
      db,
      db,
      { sessionId: 'ses_b', activePeerId: 'global', projectRoot: projectB },
    );
    await upsertUserProfileTrait(db, trait('prefers-zero-deps', { scope: 'user' }));
    await upsertUserProfileTrait(
      db,
      trait('legacy-unknown-origin', { source: 'dialectic:ses_old' }),
    );

    const stored = await getUserProfileTrait(db, 'zoho-mail-filter-order');
    expect(stored?.projectId).toBe('proj-bbbb');
    expect(stored?.scope).toBe('project');

    const bundleFor = (projectRoot: string): Promise<RetrievalBundle> =>
      buildRetrievalBundle(
        { peerId: 'global', sessionId: 'ses_a', passMask: { cold: true, warm: false, hot: false } },
        projectRoot,
      );
    const keys = (b: RetrievalBundle): string[] => b.cold.userProfile.map((t) => t.traitKey).sort();

    const bundleA = await bundleFor(projectA);
    expect(keys(bundleA)).toEqual(['prefers-zero-deps']);
    const bundleB = await bundleFor(projectB);
    expect(keys(bundleB)).toEqual(['prefers-zero-deps', 'zoho-mail-filter-order']);

    const prompt = buildSpawnPrompt({
      task: {
        id: 'T1',
        title: 'scope check',
        status: 'pending',
        type: 'task',
        priority: 'medium',
        size: 'small',
        createdAt: '2026-09-27T00:00:00.000Z',
        updatedAt: '2026-09-27T00:00:00.000Z',
      },
      protocol: 'implementation',
      tier: 1,
      projectRoot: projectA,
      skipCleoInjectionEmbed: true,
      retrievalBundle: bundleA,
    }).prompt;
    expect(prompt).toContain('**prefers-zero-deps**');
    expect(prompt).not.toContain('zoho-mail-filter-order');
    expect(prompt).not.toContain('support@ before admin@');
    expect(prompt).not.toContain('legacy-unknown-origin');

    // Unknown-origin rows stay queryable.
    expect((await listUserProfile(db)).map((t) => t.traitKey)).toContain('legacy-unknown-origin');
  }, 60_000);

  it('a project with no declared identity sees only user-global traits', async () => {
    const { db } = await openGlobal();
    await upsertUserProfileTrait(db, trait('global-pref', { scope: 'user' }));
    await upsertUserProfileTrait(db, trait('a-only', { projectId: 'proj-aaaa' }));
    const visible = await listUserProfile(db, { visibleInProject: null });
    expect(visible.map((t) => t.traitKey)).toEqual(['global-pref']);
  }, 30_000);
});

// ---------------------------------------------------------------------------
// Writer: receipts are never stored
// ---------------------------------------------------------------------------

describe('dialectic evaluator never stores operation receipts as traits', () => {
  const backend = { model: {} as never, name: 'anthropic', modelId: 'test-model' };
  const modelOutput = {
    globalTraits: [
      { key: 'task-successful', value: 'Cleo tasks update operation succeeded', confidence: 0.95 },
      {
        key: 'succeeded-in-domain-check',
        value: "Operation succeeded in domain 'check'",
        confidence: 0.99,
      },
      { key: 'strict-typescript', value: 'never use any; all types explicit', confidence: 0.95 },
    ],
    peerInsights: [],
  };

  it('drops every global trait of an operation-envelope turn (structural)', async () => {
    vi.mocked(resolveLlmBackend).mockResolvedValue(backend as never);
    vi.mocked(generateObject).mockResolvedValue({ object: modelOutput } as never);
    const insights = await evaluateDialectic({
      userMessage: 'cleo tasks update {"taskId":"T1"}',
      systemResponse: 'Operation succeeded in domain "tasks".',
      activePeerId: 'global',
      sessionId: 'ses_env',
      origin: 'operation-envelope',
    });
    expect(insights.globalTraits).toEqual([]);
  });

  it('drops receipt-shaped traits from a conversational turn and keeps real ones', async () => {
    vi.mocked(resolveLlmBackend).mockResolvedValue(backend as never);
    vi.mocked(generateObject).mockResolvedValue({ object: modelOutput } as never);
    const insights = await evaluateDialectic({
      userMessage: 'never use any',
      systemResponse: 'understood',
      activePeerId: 'global',
      sessionId: 'ses_conv',
    });
    expect(insights.globalTraits.map((t) => t.key)).toEqual(['strict-typescript']);
  });

  it('applyInsights refuses receipt traits and stamps the project on the rest', async () => {
    const { db } = await openGlobal();
    const project = makeProject('project-w', 'proj-wwww');
    await applyInsights({ globalTraits: modelOutput.globalTraits, peerInsights: [] }, db, db, {
      sessionId: 'ses_w',
      activePeerId: 'global',
      projectRoot: project,
    });
    const rows = await listUserProfile(db);
    expect(rows.map((t) => [t.traitKey, t.projectId, t.scope])).toEqual([
      ['strict-typescript', 'proj-wwww', 'project'],
    ]);
  }, 30_000);

  it('classifies the measured receipt shapes and leaves real preferences alone', () => {
    for (const [k, v] of [
      ['succeed-domain', "Operation succeeded in domain 'docs'"],
      ['gate-set-for-t122', 'Gate for T122 set to testsPassed with evidence from pr:66'],
      ['cleo-tasks-complete', 'completed task T1670'],
      ['independent-work', 'cleo tasks update request'],
      ['active-peer-is-global', 'the current global entity is the active peer for this session'],
    ]) {
      expect(classifyReceiptTrait(k as string, v as string), k).not.toBeNull();
    }
    for (const [k, v] of [
      ['prefers-zero-deps', '"true"'],
      ['strict-typescript', 'never use any; all types must be explicit'],
      ['requires-tsdoc-on-exports', 'all exported symbols must have TSDoc comments'],
      ['uses-pnpm', '"true"'],
    ]) {
      expect(classifyReceiptTrait(k as string, v as string), k).toBeNull();
    }
  });
});

// ---------------------------------------------------------------------------
// Repair: dry-run, apply (backup first), restore
// ---------------------------------------------------------------------------

describe('cleo memory prune-traits repair', () => {
  async function seed(db: NodeSQLiteDatabase): Promise<void> {
    await upsertUserProfileTrait(
      db,
      trait('succeeded-in-tasks-domain', {
        traitValue: 'Operation succeeded in tasks domain.',
        source: 'dialectic:ses_1',
      }),
    );
    await upsertUserProfileTrait(
      db,
      trait('payout-hold', {
        traitValue: 'payout held until banking change ships',
        source: 'dialectic:ses_2',
      }),
    );
    await upsertUserProfileTrait(
      db,
      trait('prefers-zero-deps', { traitValue: '"true"', scope: 'user' }),
    );
  }

  it('dry-run reports receipts and unknown-origin rows without touching anything', async () => {
    const { db } = await openGlobal();
    await seed(db);
    const result = await pruneReceiptTraits(db);
    expect(result.applied).toBe(false);
    expect(result.before).toBe(3);
    expect(result.after).toBe(3);
    expect(result.candidateKeys).toEqual(['succeeded-in-tasks-domain']);
    expect(result.unknownOriginRetained).toBe(1);
    expect(result.backupPath).toBeUndefined();

    const wide = await pruneReceiptTraits(db, { includeEnvelopeDerived: true });
    expect(wide.candidateKeys).toEqual(['payout-hold', 'succeeded-in-tasks-domain']);
    expect(wide.byRule['operation-envelope']).toBe(1);
    expect(wide.unknownOriginRetained).toBe(0);
    expect((await listUserProfile(db)).length).toBe(3);
  }, 30_000);

  it('apply writes the backup first, deletes, and restore reverses it', async () => {
    const { db } = await openGlobal();
    await seed(db);
    const backupDir = join(root, 'backups');
    const receipt = await pruneReceiptTraits(db, {
      apply: true,
      includeEnvelopeDerived: true,
      backupDir,
    });
    expect(receipt.applied).toBe(true);
    expect(receipt.removedKeys).toEqual(['payout-hold', 'succeeded-in-tasks-domain']);
    expect(receipt.changedSkipped).toEqual([]);
    expect(receipt.after).toBe(1);
    expect(receipt.backupPath && existsSync(receipt.backupPath)).toBe(true);
    const backup = JSON.parse(readFileSync(receipt.backupPath as string, 'utf8')) as {
      traits: UserProfileTrait[];
    };
    expect(backup.traits.map((t) => t.traitKey)).toEqual([
      'payout-hold',
      'succeeded-in-tasks-domain',
    ]);
    expect(receipt.restoreCommand).toContain('--restore');
    expect((await listUserProfile(db)).map((t) => t.traitKey)).toEqual(['prefers-zero-deps']);

    const restored = await restorePrunedTraits(db, receipt.backupPath as string);
    expect(restored.backupSha256).toBe(receipt.backupSha256);
    expect([...restored.restoredKeys].sort()).toEqual(['payout-hold', 'succeeded-in-tasks-domain']);
    const back = await getUserProfileTrait(db, 'payout-hold');
    expect(back?.traitValue).toBe('payout held until banking change ships');
    expect(back?.source).toBe('dialectic:ses_2');
    expect(back?.projectId).toBeNull();

    // A second restore never overwrites.
    const again = await restorePrunedTraits(db, receipt.backupPath as string);
    expect(again.restoredKeys).toEqual([]);
    expect(again.skippedExisting.length).toBe(2);
  }, 30_000);
});
