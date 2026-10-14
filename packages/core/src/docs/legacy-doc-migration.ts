/**
 * T13360 — honest migration of legacy docs into the re-keyed store
 * (spec `cleodocs-rearch-design` §5, D11165).
 *
 * Imports every legacy CleoDocs document (`docs_attachments` rows — the
 * D11-collapse twin of the legacy `attachments` registry) into the T13354
 * re-keyed conduit history family, inside the T13448 migration safety
 * harness:
 *
 *   backup → BEGIN IMMEDIATE → before-fingerprints → step → verify →
 *   COMMIT (only when every check passed) / ROLLBACK
 *
 * Honesty contract (the spec's words are the ACs):
 *
 *   - **Every imported history row is labeled `origin: 'migrated'`** — no
 *     imported row poses as native (AC1).
 *   - **No fabricated authors, no invented version numbers** — authors come
 *     from the legacy docs audit log's real `actor`; when no provenance
 *     exists the row is system-attributed (`system:migration`), the AC's
 *     sanctioned "system attribution", never an invented human (AC2).
 *     Version ordinals are derived from the real audit-event order.
 *   - **Dangling-pointer docs are content-captured or marked dangling** —
 *     a doc whose recorded path is missing or ephemeral (worktree/tmp) gets
 *     its bytes recovered from the content-addressed blob store when
 *     possible (captured); otherwise it is recorded in
 *     `conduit_doc_migration_ledger` with `status: 'dangling'`, the legacy
 *     pointer and the reason — never silently imported (AC3).
 *   - **Idempotent** — every write carries a NATURAL uid (doc slug; (doc
 *     uid, content hash, event timestamp); ledger slug), so a re-run derives
 *     the same uids and `ON CONFLICT DO NOTHING` turns it into a verified
 *     no-op; docs already in the ledger are skipped. The second run's
 *     harness verification proves zero deltas and unchanged hashes (AC4).
 *
 * The migration is exposed as `cleo docs migrate` (dispatch op
 * `docs.migrate`); it takes its own pre-step VACUUM INTO backup through the
 * harness and needs no `--force` (it is additive — nothing is deleted).
 *
 * Cross-device identity (T13638): the audit log (`docs-audit.jsonl`) is a
 * DEVICE-LOCAL file — it never syncs. Version identity therefore CANNOT
 * derive from a row's position in it (`evt-<i>` was v1 and diverged across
 * devices). Every imported version's natural uid is instead a pure function
 * of the version's real facts — (doc uid, content hash, event timestamp) —
 * so two devices migrating the same synced legacy doc derive IDENTICAL uids
 * for the same content whatever their local audit logs hold, and two
 * different contents can never collide on one uid. The doc uid, the ledger
 * receipt, and the head projection were already device-independent.
 *
 * Existing installs: a store that already ran the t13360 import keeps its
 * position-derived version uids — the ledger receipt makes the migration
 * one-shot per doc, so the content-derived derivation applies to newly
 * migrated rows only (accepted mixed state, per the task's (a) option; no
 * re-key migration, since the spec does not mandate one).
 *
 * @module
 * @task T13360
 * @task T13633 — review round 2: leaf HLC constant, native-conflict count,
 *   cross-device caveat
 * @task T13638 — version uids derived from (doc uid, content hash, event
 *   timestamp), never from the device-local audit position
 * @epic T13340
 * @saga T13339
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, resolve, sep } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { getCleoWorktreesRoot } from '@cleocode/paths';
import { eq, isNotNull } from 'drizzle-orm';
import { getCleoDir } from '../paths.js';
import { blobContentExists, blobFilePath } from '../store/blob-keep.js';
import {
  findConduitDocMigration,
  importMigratedConduitDoc,
  importMigratedConduitVersion,
  recordConduitDocMigration,
  upsertConduitDocHead,
} from '../store/conduit-doc-history.js';
import {
  type MigrationRunReport,
  type MigrationStep,
  type MigrationStepReport,
  type MigrationStepVerificationSpec,
  runMigrationSteps,
} from '../store/migration-safety.js';
import { conduitAttachments } from '../store/schema/cleo-project/conduit.js';
import { getDb } from '../store/sqlite.js';
import { encodeHlc, PRE_HLC_REPLICA } from '../store/sync/hlc.js';
import { docsAttachments } from '../store/tasks-schema.js';
import { readAuditLog } from './docs-audit.js';

/**
 * The honest system attribution for migrated rows with no real author
 * provenance (spec §5 "system attribution"). Never an invented human name.
 */
export const MIGRATION_SYSTEM_AUTHOR = 'system:migration';

/** A parsed `attachment_json` payload — only the shapes the migration needs. */
interface LegacyPayload {
  readonly kind: string;
  readonly path?: string;
  readonly mime?: string;
}

/** One history row to import for one doc. */
interface PlannedVersion {
  /** Real audit actor, or {@link MIGRATION_SYSTEM_AUTHOR}. */
  readonly authorAgentId: string;
  /** SHA-256 hex of this version's body. */
  readonly contentHash: string;
  /** Body size in bytes. */
  readonly sizeBytes: number;
  /** Measured token count. */
  readonly tokens: number;
  /** Real provenance instant (audit event ts, or the row's created_at). */
  readonly createdAt: string;
  /** Honest summary of what this row is. */
  readonly changeSummary: string;
}

/** The import decision for one legacy doc. */
interface PlannedDoc {
  readonly slug: string;
  readonly status: 'captured' | 'dangling';
  readonly reason: string;
  readonly legacyPath: string | null;
  readonly legacySha256: string;
  /** Captured bytes (null when dangling). */
  readonly content: Buffer | null;
  readonly format: string;
  readonly title: string | null;
  readonly createdAt: string;
  readonly versions: readonly PlannedVersion[];
  /** Doc-row author (author of the last imported version). */
  readonly fromAgentId: string;
}

/** Statically-declared per-table row deltas (fed to the harness verifier). */
export interface LegacyMigrationPlan {
  /** The single harness step executing this plan. */
  readonly step: MigrationStep;
  /** Rows the step will add per table (all zero on a re-run). */
  readonly expectedDelta: Readonly<Record<string, number>>;
  /** Planned doc imports (for reporting/tests). */
  readonly docs: readonly PlannedDoc[];
  readonly counts: {
    readonly toCapture: number;
    readonly toMarkDangling: number;
    /** Docs already receipted by an earlier run (idempotency skips). */
    readonly toSkip: number;
    /**
     * Legacy slugs that already exist NATIVELY in `conduit_attachments` — the
     * migration never clobbers a native doc, and these are counted
     * explicitly (not silently lumped into `toSkip`) so the operator can
     * reconcile them by hand (T13633).
     */
    readonly nativeConflicts: number;
    readonly versions: number;
  };
}

/** True when `absPath` is ephemeral — inside a CLEO/Claude worktree or tmp. */
function isEphemeralPath(absPath: string): 'worktree' | 'tmp' | null {
  const worktreesRoot = getCleoWorktreesRoot();
  if (absPath === worktreesRoot || absPath.startsWith(`${worktreesRoot}${sep}`)) {
    return 'worktree';
  }
  if (absPath.includes(`${sep}.claude${sep}worktrees${sep}`)) return 'worktree';
  const tmp = tmpdir();
  if (absPath.startsWith(`${tmp}${sep}`) || absPath.startsWith(`${sep}tmp${sep}`)) return 'tmp';
  return null;
}

/** Read the content-addressed blob bytes for a sha/mime, or null. */
function readBlobBytes(cleoDir: string, sha256: string, mime: string): Buffer | null {
  const primary = blobFilePath(cleoDir, sha256, mime);
  try {
    return readFileSync(primary);
  } catch {
    return null;
  }
}

/** Cheap whitespace token count — a measurement, never an invention. */
function countTokens(bytes: Buffer): number {
  let count = 0;
  let inWs = true;
  for (let i = 0; i < bytes.length; i++) {
    const c = bytes[i] ?? 0;
    const ws = c === 32 || c === 9 || c === 10 || c === 13;
    if (!ws && inWs) count += 1;
    inWs = ws;
  }
  return count;
}

function sha256Hex(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function parsePayload(raw: string): LegacyPayload | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as LegacyPayload;
    }
    return null;
  } catch {
    return null;
  }
}

function formatFromMime(mime: string | undefined, slug: string): string {
  if (mime?.includes('markdown')) return 'markdown';
  if (slug.toLowerCase().endsWith('.md')) return 'markdown';
  return 'text';
}

/**
 * Derive the import plan for every legacy doc — the SAME derivation runs in
 * `planLegacyDocMigration` (to declare the harness's expected deltas) and
 * inside the step (inside the transaction), so the deltas match by
 * construction and any divergence fails verification and rolls back.
 *
 * Read-only: never writes; reads the store, the blob files and the audit
 * log.
 *
 * @internal Exported for tests.
 */
export async function deriveLegacyDocMigrationPlan(projectRoot: string): Promise<{
  docs: PlannedDoc[];
  skipped: number;
  nativeConflicts: number;
  expectedDelta: Record<string, number>;
}> {
  const cleoDir = getCleoDir(projectRoot);
  const db = await getDb(projectRoot);
  const rows = await db.select().from(docsAttachments).where(isNotNull(docsAttachments.slug)).all();
  const audit = readAuditLog(projectRoot);

  const docs: PlannedDoc[] = [];
  let skipped = 0;
  let nativeConflicts = 0;
  for (const row of rows) {
    const slug = row.slug as string;
    // Idempotency: a doc already receipted (captured or dangling) is done.
    if ((await findConduitDocMigration(projectRoot, slug)) !== null) {
      skipped += 1;
      continue;
    }
    // Never clobber a native conduit doc that happens to share the slug —
    // counted explicitly so the operator can reconcile it (T13633).
    const existing = await db
      .select({ slug: conduitAttachments.slug })
      .from(conduitAttachments)
      .where(eq(conduitAttachments.slug, slug))
      .get();
    if (existing !== undefined && existing !== null) {
      nativeConflicts += 1;
      continue;
    }

    const payload = parsePayload(row.attachmentJson);
    const mime = payload?.mime;
    const fmt = formatFromMime(mime, slug);

    // ── dangling classification (doctor parity: missing OR ephemeral path) ──
    const pointerPath =
      payload !== null && typeof payload.path === 'string' && payload.path.length > 0
        ? payload.path
        : null;
    let danglingReason: string | null = null;
    if (payload === null) {
      danglingReason = 'unparseable-payload';
    } else if (payload.kind !== 'blob' && payload.kind !== 'local-file') {
      danglingReason = `no-local-content:${payload.kind}`;
    } else if (pointerPath !== null) {
      const abs = isAbsolute(pointerPath) ? pointerPath : resolve(projectRoot, pointerPath);
      const ephemeral = isEphemeralPath(abs);
      if (!existsSync(abs)) {
        danglingReason = 'path-missing';
      } else if (ephemeral !== null) {
        danglingReason = `path-ephemeral:${ephemeral}`;
      }
    }

    // ── content capture ──
    let content: Buffer | null = null;
    let capturedReason = 'captured';
    if (danglingReason === null) {
      if (payload?.kind === 'local-file' && pointerPath !== null) {
        const abs = isAbsolute(pointerPath) ? pointerPath : resolve(projectRoot, pointerPath);
        try {
          content = readFileSync(abs);
        } catch {
          danglingReason = 'path-unreadable';
        }
      } else {
        content = readBlobBytes(cleoDir, row.sha256, mime ?? 'application/octet-stream');
        if (content === null) danglingReason = 'blob-bytes-missing';
      }
      if (content !== null && danglingReason !== null) {
        // Dangling pointer, bytes recovered from the content-addressed store.
        capturedReason = `recovered:${danglingReason}`;
        danglingReason = null;
      }
    } else if (danglingReason !== 'unparseable-payload' && payload?.kind !== undefined) {
      // Dangling pointer — try to recover the bytes by sha from the blob store.
      if (blobContentExists(cleoDir, row.sha256, mime ?? 'application/octet-stream')) {
        content = readBlobBytes(cleoDir, row.sha256, mime ?? 'application/octet-stream');
        if (content !== null) {
          capturedReason = `recovered:${danglingReason}`;
          danglingReason = null;
        }
      }
    }

    if (danglingReason !== null || content === null) {
      docs.push({
        slug,
        status: 'dangling',
        reason: danglingReason ?? 'blob-bytes-missing',
        legacyPath: pointerPath,
        legacySha256: row.sha256,
        content: null,
        format: fmt,
        title: row.summary ?? null,
        createdAt: row.createdAt,
        versions: [],
        fromAgentId: MIGRATION_SYSTEM_AUTHOR,
      });
      continue;
    }

    // ── history reconstruction from the real audit log ──
    const events = audit.entries.filter(
      (e) => e.slug === slug && (e.op === 'docs.add' || e.op === 'docs.update'),
    );
    const versions: PlannedVersion[] = [];
    // T13638: two events with the SAME content at the SAME instant are one
    // logical version — the content-derived natural uid cannot tell them
    // apart, so a repeat would either no-op away honest history or parent a
    // version to itself. The first occurrence is kept; each repeat is a
    // collapsed duplicate write, counted into the survivor's summary.
    const seenVersionKeys = new Map<string, number>();
    const collapsedDuplicates = new Map<string, number>();
    for (const event of events) {
      if (event.sha256 === undefined) continue;
      const eventMime = mime ?? 'application/octet-stream';
      if (!blobContentExists(cleoDir, event.sha256, eventMime)) continue; // bytes gone — honest omission
      const bytes = readBlobBytes(cleoDir, event.sha256, eventMime);
      if (bytes === null) continue;
      const versionKey = `${event.sha256}|${event.ts}`;
      const prior = seenVersionKeys.get(versionKey);
      if (prior !== undefined) {
        collapsedDuplicates.set(versionKey, (collapsedDuplicates.get(versionKey) ?? 0) + 1);
        continue;
      }
      seenVersionKeys.set(versionKey, versions.length);
      versions.push({
        authorAgentId:
          typeof event.actor === 'string' && event.actor.length > 0
            ? event.actor
            : MIGRATION_SYSTEM_AUTHOR,
        contentHash: event.sha256,
        sizeBytes: bytes.length,
        tokens: countTokens(bytes),
        createdAt: event.ts,
        changeSummary: `migrated from the legacy docs store (audit ${event.op} @ ${event.ts})`,
      });
    }
    for (const [versionKey, count] of collapsedDuplicates) {
      const index = seenVersionKeys.get(versionKey);
      if (index === undefined) continue;
      const survivor = versions[index];
      if (survivor === undefined) continue;
      versions[index] = {
        ...survivor,
        changeSummary: `${survivor.changeSummary}; collapsed ${count} duplicate audit event(s) with identical content and timestamp`,
      };
    }
    if (versions.length === 0) {
      // No recoverable audit history — one content-capture version, honestly
      // system-attributed. Never invented authors or ordinals.
      versions.push({
        authorAgentId: MIGRATION_SYSTEM_AUTHOR,
        contentHash: row.sha256,
        sizeBytes: content.length,
        tokens: countTokens(content),
        createdAt: row.createdAt,
        changeSummary: 'migrated from the legacy docs store (content capture; no audit provenance)',
      });
    }

    docs.push({
      slug,
      status: 'captured',
      reason: capturedReason,
      legacyPath: pointerPath,
      legacySha256: row.sha256,
      content,
      format: fmt,
      title: row.summary ?? null,
      createdAt: row.createdAt,
      versions,
      fromAgentId: versions[versions.length - 1]?.authorAgentId ?? MIGRATION_SYSTEM_AUTHOR,
    });
  }

  const expectedDelta: Record<string, number> = {
    conduit_attachments: 0,
    conduit_attachment_versions: 0,
    conduit_doc_heads: 0,
    conduit_doc_migration_ledger: 0,
  };
  for (const doc of docs) {
    expectedDelta['conduit_doc_migration_ledger'] += 1;
    if (doc.status === 'captured') {
      expectedDelta['conduit_attachments'] += 1;
      expectedDelta['conduit_attachment_versions'] += doc.versions.length;
      expectedDelta['conduit_doc_heads'] += 1;
    }
  }
  return { docs, skipped, nativeConflicts, expectedDelta };
}

/**
 * Plan the migration: derive the work, declare the harness's expected deltas,
 * and build the single harness step. Call immediately before
 * {@link runLegacyDocMigration} — the plan and the step re-derive from the
 * same state, and the harness fails verification (rolling back) if a
 * concurrent write lands in between.
 *
 * @param projectRoot - Absolute path to the CLEO project root.
 * @returns The plan (step + declared deltas + per-doc decisions).
 * @task T13360
 */
export async function planLegacyDocMigration(opts: {
  projectRoot: string;
}): Promise<LegacyMigrationPlan> {
  const derived = await deriveLegacyDocMigrationPlan(opts.projectRoot);
  const verify: MigrationStepVerificationSpec = {
    expectedDelta: derived.expectedDelta,
  };
  const step: MigrationStep = {
    name: 'migrate-legacy-docs',
    description: 'import legacy docs + history into the re-keyed conduit store (T13360, spec §5)',
    verify,
    run: async ({ db: _db, projectRoot, log }) => {
      const plan = await deriveLegacyDocMigrationPlan(projectRoot);
      for (const doc of plan.docs) {
        if (doc.status === 'dangling') {
          await recordConduitDocMigration(projectRoot, {
            slug: doc.slug,
            docUid: null,
            status: 'dangling',
            reason: doc.reason,
            ...(doc.legacyPath !== null ? { legacyPath: doc.legacyPath } : {}),
            legacySha256: doc.legacySha256,
            versionsImported: 0,
          });
          log(`marked dangling: ${doc.slug} (${doc.reason})`);
          continue;
        }
        const content = doc.content ?? Buffer.alloc(0);
        const contentHash = sha256Hex(content);
        const { uid: docUid } = await importMigratedConduitDoc(projectRoot, {
          slug: doc.slug,
          fromAgentId: doc.fromAgentId,
          content,
          contentHash,
          format: doc.format,
          ...(doc.title !== null ? { title: doc.title } : {}),
          tokens: countTokens(content),
          createdAt: doc.createdAt,
          versionCount: doc.versions.length,
        });
        let parentUid: string | null = null;
        let lastVersionUid = '';
        let ordinal = 0;
        for (const version of doc.versions) {
          ordinal += 1;
          const { uid } = await importMigratedConduitVersion(projectRoot, {
            attachmentUid: docUid,
            parentVersionUid: parentUid,
            authorAgentId: version.authorAgentId,
            storageKey: `sha256:${version.contentHash}`,
            contentHash: version.contentHash,
            sizeBytes: version.sizeBytes,
            tokens: version.tokens,
            versionNumber: ordinal,
            createdAt: version.createdAt,
            changeSummary: version.changeSummary,
            slug: doc.slug,
          });
          parentUid = uid;
          lastVersionUid = uid;
        }
        // Head projection: a deterministic HLC (pre-replica, phys = the last
        // version's real timestamp) so a re-run's upsert is a stable no-op on
        // every device — no spurious conflict records (AC4).
        const lastVersion = doc.versions[doc.versions.length - 1];
        if (lastVersion !== undefined && lastVersionUid.length > 0) {
          await upsertConduitDocHead(projectRoot, {
            attachmentUid: docUid,
            headVersionUid: lastVersionUid,
            headHlc: encodeHlc({
              phys: Date.parse(lastVersion.createdAt),
              ctr: ordinal,
              replica: PRE_HLC_REPLICA,
            }),
          });
        }
        await recordConduitDocMigration(projectRoot, {
          slug: doc.slug,
          docUid,
          status: 'captured',
          reason: doc.reason,
          ...(doc.legacyPath !== null ? { legacyPath: doc.legacyPath } : {}),
          legacySha256: doc.legacySha256,
          versionsImported: doc.versions.length,
        });
        log(`captured: ${doc.slug} (${doc.versions.length} version(s))`);
      }
      log(
        `legacy docs migration applied: ${plan.docs.filter((d) => d.status === 'captured').length} captured, ` +
          `${plan.docs.filter((d) => d.status === 'dangling').length} dangling, ` +
          `${plan.skipped} already migrated, ${plan.nativeConflicts} native-conflict skips`,
      );
    },
  };
  return {
    step,
    expectedDelta: derived.expectedDelta,
    docs: derived.docs,
    counts: {
      toCapture: derived.docs.filter((d) => d.status === 'captured').length,
      toMarkDangling: derived.docs.filter((d) => d.status === 'dangling').length,
      toSkip: derived.skipped,
      nativeConflicts: derived.nativeConflicts,
      versions: derived.docs.reduce((n, d) => n + d.versions.length, 0),
    },
  };
}

/** Result wrapper around the harness run report. */
export interface LegacyMigrationRunResult {
  /** The harness report (backup receipt, per-table verification, transaction). */
  readonly report: MigrationRunReport;
  /** Counts from the plan that built the step. */
  readonly counts: LegacyMigrationPlan['counts'];
}

/**
 * Run the legacy docs migration inside the T13448 harness: pre-step VACUUM
 * INTO backup → BEGIN IMMEDIATE → before-fingerprints → import → verify →
 * COMMIT, or ROLLBACK on any failure (the failed step is never visible).
 * Additive only — nothing is deleted, so no `force` is required.
 *
 * @param opts.projectRoot - Absolute path to the CLEO project root.
 * @param opts.db - Live native handle on the project store (chokepoint-opened).
 * @param opts.cwd - Invocation directory (the restore path's worktree guard).
 * @param opts.onStepReport - Optional per-step report sink.
 * @returns The harness report plus plan counts.
 * @task T13360
 */
export async function runLegacyDocMigration(opts: {
  projectRoot: string;
  db: DatabaseSync;
  cwd: string;
  onStepReport?: (report: MigrationStepReport) => void;
}): Promise<LegacyMigrationRunResult> {
  const plan = await planLegacyDocMigration({ projectRoot: opts.projectRoot });
  const report = await runMigrationSteps([plan.step], {
    db: opts.db,
    projectRoot: opts.projectRoot,
    cwd: opts.cwd,
    onStepReport: opts.onStepReport,
  });
  return { report, counts: plan.counts };
}
