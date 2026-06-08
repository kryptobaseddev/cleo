/**
 * `CleoSessionStorage` — durable Pi `SessionStorage` over `cleo.db` (T11761 · S3 · T11899).
 *
 * The flag-ON, durable half of the Pi session-persistence seam. It implements
 * Pi's tree-structured `SessionStorage` interface
 * (`@earendil-works/pi-agent-core`) over the PROJECT-scope consolidated
 * `cleo.db`, with ZERO write authority:
 *
 *  - **All durable writes go through {@link withWriterLease}** (`writer-lease.ts`,
 *    PROJECT scope + `bulk` lane) — the daemon remains the sole arbitrated
 *    Drizzle writer. This adapter NEVER opens a raw DB writer (Gate 3): it calls
 *    the store-layer accessor ({@link import('../../store/pi-session-store.js')}),
 *    which extracts the native handle the chokepoint already holds.
 *  - **Identity is daemon-stamped, never minted.** The owning `sessionId` is
 *    supplied at construction from `resolveCurrentSessionId` / `CLEO_SESSION_ID`
 *    (resolved in `pi-agent-adapter.ts`). Unlike `InMemorySessionStorage`, this
 *    storage NEVER calls `uuidv7()` to mint an id.
 *
 * {@link InMemorySessionStorage} (from `pi-agent-core`) remains the flag-OFF
 * default that the S2 adapter body uses; this durable storage activates only when
 * the Pi-runner flag is enabled AND a durable session is requested.
 *
 * The tree semantics mirror the upstream `InMemorySessionStorage` reference
 * (memory-storage.ts) byte-for-byte — `appendEntry` advances the leaf via
 * `leafIdAfterEntry`, `setLeafId` appends a synthetic `leaf` entry, label-cache
 * and `getPathToRoot` walk parent chains — so a session tree written here reads
 * back identical to the in-memory implementation. The ONLY difference is the
 * backing store (durable cleo.db rows vs in-RAM arrays) and the lease boundary.
 *
 * @module
 * @task T11899
 * @task T11761
 * @epic T10403
 */

import { randomUUID } from 'node:crypto';
import type {
  SessionMetadata,
  SessionStorage,
  SessionTreeEntry,
} from '@earendil-works/pi-agent-core';
import { SessionError } from '@earendil-works/pi-agent-core';
import { getLogger } from '../../logger.js';
import {
  getPiSessionNativeDb,
  insertPiSessionEntry,
  type PiSessionEntryRow,
  readPiSessionEntries,
  readPiSessionEntry,
  readPiSessionLeaf,
  upsertPiSessionLeaf,
} from '../../store/pi-session-store.js';
import { withWriterLease } from '../../store/writer-lease.js';

/**
 * Lazily-memoized module logger (import-time side-effect-free per the page-2 /
 * mocked-import-graph invariant — see `writer-lease.ts` rationale).
 */
let _log: ReturnType<typeof getLogger> | null = null;
function log(): ReturnType<typeof getLogger> {
  if (_log === null) _log = getLogger('pi-session-storage');
  return _log;
}

/**
 * Construction options for {@link CleoSessionStorage}.
 */
export interface CleoSessionStorageOptions {
  /**
   * The daemon-stamped owning session id. MUST be a real, env-resolved id —
   * never a freshly-minted one. The S2 adapter reads it from
   * `resolveCurrentSessionId` / `CLEO_SESSION_ID` and passes it here.
   */
  readonly sessionId: string;
  /**
   * Project working directory for `cleo.db` resolution. Defaults to `cwd` inside
   * the store accessor.
   */
  readonly cwd?: string;
  /**
   * Wall-clock provider (injectable for deterministic tests). Defaults to
   * `() => new Date().toISOString()`.
   */
  readonly now?: () => string;
}

/**
 * Generate a fresh 8-char entry id NOT already present in `existing`.
 *
 * Mirrors the upstream `generateEntryId` (memory-storage.ts): up to 100 attempts
 * at an 8-char `uuidv7` prefix, falling back to a full id. We avoid importing
 * Pi's internal `uuidv7` (not a barrel export) and use `node:crypto`'s
 * `randomUUID()` —
 * the id is an opaque tree-node handle, NOT a session identity (which is always
 * daemon-stamped), so its generator is irrelevant to the identity contract.
 *
 * @param existing - The set of ids already in use for this session.
 * @returns A fresh unused entry id.
 */
function generateEntryId(existing: ReadonlySet<string>): string {
  for (let i = 0; i < 100; i++) {
    const id = randomUUID().replace(/-/g, '').slice(0, 8);
    if (!existing.has(id)) return id;
  }
  return randomUUID();
}

/**
 * Columnized fields hoisted out of a {@link SessionTreeEntry} into dedicated
 * columns; the remainder is JSON-serialized into `payload_json`.
 */
const COLUMNIZED_KEYS = ['id', 'parentId', 'type', 'timestamp'] as const;

/** Split a Pi entry into its columnized fields + JSON residue. */
function encodeEntry(sessionId: string, entry: SessionTreeEntry): Omit<PiSessionEntryRow, 'seq'> {
  const residue: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(entry)) {
    if (!(COLUMNIZED_KEYS as readonly string[]).includes(key)) residue[key] = value;
  }
  return {
    sessionId,
    entryId: entry.id,
    parentId: entry.parentId,
    type: entry.type,
    payloadJson: JSON.stringify(residue),
    ts: entry.timestamp,
  };
}

/** Re-hydrate a full Pi entry by merging columns back over the JSON residue. */
function decodeEntry(row: PiSessionEntryRow): SessionTreeEntry {
  const residue = JSON.parse(row.payloadJson) as Record<string, unknown>;
  return {
    ...residue,
    id: row.entryId,
    parentId: row.parentId,
    type: row.type,
    timestamp: row.ts,
  } as SessionTreeEntry;
}

/** The leaf id an entry establishes (leaf entries point at `targetId`; others at own id). */
function leafIdAfterEntry(entry: SessionTreeEntry): string | null {
  return entry.type === 'leaf' ? entry.targetId : entry.id;
}

/**
 * Durable Pi `SessionStorage` backed by the PROJECT-scope `cleo.db`.
 *
 * Every mutating method ({@link appendEntry}, {@link setLeafId}) runs its write
 * inside `withWriterLease('project', 'bulk', …)`; read methods operate directly
 * on the shared native handle (no lease — readers do not contend the writer
 * arbitration row). The session id is fixed at construction and never minted.
 */
export class CleoSessionStorage implements SessionStorage {
  readonly #sessionId: string;
  readonly #cwd: string | undefined;
  readonly #now: () => string;

  /**
   * @param options - The daemon-stamped session id + optional cwd / clock.
   */
  constructor(options: CleoSessionStorageOptions) {
    this.#sessionId = options.sessionId;
    this.#cwd = options.cwd;
    this.#now = options.now ?? (() => new Date().toISOString());
  }

  /**
   * Return the session metadata. The `id` is ALWAYS the daemon-stamped id this
   * storage was constructed with (never minted); `createdAt` is the persisted
   * leaf-row anchor, lazily created on first read so a never-written session
   * still yields stable metadata.
   *
   * @returns The session metadata.
   */
  async getMetadata(): Promise<SessionMetadata> {
    const native = await getPiSessionNativeDb(this.#cwd);
    const leaf = readPiSessionLeaf(native, this.#sessionId);
    if (leaf) return { id: this.#sessionId, createdAt: leaf.createdAt };
    // No row yet — establish the createdAt anchor durably (leaf stays null).
    const ts = this.#now();
    await this.#leasedWrite((db) => upsertPiSessionLeaf(db, this.#sessionId, null, ts, ts));
    return { id: this.#sessionId, createdAt: ts };
  }

  /**
   * Return the active leaf id, or `null` when none is set.
   *
   * @returns The leaf id or `null`.
   * @throws {SessionError} `invalid_session` when the recorded leaf entry is missing.
   */
  async getLeafId(): Promise<string | null> {
    const native = await getPiSessionNativeDb(this.#cwd);
    const leaf = readPiSessionLeaf(native, this.#sessionId);
    const leafId = leaf?.leafId ?? null;
    if (leafId !== null && readPiSessionEntry(native, this.#sessionId, leafId) === null) {
      throw new SessionError('invalid_session', `Entry ${leafId} not found`);
    }
    return leafId;
  }

  /**
   * Persist a leaf entry that records the active session-tree leaf.
   *
   * Mirrors the upstream reference: appends a synthetic `leaf` entry (parented at
   * the current leaf) THEN advances the leaf pointer to `leafId`. The whole
   * mutation runs inside ONE leased section.
   *
   * @param leafId - The new active leaf entry id, or `null` to reset to root.
   * @throws {SessionError} `not_found` when `leafId` names no existing entry.
   */
  async setLeafId(leafId: string | null): Promise<void> {
    await this.#leasedWrite((native) => {
      if (leafId !== null && readPiSessionEntry(native, this.#sessionId, leafId) === null) {
        throw new SessionError('not_found', `Entry ${leafId} not found`);
      }
      const ids = this.#entryIdSet(native);
      const currentLeaf = readPiSessionLeaf(native, this.#sessionId);
      const ts = this.#now();
      const synthetic: SessionTreeEntry = {
        type: 'leaf',
        id: generateEntryId(ids),
        parentId: currentLeaf?.leafId ?? null,
        timestamp: ts,
        targetId: leafId,
      };
      insertPiSessionEntry(native, encodeEntry(this.#sessionId, synthetic));
      upsertPiSessionLeaf(native, this.#sessionId, leafId, currentLeaf?.createdAt ?? ts, ts);
    });
  }

  /**
   * Allocate a fresh, unused entry id for this session.
   *
   * Read-only (no persistence until {@link appendEntry}) — matches the upstream
   * `createEntryId`.
   *
   * @returns A fresh unused entry id.
   */
  async createEntryId(): Promise<string> {
    const native = await getPiSessionNativeDb(this.#cwd);
    return generateEntryId(this.#entryIdSet(native));
  }

  /**
   * Append a tree entry and advance the leaf pointer (leased write).
   *
   * @param entry - The entry to persist.
   */
  async appendEntry(entry: SessionTreeEntry): Promise<void> {
    await this.#leasedWrite((native) => {
      insertPiSessionEntry(native, encodeEntry(this.#sessionId, entry));
      const existing = readPiSessionLeaf(native, this.#sessionId);
      const ts = this.#now();
      upsertPiSessionLeaf(
        native,
        this.#sessionId,
        leafIdAfterEntry(entry),
        existing?.createdAt ?? ts,
        ts,
      );
    });
  }

  /**
   * Return an entry by id, or `undefined` when absent.
   *
   * @param id - The entry id.
   * @returns The entry or `undefined`.
   */
  async getEntry(id: string): Promise<SessionTreeEntry | undefined> {
    const native = await getPiSessionNativeDb(this.#cwd);
    const row = readPiSessionEntry(native, this.#sessionId, id);
    return row === null ? undefined : decodeEntry(row);
  }

  /**
   * Return all entries of a given type in append order.
   *
   * @param type - The entry-type discriminator to filter on.
   * @returns The matching entries.
   */
  async findEntries<TType extends SessionTreeEntry['type']>(
    type: TType,
  ): Promise<Array<Extract<SessionTreeEntry, { type: TType }>>> {
    const entries = await this.getEntries();
    return entries.filter((e) => e.type === type) as Array<
      Extract<SessionTreeEntry, { type: TType }>
    >;
  }

  /**
   * Return the most-recent label applied to an entry, or `undefined`.
   *
   * Computed from the `label` entries (last write wins; an empty label clears),
   * mirroring the upstream label cache.
   *
   * @param id - The target entry id.
   * @returns The label or `undefined`.
   */
  async getLabel(id: string): Promise<string | undefined> {
    const entries = await this.getEntries();
    let label: string | undefined;
    for (const entry of entries) {
      if (entry.type !== 'label' || entry.targetId !== id) continue;
      const trimmed = entry.label?.trim();
      label = trimmed ? trimmed : undefined;
    }
    return label;
  }

  /**
   * Walk from a leaf to the root, returning the path in root→leaf order.
   *
   * @param leafId - The leaf to walk from, or `null` for an empty path.
   * @returns The root→leaf entry path.
   * @throws {SessionError} `not_found` / `invalid_session` on a broken chain.
   */
  async getPathToRoot(leafId: string | null): Promise<SessionTreeEntry[]> {
    if (leafId === null) return [];
    const native = await getPiSessionNativeDb(this.#cwd);
    const byId = new Map<string, SessionTreeEntry>(
      readPiSessionEntries(native, this.#sessionId).map((r) => {
        const entry = decodeEntry(r);
        return [entry.id, entry];
      }),
    );
    const path: SessionTreeEntry[] = [];
    let current = byId.get(leafId);
    if (!current) throw new SessionError('not_found', `Entry ${leafId} not found`);
    while (current) {
      path.unshift(current);
      if (!current.parentId) break;
      const parent = byId.get(current.parentId);
      if (!parent) {
        throw new SessionError('invalid_session', `Entry ${current.parentId} not found`);
      }
      current = parent;
    }
    return path;
  }

  /**
   * Return all entries for this session in stable append order.
   *
   * @returns The ordered entries.
   */
  async getEntries(): Promise<SessionTreeEntry[]> {
    const native = await getPiSessionNativeDb(this.#cwd);
    return readPiSessionEntries(native, this.#sessionId).map(decodeEntry);
  }

  /** The set of entry ids already in use for this session (collision avoidance). */
  #entryIdSet(native: Awaited<ReturnType<typeof getPiSessionNativeDb>>): Set<string> {
    return new Set(readPiSessionEntries(native, this.#sessionId).map((r) => r.entryId));
  }

  /**
   * Run `fn` against the native handle while holding the PROJECT/`bulk` writer
   * lease — the ONLY durable-write path. The daemon stays the sole arbitrated
   * writer; the adapter never opens a raw writer (Gate 3).
   *
   * @param fn - The synchronous write body to run under the lease.
   */
  async #leasedWrite(
    fn: (native: Awaited<ReturnType<typeof getPiSessionNativeDb>>) => void,
  ): Promise<void> {
    const native = await getPiSessionNativeDb(this.#cwd);
    await withWriterLease('project', 'bulk', async () => {
      fn(native);
    });
    log().debug({ sessionId: this.#sessionId }, 'pi session leased write committed');
  }
}
