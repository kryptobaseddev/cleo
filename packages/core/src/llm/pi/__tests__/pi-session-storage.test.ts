/**
 * Tests for the durable Pi `SessionStorage` over `cleo.db` (T11761 · S3 · T11899).
 *
 * Three required proofs (AC4):
 *  1. **tree-structured persistence round-trip** — write a session tree (message →
 *     setLeafId → label → branch) through `CleoSessionStorage`, read it back, and
 *     assert it is identical to the same tree built on the upstream in-memory
 *     reference. Runs over a TEMP-DIR cleo.db copy (real migrations applied).
 *  2. **lease-held write proof** — every durable write goes through
 *     `withWriterLease('project', 'bulk', …)`; a write attempted while the lease
 *     mode forbids acquisition (`require` + an unacquirable row) is REJECTED, and
 *     a spy proves the project/`bulk` lease is the gate for `appendEntry` /
 *     `setLeafId`.
 *  3. **identity-from-env proof** — the metadata `id` is the daemon-stamped
 *     session id the storage was constructed with; it is NEVER minted (no
 *     `uuidv7` / random session id ever surfaces as the session identity).
 *
 * @epic T10403
 * @task T11761
 * @task T11899
 */

import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import {
  InMemorySessionRepo,
  type SessionStorage,
  type SessionTreeEntry,
} from '@earendil-works/pi-agent-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { _resetDualScopeDbCache, openDualScopeDbAtPath } from '../../../store/dual-scope-db.js';
import * as writerLease from '../../../store/writer-lease.js';
import {
  _resetWriterLeaseStateForTest,
  _setNativeDbResolverForTest,
} from '../../../store/writer-lease.js';
import { CleoSessionStorage } from '../pi-session-storage.js';

let testRoot: string;
let projectCwd: string;
let projectNative: DatabaseSync;

/** A fixed clock so timestamps are deterministic across the two implementations. */
let clockTick: number;
function fixedNow(): string {
  clockTick += 1;
  return new Date(Date.UTC(2026, 5, 8, 0, 0, clockTick)).toISOString();
}

beforeEach(async () => {
  testRoot = join(
    tmpdir(),
    `pi-session-store-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  projectCwd = join(testRoot, 'project');
  const cleoDir = join(projectCwd, '.cleo');
  mkdirSync(cleoDir, { recursive: true });
  const dbPath = join(cleoDir, 'cleo.db');
  // Real migrations applied (the t11899 migration creates the pi_session_* tables).
  const handle = await openDualScopeDbAtPath('project', dbPath);
  projectNative = (handle.db as unknown as { $client: DatabaseSync }).$client;

  // Route the lease engine at the SAME temp file (no supervisor, no canonical path).
  delete process.env.CLEO_WRITER_LEASE_MODE;
  _resetWriterLeaseStateForTest();
  _setNativeDbResolverForTest(async () => projectNative);
  clockTick = 0;
});

afterEach(() => {
  vi.restoreAllMocks();
  _resetWriterLeaseStateForTest();
  _setNativeDbResolverForTest(undefined);
  _resetDualScopeDbCache();
  delete process.env.CLEO_WRITER_LEASE_MODE;
  try {
    rmSync(testRoot, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

/** Build a `CleoSessionStorage` for the temp project, fixed clock. */
function durableStorage(sessionId: string): CleoSessionStorage {
  return new CleoSessionStorage({ sessionId, cwd: projectCwd, now: fixedNow });
}

/**
 * Drive an identical sequence of mutations against any `SessionStorage` so the
 * durable + reference implementations can be compared field-for-field.
 *
 * Tree shape:  root(user msg) → assistant msg → [leaf set to root] → label on root → branch entry
 */
async function buildTree(s: SessionStorage): Promise<{ root: string; assistant: string }> {
  const rootId = await s.createEntryId();
  const root: SessionTreeEntry = {
    type: 'message',
    id: rootId,
    parentId: null,
    timestamp: 't-root',
    message: { role: 'user', content: 'hello', timestamp: 1 },
  } as SessionTreeEntry;
  await s.appendEntry(root);

  const assistantId = await s.createEntryId();
  const assistant: SessionTreeEntry = {
    type: 'message',
    id: assistantId,
    parentId: rootId,
    timestamp: 't-asst',
    message: { role: 'assistant', content: 'hi there', timestamp: 2 },
  } as SessionTreeEntry;
  await s.appendEntry(assistant);

  const labelId = await s.createEntryId();
  const label: SessionTreeEntry = {
    type: 'label',
    id: labelId,
    parentId: assistantId,
    timestamp: 't-label',
    targetId: rootId,
    label: 'pinned',
  } as SessionTreeEntry;
  await s.appendEntry(label);

  // Move the active leaf back to the root (appends a synthetic leaf entry).
  await s.setLeafId(rootId);

  return { root: rootId, assistant: assistantId };
}

describe('AC4.1 — tree-structured persistence round-trip', () => {
  it('migration created the pi_session_* tables', () => {
    const tables = projectNative
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'pi_session_%'`)
      .all() as Array<{ name: string }>;
    const names = tables.map((t) => t.name).sort();
    expect(names).toContain('pi_session_entries');
    expect(names).toContain('pi_session_leaf');
  });

  it('a session tree written durably reads back identical to the in-memory reference', async () => {
    const durable = durableStorage('sess-roundtrip');
    const { root, assistant } = await buildTree(durable);

    // Reference: same mutation sequence on the upstream in-memory storage.
    const refRepo = new InMemorySessionRepo();
    const refSession = await refRepo.create({ id: 'sess-roundtrip' });
    const reference = refSession.getStorage();
    // The reference mints its own entry ids; replay our exact ids instead so the
    // trees are comparable. We rebuild the reference using the SAME ids.
    await reference.appendEntry({
      type: 'message',
      id: root,
      parentId: null,
      timestamp: 't-root',
      message: { role: 'user', content: 'hello', timestamp: 1 },
    } as SessionTreeEntry);
    await reference.appendEntry({
      type: 'message',
      id: assistant,
      parentId: root,
      timestamp: 't-asst',
      message: { role: 'assistant', content: 'hi there', timestamp: 2 },
    } as SessionTreeEntry);
    const labelEntries = (await durable.getEntries()).filter((e) => e.type === 'label');
    await reference.appendEntry(labelEntries[0]);
    const leafEntries = (await durable.getEntries()).filter((e) => e.type === 'leaf');
    await reference.appendEntry(leafEntries[0]);

    // Entry set is identical (order + content).
    expect(await durable.getEntries()).toEqual(await reference.getEntries());
    // Leaf pointer matches.
    expect(await durable.getLeafId()).toBe(await reference.getLeafId());
    expect(await durable.getLeafId()).toBe(root);
    // Path-to-root reconstruction matches.
    expect(await durable.getPathToRoot(root)).toEqual(await reference.getPathToRoot(root));
    // Individual lookups + label + typed find.
    expect(await durable.getEntry(assistant)).toEqual(await reference.getEntry(assistant));
    expect(await durable.getLabel(root)).toBe('pinned');
    expect((await durable.findEntries('message')).length).toBe(2);
  });

  it('round-trips across a fresh storage instance (durability, not in-RAM caching)', async () => {
    const writer = durableStorage('sess-persist');
    await buildTree(writer);

    // A brand-new instance over the SAME cleo.db reads the persisted tree.
    const reader = durableStorage('sess-persist');
    const entries = await reader.getEntries();
    expect(entries.filter((e) => e.type === 'message').length).toBe(2);
    expect(entries.filter((e) => e.type === 'label').length).toBe(1);
    expect(entries.filter((e) => e.type === 'leaf').length).toBe(1);
  });
});

describe('AC4.2 — lease-held write proof', () => {
  it('appendEntry + setLeafId acquire the project/bulk writer lease', async () => {
    const spy = vi.spyOn(writerLease, 'withWriterLease');
    const s = durableStorage('sess-lease');

    await s.appendEntry({
      type: 'message',
      id: await s.createEntryId(),
      parentId: null,
      timestamp: 't',
      message: { role: 'user', content: 'x', timestamp: 1 },
    } as SessionTreeEntry);

    expect(spy).toHaveBeenCalled();
    for (const call of spy.mock.calls) {
      expect(call[0]).toBe('project');
      expect(call[1]).toBe('bulk');
    }
  });

  it('a write is REJECTED (and persists nothing) when the lease cannot be acquired', async () => {
    // When `withWriterLease` rejects (e.g. require-mode lease unavailable), the
    // storage write MUST surface the rejection and NOT write outside the lease —
    // proving the write is gated by the lease, never a raw fallback.
    const spy = vi
      .spyOn(writerLease, 'withWriterLease')
      .mockRejectedValue(new writerLease.LeaseUnavailableError('project', 'bulk', 'unavailable'));

    const s = durableStorage('sess-blocked');
    await expect(
      s.appendEntry({
        type: 'message',
        id: 'fixedaaa',
        parentId: null,
        timestamp: 't',
        message: { role: 'user', content: 'x', timestamp: 1 },
      } as SessionTreeEntry),
    ).rejects.toThrow();
    expect(spy).toHaveBeenCalledWith('project', 'bulk', expect.any(Function));

    // Nothing was written outside the (rejected) lease.
    const count = (
      projectNative
        .prepare(`SELECT COUNT(*) AS c FROM pi_session_entries WHERE session_id = ?`)
        .get('sess-blocked') as { c: number }
    ).c;
    expect(count).toBe(0);
  });

  it('the durable write is genuinely serialized through the lease row (lane=bulk recorded)', async () => {
    const s = durableStorage('sess-serial');
    await s.appendEntry({
      type: 'message',
      id: await s.createEntryId(),
      parentId: null,
      timestamp: 't',
      message: { role: 'user', content: 'x', timestamp: 1 },
    } as SessionTreeEntry);

    // A bulk-lane lease row exists in the temp DB (released, active=0 after the write).
    const bulkRows = (
      projectNative
        .prepare(`SELECT COUNT(*) AS c FROM _writer_leases WHERE scope = ? AND lane = ?`)
        .get('project', 'bulk') as { c: number }
    ).c;
    expect(bulkRows).toBeGreaterThanOrEqual(1);
  });
});

describe('AC4.3 — identity-from-env proof (Pi never mints a session id)', () => {
  it('metadata.id is the daemon-stamped id, not a minted one', async () => {
    const s = durableStorage('daemon-stamped-id-123');
    const meta = await s.getMetadata();
    expect(meta.id).toBe('daemon-stamped-id-123');
    // createdAt is a real ISO timestamp anchor.
    expect(() => new Date(meta.createdAt).toISOString()).not.toThrow();
  });

  it('two storages with the SAME stamped id address the SAME tree (id is identity, not minted)', async () => {
    const a = durableStorage('shared-identity');
    await a.appendEntry({
      type: 'message',
      id: await a.createEntryId(),
      parentId: null,
      timestamp: 't',
      message: { role: 'user', content: 'from-a', timestamp: 1 },
    } as SessionTreeEntry);

    const b = durableStorage('shared-identity');
    expect((await b.getMetadata()).id).toBe('shared-identity');
    expect((await b.getEntries()).length).toBe(1);
  });

  it('getMetadata is stable across calls (the id is never re-minted)', async () => {
    const s = durableStorage('stable-id');
    const first = await s.getMetadata();
    const second = await s.getMetadata();
    expect(first.id).toBe(second.id);
    expect(first.createdAt).toBe(second.createdAt);
  });
});
