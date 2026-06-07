/**
 * Tests for the GLOBAL `session_manifest` mirror writers (EP-SESSION-MANIFEST ·
 * epic T11638 · task T11639).
 *
 * Coverage (the four ACs):
 *   1. ensureGlobalSignaldockDb is idempotent — repeated calls return the SAME
 *      shared GLOBAL handle and the `session_manifest` table exists (NOT `sessions`).
 *   2. Mirror write on start + end — mirroring an authoritative session writes/updates
 *      the manifest row (status/endedAt reflect the close).
 *   3. Mirror failure does NOT fail the session op — a forced write failure is
 *      swallowed (the public writer resolves, never throws).
 *   4. parentSessionId is persisted from CLEO_PARENT_SESSION_ID onto the project row
 *      AND mirrored into the manifest.
 *   5. Reconcile-on-start OVERWRITES a stale manifest row from the authoritative
 *      project row — the manifest can never drift into authority (AC4).
 *
 * Every test runs against a TEMP-DIR project `.cleo/cleo.db` and a TEMP-DIR global
 * `cleo.db` (CLEO_HOME override) — never the real fleet.
 *
 * @task T11639
 * @epic T11638
 * @saga T11242
 */

import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Session } from '@cleocode/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createSession } from '../../store/session-store.js';
import { startSession } from '../index.js';
import {
  ensureGlobalSignaldockDb,
  mirrorSessionToManifest,
  readSessionManifestRow,
  reconcileSessionManifestOnStart,
} from '../session-manifest-mirror.js';

let testRoot: string;
let projectDir: string;
let globalDir: string;

beforeEach(() => {
  testRoot = join(
    tmpdir(),
    `session-manifest-mirror-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  projectDir = join(testRoot, 'project');
  mkdirSync(join(projectDir, '.cleo'), { recursive: true });
  // CLEO_HOME must end in 'cleo' so the GLOBAL db path resolves to <CLEO_HOME>/cleo.db.
  globalDir = join(testRoot, 'cleo');
  mkdirSync(globalDir, { recursive: true });
  process.env.CLEO_HOME = globalDir;
  delete process.env.CLEO_PARENT_SESSION_ID;
  delete process.env.CLEO_WRITER_LEASE_MODE;
});

afterEach(async () => {
  // Reset BOTH dual-scope caches (project + global handles opened by these tests).
  const { _resetDualScopeDbCache } = await import('../../store/dual-scope-db.js');
  _resetDualScopeDbCache();
  const { _resetWriterLeaseStateForTest } = await import('../../store/writer-lease.js');
  _resetWriterLeaseStateForTest();
  delete process.env.CLEO_HOME;
  delete process.env.CLEO_PARENT_SESSION_ID;
  delete process.env.CLEO_WRITER_LEASE_MODE;
  try {
    rmSync(testRoot, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

/** Build a minimal authoritative Session for mirroring. */
function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: overrides.id ?? `ses_20260607120000_abc123`,
    name: overrides.name ?? 'test-session',
    status: overrides.status ?? 'active',
    scope: overrides.scope ?? { type: 'global' },
    startedAt: overrides.startedAt ?? new Date().toISOString(),
    ...overrides,
  };
}

describe('ensureGlobalSignaldockDb (AC1)', () => {
  it('is idempotent — repeated calls return the same shared GLOBAL handle', async () => {
    const h1 = await ensureGlobalSignaldockDb();
    const h2 = await ensureGlobalSignaldockDb();
    expect(h1).toBe(h2);
    expect(h1.scope).toBe('global');
  }, 30_000);

  it('ensures `session_manifest` exists and the table is NOT named `sessions`', async () => {
    const handle = await ensureGlobalSignaldockDb();
    // The `as any` cast is required because $client is typed as unknown on the generic db handle.
    const nativeDb = (handle.db as any).$client as import('node:sqlite').DatabaseSync;

    const manifest = nativeDb
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='session_manifest'")
      .get() as { name: string } | undefined;
    expect(manifest?.name).toBe('session_manifest');

    // AC1: the GLOBAL mirror MUST NOT be named `sessions`.
    const wrong = nativeDb
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='sessions'")
      .get() as { name: string } | undefined;
    expect(wrong).toBeUndefined();
  }, 30_000);
});

describe('mirrorSessionToManifest (AC3 — start + end)', () => {
  it('mirrors an active session, then reflects the ended status on a second mirror', async () => {
    const session = makeSession({ id: 'ses_20260607120001_aaa111', status: 'active' });

    await mirrorSessionToManifest(projectDir, session);
    const afterStart = await readSessionManifestRow(session.id);
    expect(afterStart).not.toBeNull();
    expect(afterStart?.sessionId).toBe(session.id);
    expect(afterStart?.status).toBe('active');
    expect(afterStart?.projectPath).toBe(projectDir);
    expect(afterStart?.endedAt).toBeNull();

    // Mirror the ENDED projection (status + endedAt updated).
    const endedAt = new Date().toISOString();
    await mirrorSessionToManifest(projectDir, { ...session, status: 'ended', endedAt });
    const afterEnd = await readSessionManifestRow(session.id);
    expect(afterEnd?.status).toBe('ended');
    expect(afterEnd?.endedAt).toBe(endedAt);
  }, 30_000);
});

describe('mirror failure does NOT fail the session op (AC3)', () => {
  it('swallows a write failure — the public writer resolves, never throws', async () => {
    // Force the GLOBAL open to throw deterministically: a NUL byte in the resolved
    // path makes node:fs mkdir/open throw synchronously (ERR_INVALID_ARG_VALUE),
    // exercising the mirror writer's best-effort catch WITHOUT any DB/lease spin.
    process.env.CLEO_HOME = join(testRoot, 'cleo\0bad');

    const session = makeSession({ id: 'ses_20260607120002_bbb222' });

    // MUST resolve (not reject) despite the underlying open/write failing.
    await expect(mirrorSessionToManifest(projectDir, session)).resolves.toBeUndefined();
    // And reconcile-on-start is equally best-effort under the same failure.
    await expect(reconcileSessionManifestOnStart(projectDir, session.id)).resolves.toBeUndefined();
  }, 15_000);
});

describe('parentSessionId persisted from env (AC2)', () => {
  it('startSession stamps CLEO_PARENT_SESSION_ID onto the project session row', async () => {
    const parentId = 'ses_20260607119999_par999';
    process.env.CLEO_PARENT_SESSION_ID = parentId;
    // Ensure the env-first resolver does not pick a different own-session id.
    delete process.env.CLEO_SESSION_ID;

    const session = await startSession(projectDir, { scope: 'global' });
    expect(session.parentSessionId).toBe(parentId);

    // Persisted on the authoritative project row.
    const { getSession } = await import('../../store/session-store.js');
    const persisted = await getSession(session.id, projectDir);
    expect(persisted?.parentSessionId).toBe(parentId);
  }, 30_000);

  it('mirrors parentSessionId into the manifest row', async () => {
    const parentId = 'ses_20260607119998_par998';
    const session = makeSession({
      id: 'ses_20260607120003_ccc333',
      parentSessionId: parentId,
    });
    await mirrorSessionToManifest(projectDir, session);
    const row = await readSessionManifestRow(session.id);
    expect(row?.parentSessionId).toBe(parentId);
  }, 30_000);
});

describe('reconcileSessionManifestOnStart OVERWRITES a stale manifest (AC4)', () => {
  it('re-reads the authoritative project row and overwrites a drifted manifest row', async () => {
    const sessionId = 'ses_20260607120004_ddd444';

    // 1. Seed the AUTHORITATIVE project row (status active, name "real").
    await createSession(
      makeSession({ id: sessionId, name: 'real-name', status: 'active' }),
      projectDir,
    );

    // 2. Plant a STALE/DRIFTED manifest row (wrong name + wrong status) directly.
    await mirrorSessionToManifest(
      projectDir,
      makeSession({ id: sessionId, name: 'STALE-name', status: 'ended' }),
    );
    const drifted = await readSessionManifestRow(sessionId);
    expect(drifted?.name).toBe('STALE-name');
    expect(drifted?.status).toBe('ended');

    // 3. Reconcile-on-start MUST overwrite the manifest from the authoritative row.
    await reconcileSessionManifestOnStart(projectDir, sessionId);
    const reconciled = await readSessionManifestRow(sessionId);
    expect(reconciled?.name).toBe('real-name');
    expect(reconciled?.status).toBe('active');
  }, 30_000);

  it('is a no-op when no authoritative project row exists (nothing to mirror)', async () => {
    const sessionId = 'ses_20260607120005_eee555';
    // No project row seeded. Reconcile must not throw and must not invent a row.
    await expect(reconcileSessionManifestOnStart(projectDir, sessionId)).resolves.toBeUndefined();
    const row = await readSessionManifestRow(sessionId);
    expect(row).toBeNull();
  }, 30_000);
});
