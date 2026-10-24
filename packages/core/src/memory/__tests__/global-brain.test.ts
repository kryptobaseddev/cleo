/**
 * The main brain write and read paths (T13720): `memory observe` and
 * `memory decision-store` with `scope: 'global'` write the GLOBAL store in a
 * capture frame; project `memory find`, `memory fetch` and the briefing list
 * global entries beside project ones, tagged `scope: 'global'`.
 *
 * @task T13720
 */

import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { BrainCompactHit, FetchedBrainEntry } from '@cleocode/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { computeBriefing } from '../../sessions/briefing.js';
import {
  _resetDualScopeDbCache,
  getDualScopeNativeDb,
  openDualScopeDb,
} from '../../store/dual-scope-db.js';
import { closeBrainDb } from '../../store/memory-sqlite.js';
import { setCaptureEnabled } from '../../store/sync/capture.js';
import { memoryDecisionStore, memoryFetch, memoryFind, memoryObserve } from '../engine-compat.js';

vi.setConfig({ testTimeout: 30_000 });

const SYNC_SCHEMA = resolve(import.meta.dirname, '../../../migrations/sync-journal');
let dir: string;
let project: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cleo-global-brain-'));
  project = join(dir, 'project');
  mkdirSync(join(project, '.cleo'), { recursive: true });
  mkdirSync(join(dir, 'home'), { recursive: true });
  vi.stubEnv('CLEO_HOME', join(dir, 'home'));
  vi.stubEnv('CLEO_DIR', join(project, '.cleo'));
  vi.stubEnv('CLEO_ROOT', project);
});

afterEach(() => {
  closeBrainDb();
  _resetDualScopeDbCache();
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

const globalDb = async () => getDualScopeNativeDb(await openDualScopeDb('global'));

describe('main brain (global store) memory (T13720)', () => {
  it('observe --scope global writes the global store in one capture frame, with a row uid', async () => {
    setCaptureEnabled(await globalDb(), 'global', true, { schemaRoot: SYNC_SCHEMA });
    const res = await memoryObserve({
      text: 'zebra facts live in the main brain',
      scope: 'global',
    });
    expect(res.success).toBe(true);
    const { id, scope } = res.data as { id: string; scope: string };
    expect(scope).toBe('global');
    // Random suffix, never clock-derived: two devices in one millisecond must not collide.
    expect(id).toMatch(/^O-[0-9a-f]{8}$/);

    const db = await globalDb();
    const row = db.prepare('SELECT uid, narrative FROM brain_observations WHERE id = ?').get(id) as
      | { uid: string | null; narrative: string }
      | undefined;
    expect(row?.narrative).toBe('zebra facts live in the main brain');
    expect(row?.uid).toBeTruthy();
    const captures = db
      .prepare("SELECT frame, kind FROM _sync_capture WHERE tbl = 'brain_observations'")
      .all() as Array<{ frame: string | null; kind: string | null }>;
    expect(captures).toHaveLength(1);
    expect(captures[0]?.frame).toBeTruthy();
    expect(captures[0]?.kind).toBe('write');

    // Never in the project store.
    const projectDb = getDualScopeNativeDb(await openDualScopeDb('project', project));
    expect(projectDb.prepare('SELECT id FROM brain_observations WHERE id = ?').get(id)).toBe(
      undefined,
    );
  });

  it('a lesson defaults to the main brain and is stored once (T13949)', async () => {
    const lesson = {
      text: 'cancel destroys the worktree named by the task id',
      title: 'One task per worktree directory',
      type: 'lesson',
    };
    const first = await memoryObserve(lesson, project);
    expect(first.success).toBe(true);
    expect(first.data).toMatchObject({ scope: 'global' });
    expect((first.data as { stored?: boolean }).stored).toBeUndefined();
    const firstId = (first.data as { id: string }).id;

    // Same text again: nothing new is written; the existing id comes back.
    const again = await memoryObserve(lesson, project);
    expect(again.data).toMatchObject({ id: firstId, stored: false, gateAction: 'merged' });
    const db = await globalDb();
    expect(db.prepare("SELECT id FROM brain_observations WHERE type = 'lesson'").all()).toEqual([
      { id: firstId },
    ]);

    const noRule = await memoryObserve({ text: 'why', type: 'lesson' }, project);
    expect(noRule.error?.code).toBe('E_INVALID_INPUT');
  });

  it('find and fetch return global entries beside project ones, tagged scope global', async () => {
    const local = await memoryObserve({ text: 'zebra notes for this project' }, project);
    expect(local.success).toBe(true);
    const global = await memoryObserve({ text: 'zebra notes for every project', scope: 'global' });
    const globalId = (global.data as { id: string }).id;
    const localId = (local.data as { id: string }).id;

    const found = await memoryFind({ query: 'zebra' }, project);
    expect(found.success).toBe(true);
    const hits = (found.data as { results: BrainCompactHit[] }).results;
    expect(hits.find((h) => h.id === localId)?.scope).toBeUndefined();
    expect(hits.find((h) => h.id === globalId)).toMatchObject({
      type: 'observation',
      scope: 'global',
    });

    const fetched = await memoryFetch({ ids: [globalId] }, project);
    const data = fetched.data as { results: FetchedBrainEntry[]; notFound: string[] };
    expect(data.notFound).toEqual([]);
    expect(data.results).toEqual([
      expect.objectContaining({ id: globalId, type: 'observation', scope: 'global' }),
    ]);
    // Same row shape as project fetch: camelCase keys, boolean verified.
    expect(data.results[0]?.data).toMatchObject({
      sourceType: 'manual',
      createdAt: expect.any(String),
      verified: true,
    });
    expect(data.results[0]?.data).not.toHaveProperty('source_type');
  });

  it('a LIKE wildcard in the query matches literally', async () => {
    await memoryObserve({ text: 'coverage reached 100% today', scope: 'global' });
    await memoryObserve({ text: 'coverage reached 1000 lines', scope: 'global' });
    const found = await memoryFind({ query: '100%', tables: ['observations'] }, project);
    const titles = (found.data as { results: BrainCompactHit[] }).results
      .filter((h) => h.scope === 'global')
      .map((h) => h.title);
    expect(titles).toEqual(['coverage reached 100% today']);
  });

  it('an accepted global decision is current guidance in the project briefing', async () => {
    const res = await memoryDecisionStore({
      decision: 'Prefer pnpm in every repo',
      rationale: 'one lockfile format everywhere',
      confirmationState: 'accepted',
      scope: 'global',
    });
    expect(res.success).toBe(true);
    const { id } = res.data as { id: string };
    expect(id).toBe('D001');
    const briefing = await computeBriefing(project, {});
    expect(briefing.currentGuidance).toContainEqual(
      expect.objectContaining({ id, type: 'decision', scope: 'global' }),
    );
  });

  it('rejects an unknown scope and project-only links with --scope global', async () => {
    const bad = await memoryObserve({ text: 'x', scope: 'galaxy' });
    expect(bad.error?.code).toBe('E_INVALID_INPUT');
    const linked = await memoryDecisionStore({
      decision: 'd',
      rationale: 'r',
      taskId: 'T1',
      scope: 'global',
    });
    expect(linked.error?.code).toBe('E_INVALID_INPUT');
  });
});
