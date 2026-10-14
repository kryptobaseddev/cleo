/**
 * Local section lease manager — T13356 (Epic T13340 / Saga T13339 · spec
 * `cleodocs-rearch-design` §2 option b).
 *
 * ## Matched semantics
 *
 * llmtxt ships a `LeaseManager` concept (`dist/leases.js`, task T285) but
 * the `llmtxt/leases` subpath is missing from the package exports map
 * (upstream kryptobaseddev/llmtxt#16), and the class that IS reachable
 * through the main entry is a REST client (`baseUrl` + `apiKey` + `fetch`
 * against `/api/v1/documents/:slug/sections/:sid/lease`) — there is no
 * local server to call. T13356 AC1 therefore accepts this LOCAL lease
 * module with identical semantics, which mirrors the upstream contract:
 *
 * > "Leases are ADVISORY — the CRDT layer still accepts writes from
 * > non-holders. 409 is a social signal, not a hard lock." — llmtxt
 * > dist/leases.js (T285)
 *
 * - **Identity** — a lease is `{ leaseId, holder, expiresAt }` scoped to
 *   `(slug, sectionId)`, exactly llmtxt's `Lease` interface. This module
 *   adds `sessionId`/`acquiredAt`/`reason` (the session tie T13356
 *   requires; llmtxt's server held equivalent holder metadata).
 * - **Acquire** — `acquire(slug, sectionId, ttlSeconds, reason?)` with the
 *   TTL bounded to 1–300 s, llmtxt's documented `durationSeconds` range. A
 *   held, unexpired lease yields the 409 equivalent: a `LeaseConflict`
 *   naming `holder`/`expiresAt` (advisory result, not an error). The
 *   throwing variant's message matches llmtxt byte-for-byte:
 *   `Section is already leased by <holder> until <expiresAt>`.
 * - **Release / renew** — holder-session-only (a different session cannot
 *   release or renew another holder's lease); renewing with no held lease
 *   fails, mirroring llmtxt's "No active lease to renew".
 * - **Auto-renew** — `startAutoRenew(thresholdSeconds = 10)` renews when
 *   the TTL drops below the threshold, llmtxt's default.
 * - **Expiry / staleness** — a lease never outlives its session without
 *   renew: only the owning session can renew, so a dead session's lease
 *   expires at `expiresAt`; an EXPIRED lease is stale and any session may
 *   take it over (`tookOverFrom` names the stale holder).
 *
 * ## Storage — local-only JSON, deliberately NOT a cleo.db table
 *
 * Leases NEVER replicate (spec §2: "leases are local-only rows, always").
 * This module keeps them in `.cleo/section-leases.json`, written
 * atomically (tmp file + rename, the `writeBackupSidecar` pattern,
 * T12535). A JSON file — not a table — is the honest choice: no migration,
 * no gate 21/28/36/37 classification ceremony for ephemeral advisory state,
 * and it structurally cannot be mistaken for a syncing table. The known
 * trade-off, accepted deliberately: read-modify-write across PROCESSES is
 * last-write-wins (no cross-process lock); the lease is advisory, the CRDT
 * layer preserves content regardless, and CLEO's store discipline is a
 * single active writer per store. Promote to a classified local-only table
 * if multi-process contention ever matters (the classification pattern is
 * `section_crdt_states`, landed with T13354).
 *
 * Not wired into the section edit flow yet — that lands with the T13356
 * wiring slice after #2144 merges.
 *
 * @module
 * @task T13356
 * @epic T13340
 * @saga T13339
 */

import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { getCleoDirAbsolute } from '../paths.js';

/** Minimum lease TTL in seconds (llmtxt's `durationSeconds` lower bound). */
export const MIN_LEASE_TTL_SECONDS = 1;

/** Maximum lease TTL in seconds (llmtxt's `durationSeconds` upper bound). */
export const MAX_LEASE_TTL_SECONDS = 300;

/** Default auto-renew threshold in seconds (llmtxt's default). */
export const DEFAULT_RENEW_THRESHOLD_SECONDS = 10;

/** One section lease, llmtxt's `{ leaseId, holder, expiresAt }` + session facts. */
export interface SectionLease {
  /** Unique lease id (random UUIDv4, minted at acquire). */
  readonly leaseId: string;
  /** Holder agent id (defaults to the session id). */
  readonly holder: string;
  /** Owning session: only this session may renew or release. */
  readonly sessionId: string;
  /** Document slug (lease scope). */
  readonly slug: string;
  /** Section id (lease scope). */
  readonly sectionId: string;
  /** Optional human-readable reason (llmtxt's acquire `reason`). */
  readonly reason?: string;
  /** ISO-8601 instant the lease was acquired. */
  readonly acquiredAt: string;
  /** ISO-8601 instant the lease expires without renew. */
  readonly expiresAt: string;
}

/** The 409 equivalent: a held, unexpired lease blocks an acquire — advisory. */
export interface SectionLeaseConflict {
  /** The blocking lease id. */
  readonly leaseId: string;
  /** The current holder agent id. */
  readonly holder: string;
  /** The current holder's session. */
  readonly sessionId: string;
  /** When the blocking lease expires (ISO-8601). */
  readonly expiresAt: string;
}

/** Result of {@link SectionLeaseManager.acquire} — never throws on conflict. */
export type AcquireSectionLeaseResult =
  | { ok: true; lease: SectionLease; tookOverFrom?: SectionLeaseConflict }
  | { ok: false; conflict: SectionLeaseConflict };

/** Result of {@link SectionLeaseManager.renew}. */
export type RenewSectionLeaseResult =
  | { ok: true; lease: SectionLease }
  | { ok: false; conflict: SectionLeaseConflict }
  | { ok: false; notHeld: true };

/** Thrown by {@link acquireOrThrow} — mirrors llmtxt's `LeaseConflictError`. */
export class SectionLeaseConflictError extends Error {
  /** The current holder agent id. */
  readonly holder: string;
  /** When the blocking lease expires (ISO-8601). */
  readonly expiresAt: string;

  constructor(holder: string, expiresAt: string) {
    super(`Section is already leased by ${holder} until ${expiresAt}`);
    this.name = 'SectionLeaseConflictError';
    this.holder = holder;
    this.expiresAt = expiresAt;
  }
}

/** On-disk shape of `.cleo/section-leases.json`. */
interface SectionLeaseFile {
  readonly version: 1;
  readonly leases: Record<string, SectionLease>;
}

/** Composite lease key (`${slug}::${sectionId}`). */
function leaseKey(slug: string, sectionId: string): string {
  return `${slug}::${sectionId}`;
}

/** Resolve the leases file path for a project root. */
function leasesFilePath(projectRoot: string): string {
  return join(getCleoDirAbsolute(projectRoot), 'section-leases.json');
}

/** Clamp a requested TTL into llmtxt's 1–300 s range. */
function clampTtl(seconds: number): number {
  if (!Number.isFinite(seconds)) return MIN_LEASE_TTL_SECONDS;
  return Math.min(MAX_LEASE_TTL_SECONDS, Math.max(MIN_LEASE_TTL_SECONDS, Math.floor(seconds)));
}

/** Read the leases file, tolerating a missing or malformed one. */
function readLeaseFile(projectRoot: string): SectionLeaseFile {
  const path = leasesFilePath(projectRoot);
  if (!existsSync(path)) return { version: 1, leases: {} };
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as Partial<SectionLeaseFile>;
    if (
      parsed &&
      typeof parsed === 'object' &&
      parsed.leases &&
      typeof parsed.leases === 'object'
    ) {
      return { version: 1, leases: parsed.leases };
    }
    return { version: 1, leases: {} };
  } catch {
    return { version: 1, leases: {} };
  }
}

/**
 * Atomically persist the leases file (tmp file + rename, the
 * `writeBackupSidecar` pattern): a crash mid-write can at worst leave an
 * orphaned tmp file, never a torn JSON document.
 */
function writeLeaseFile(projectRoot: string, file: SectionLeaseFile): void {
  const dest = leasesFilePath(projectRoot);
  mkdirSync(dirname(dest), { recursive: true });
  const tmp = `${dest}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, JSON.stringify(file, null, 2));
  renameSync(tmp, dest);
}

/** Whether a lease has expired at `nowMs` (epoch ms). */
function isExpired(lease: SectionLease, nowMs: number): boolean {
  const expiryMs = Date.parse(lease.expiresAt);
  return Number.isNaN(expiryMs) || nowMs >= expiryMs;
}

/** Conflict view of a lease. */
function conflictOf(lease: SectionLease): SectionLeaseConflict {
  return {
    leaseId: lease.leaseId,
    holder: lease.holder,
    sessionId: lease.sessionId,
    expiresAt: lease.expiresAt,
  };
}

/** Options for {@link SectionLeaseManager}. */
export interface SectionLeaseManagerOptions {
  /**
   * Owning session id — REQUIRED. The lease tie T13356 mandates: renew and
   * release are only accepted from this session, so a dead session's lease
   * can never be renewed and dies at its TTL.
   */
  readonly sessionId: string;
  /**
   * Holder agent id surfaced in conflicts (defaults to `sessionId`).
   * llmtxt's `holder` is free-form (agent identity).
   */
  readonly holder?: string;
  /** Injectable clock (epoch ms) for deterministic tests. Defaults to Date.now. */
  readonly now?: () => number;
}

/**
 * Local advisory lease manager for section edit scopes.
 *
 * One manager per (process, session). State is file-backed, so a second
 * manager on the same project sees this manager's leases (and vice versa).
 */
export class SectionLeaseManager {
  private readonly projectRoot: string;
  private readonly sessionId: string;
  private readonly holder: string;
  private readonly now: () => number;
  private autoRenewTimer: ReturnType<typeof setInterval> | null = null;

  constructor(projectRoot: string, options: SectionLeaseManagerOptions) {
    if (options.sessionId.trim().length === 0) {
      // @sync-invariant none:local-only a lease must be tied to a session; the leases file is local-only advisory state, not a synced row
      throw new Error('SectionLeaseManager requires a non-empty sessionId');
    }
    this.projectRoot = projectRoot;
    this.sessionId = options.sessionId;
    this.holder = options.holder ?? options.sessionId;
    this.now = options.now ?? Date.now;
  }

  /**
   * Acquire an advisory lease on `(slug, sectionId)`.
   *
   * A held, unexpired lease yields `{ ok: false, conflict }` — the 409
   * equivalent, an advisory signal rather than an error (llmtxt: "409 is a
   * social signal, not a hard lock"). An EXPIRED lease is stale: any
   * session may take it over, and `tookOverFrom` names the stale holder.
   *
   * @param slug - Document slug.
   * @param sectionId - Section id.
   * @param ttlSeconds - Requested TTL, clamped to 1–300 s (llmtxt's range).
   * @param reason - Optional human-readable reason.
   */
  async acquire(
    slug: string,
    sectionId: string,
    ttlSeconds: number,
    reason?: string,
  ): Promise<AcquireSectionLeaseResult> {
    const file = readLeaseFile(this.projectRoot);
    const key = leaseKey(slug, sectionId);
    const existing = file.leases[key];
    const nowMs = this.now();

    let tookOverFrom: SectionLeaseConflict | undefined;
    if (existing !== undefined && !isExpired(existing, nowMs)) {
      return { ok: false, conflict: conflictOf(existing) };
    }
    if (existing !== undefined) {
      tookOverFrom = conflictOf(existing);
    }

    const ttl = clampTtl(ttlSeconds);
    const lease: SectionLease = {
      leaseId: randomUUID(),
      holder: this.holder,
      sessionId: this.sessionId,
      slug,
      sectionId,
      ...(reason !== undefined ? { reason } : {}),
      acquiredAt: new Date(nowMs).toISOString(),
      expiresAt: new Date(nowMs + ttl * 1000).toISOString(),
    };
    file.leases[key] = lease;
    writeLeaseFile(this.projectRoot, file);
    return tookOverFrom !== undefined ? { ok: true, lease, tookOverFrom } : { ok: true, lease };
  }

  /**
   * Throwing variant of {@link acquire}: raises {@link SectionLeaseConflictError}
   * with llmtxt's exact message shape when the section is held.
   *
   * @returns The acquired lease.
   */
  async acquireOrThrow(
    slug: string,
    sectionId: string,
    ttlSeconds: number,
    reason?: string,
  ): Promise<SectionLease> {
    const result = await this.acquire(slug, sectionId, ttlSeconds, reason);
    if (!result.ok) {
      // @sync-invariant none:local-only the conflict is the advisory 409 equivalent; the leases file is local-only state, not a synced row
      throw new SectionLeaseConflictError(result.conflict.holder, result.conflict.expiresAt);
    }
    return result.lease;
  }

  /**
   * Release a lease — only the owning session may release it.
   *
   * @returns Whether a lease was removed (false when unheld or held by
   *   another session).
   */
  async release(slug: string, sectionId: string): Promise<boolean> {
    const file = readLeaseFile(this.projectRoot);
    const key = leaseKey(slug, sectionId);
    const existing = file.leases[key];
    if (existing === undefined || existing.sessionId !== this.sessionId) return false;
    delete file.leases[key];
    writeLeaseFile(this.projectRoot, file);
    return true;
  }

  /**
   * Renew a lease, extending its TTL — only the owning session may renew.
   *
   * @param slug - Document slug.
   * @param sectionId - Section id.
   * @param ttlSeconds - New TTL, clamped to 1–300 s.
   */
  async renew(
    slug: string,
    sectionId: string,
    ttlSeconds: number,
  ): Promise<RenewSectionLeaseResult> {
    const file = readLeaseFile(this.projectRoot);
    const key = leaseKey(slug, sectionId);
    const existing = file.leases[key];
    if (existing === undefined) return { ok: false, notHeld: true };
    const nowMs = this.now();
    if (isExpired(existing, nowMs)) return { ok: false, notHeld: true };
    if (existing.sessionId !== this.sessionId) {
      return { ok: false, conflict: conflictOf(existing) };
    }
    const ttl = clampTtl(ttlSeconds);
    const lease: SectionLease = {
      ...existing,
      expiresAt: new Date(nowMs + ttl * 1000).toISOString(),
    };
    file.leases[key] = lease;
    writeLeaseFile(this.projectRoot, file);
    return { ok: true, lease };
  }

  /**
   * Current lease status for `(slug, sectionId)`: the live (unexpired)
   * lease, or `null` when free or expired. Never throws.
   */
  async status(slug: string, sectionId: string): Promise<SectionLease | null> {
    const file = readLeaseFile(this.projectRoot);
    const existing = file.leases[leaseKey(slug, sectionId)];
    if (existing === undefined || isExpired(existing, this.now())) return null;
    return existing;
  }

  /**
   * Start an auto-renew loop (llmtxt parity): renews when the remaining TTL
   * drops below `thresholdSeconds` (default 10 s). In-process timer; a
   * manager that stops renewing (crash, dead session) lets the lease expire
   * at its TTL, after which any session may take over.
   *
   * @param slug - Document slug.
   * @param sectionId - Section id.
   * @param ttlSeconds - TTL applied at each renew, clamped to 1–300 s.
   * @param thresholdSeconds - Renew when the remaining TTL drops below this.
   */
  startAutoRenew(
    slug: string,
    sectionId: string,
    ttlSeconds: number,
    thresholdSeconds: number = DEFAULT_RENEW_THRESHOLD_SECONDS,
  ): void {
    this.stopAutoRenew();
    const intervalMs = Math.max(250, Math.floor((thresholdSeconds * 1000) / 2));
    this.autoRenewTimer = setInterval(() => {
      void (async () => {
        const current = await this.status(slug, sectionId);
        if (current === null) {
          this.stopAutoRenew();
          return;
        }
        const remainingMs = Date.parse(current.expiresAt) - this.now();
        if (remainingMs <= thresholdSeconds * 1000) {
          await this.renew(slug, sectionId, ttlSeconds);
        }
      })();
    }, intervalMs);
    // Advisory coordination only — never keep the process alive on it.
    if (typeof this.autoRenewTimer.unref === 'function') this.autoRenewTimer.unref();
  }

  /** Stop the auto-renew loop (llmtxt parity). */
  stopAutoRenew(): void {
    if (this.autoRenewTimer !== null) {
      clearInterval(this.autoRenewTimer);
      this.autoRenewTimer = null;
    }
  }

  /** Whether the auto-renew loop is running. */
  get autoRenewRunning(): boolean {
    return this.autoRenewTimer !== null;
  }
}

/**
 * Staleness predicate (T13356): a lease is stale — overwritable by any
 * session — when its TTL has expired. (Session death alone does not kill an
 * unexpired lease; conservatism is safe because a dead session cannot
 * renew, so its lease is bounded by the TTL regardless.)
 *
 * @param lease - The lease to check.
 * @param nowMs - Current time (epoch ms).
 * @returns Whether the lease is stale.
 */
export function isStaleSectionLease(lease: SectionLease, nowMs: number): boolean {
  return isExpired(lease, nowMs);
}

/**
 * List the LIVE (unexpired) section leases of one doc. Expired leases are
 * omitted: they are stale, and the next acquire takes them over.
 *
 * @param projectRoot - Absolute path to the CLEO project root.
 * @param slug - The doc's live slug.
 * @returns The live leases, in file order.
 */
export async function listSectionLeases(
  projectRoot: string,
  slug: string,
): Promise<SectionLease[]> {
  const file = readLeaseFile(projectRoot);
  const nowMs = Date.now();
  return Object.values(file.leases).filter(
    (lease) => lease.slug === slug && !isExpired(lease, nowMs),
  );
}
