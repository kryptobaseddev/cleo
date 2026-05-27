/**
 * Docs Audit Trail — unified immutable append-only audit log for all doc mutations.
 *
 * Every doc mutation (add, update, remove, supersede, publish, publish-pr,
 * sync, import) appends one line to `.cleo/audit/docs-audit.jsonl`. Each
 * entry carries an HMAC-SHA256 checkpoint chaining it to all prior entries,
 * forming a tamper-evident immutable log.
 *
 * The audit log is the canonical source of truth for:
 *   - `cleo docs audit --slug <slug>`  — per-slug operation history
 *   - `cleo docs audit --verify`       — chain integrity + cross-reference check
 *
 * Retention: entries are kept indefinitely (aligned with CLEO's 10-snapshot
 * backup rotation). Archival (compaction of old entries) is NOT performed
 * automatically — the audit log is deliberately append-only.
 *
 * @task T11182 (Saga T10516 — docs audit trail)
 */

import { createHmac, randomBytes } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { getCleoDirAbsolute } from '../paths.js';

// ─── Constants ────────────────────────────────────────────────────────────────

/** Project-root-relative path to the unified docs audit log. */
export const DOCS_AUDIT_FILE = '.cleo/audit/docs-audit.jsonl';

/** Secret seed for HMAC checkpoints (rotated per project-init). */
const CHECKPOINT_SECRET_BYTES = 32;

/** File that stores the checkpoint secret. */
const CHECKPOINT_SECRET_FILE = '.cleo/audit/.audit-secret';

// ─── Public types ─────────────────────────────────────────────────────────────

/** All doc mutation operations tracked by the audit trail. */
export type DocsAuditOp =
  | 'docs.add'
  | 'docs.update'
  | 'docs.remove'
  | 'docs.supersede'
  | 'docs.publish'
  | 'docs.publish-pr'
  | 'docs.sync'
  | 'docs.import';

/** A single immutable audit log entry. */
export interface DocsAuditEntry {
  /** Operation discriminator. */
  readonly op: DocsAuditOp;
  /** ISO 8601 timestamp of the mutation. */
  readonly ts: string;
  /** Identity that performed the operation (agent name, 'human', or 'system'). */
  readonly actor: string;
  /** Slug affected, when applicable. */
  readonly slug?: string;
  /** DocKind/type classification, when applicable. */
  readonly type?: string;
  /** New attachment ID created or affected. */
  readonly attachmentId?: string;
  /** SHA-256 of the content after mutation. */
  readonly sha256?: string;
  /** Previous SHA-256 (for updates), when applicable. */
  readonly previousSha256?: string;
  /** Owner entity ID affected. */
  readonly ownerId?: string;
  /** Human-readable summary of what changed. */
  readonly summary: string;
  /**
   * HMAC-SHA256 checkpoint chaining this entry to ALL prior entries.
   * Computed as HMAC-SHA256(secret, prevCheckpoint || serialized_entry_without_checkpoint).
   */
  readonly checkpoint: string;
}

/** Parameters for writing an audit entry. */
export interface WriteAuditEntryParams {
  op: DocsAuditOp;
  actor?: string;
  slug?: string;
  type?: string;
  attachmentId?: string;
  sha256?: string;
  previousSha256?: string;
  ownerId?: string;
  summary: string;
}

/** Result of reading the audit log. */
export interface AuditLogReadResult {
  /** All entries in chronological order. */
  readonly entries: DocsAuditEntry[];
  /** Whether the checkpoint chain is fully intact. */
  readonly chainIntact: boolean;
  /** Index of the first entry where the chain broke (-1 if intact). */
  readonly chainBrokenAt: number;
}

/** Result of a full audit verification. */
export interface AuditVerifyResult {
  /** Whether the audit log is fully consistent. */
  readonly consistent: boolean;
  /** Number of audit entries examined. */
  readonly entriesExamined: number;
  /** Whether the checkpoint chain is intact. */
  readonly chainIntact: boolean;
  /** Findings — inconsistencies detected. */
  readonly findings: AuditFinding[];
}

/** A single finding from audit verification. */
export interface AuditFinding {
  readonly severity: 'error' | 'warning';
  readonly message: string;
  readonly entryIndex?: number;
  readonly slug?: string;
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

/**
 * Get or create the checkpoint secret for this project.
 * Stored at `.cleo/audit/.audit-secret` as 64 hex chars.
 */
function getCheckpointSecret(projectRoot: string): Buffer {
  const auditDir = join(projectRoot, '.cleo', 'audit');
  const secretPath = join(auditDir, '.audit-secret');

  mkdirSync(auditDir, { recursive: true });

  if (existsSync(secretPath)) {
    const hex = readFileSync(secretPath, 'utf-8').trim();
    if (hex.length === CHECKPOINT_SECRET_BYTES * 2) {
      return Buffer.from(hex, 'hex');
    }
    // Corrupt secret — rotate it
  }

  const secret = randomBytes(CHECKPOINT_SECRET_BYTES);
  // Atomically write: tmp → rename
  const tmpPath = join(auditDir, '.audit-secret.tmp');
  const { writeFileSync } = require('node:fs');
  writeFileSync(tmpPath, secret.toString('hex'), { encoding: 'utf-8', mode: 0o600 });
  renameSync(tmpPath, secretPath);
  return secret;
}

/**
 * Compute the HMAC-SHA256 checkpoint for a new entry.
 *
 * @param secret - The project's checkpoint secret.
 * @param prevCheckpoint - The checkpoint from the previous entry (empty string for the first entry).
 * @param entryWithoutCheckpoint - The serialized entry WITHOUT the `checkpoint` field.
 */
function computeCheckpoint(
  secret: Buffer,
  prevCheckpoint: string,
  entryWithoutCheckpoint: string,
): string {
  const hmac = createHmac('sha256', secret);
  hmac.update(prevCheckpoint);
  hmac.update('\n');
  hmac.update(entryWithoutCheckpoint);
  return hmac.digest('hex');
}

/**
 * Read the last checkpoint from the audit log.
 * Returns empty string for the genesis entry.
 */
function readLastCheckpoint(auditPath: string): string {
  if (!existsSync(auditPath)) return '';

  try {
    const raw = readFileSync(auditPath, 'utf-8');
    const lines = raw.trim().split('\n');
    if (lines.length === 0) return '';

    // Walk backwards to find a valid line with a checkpoint
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i];
      if (!line || line.length === 0) continue;
      try {
        const entry = JSON.parse(line) as DocsAuditEntry;
        if (entry.checkpoint) return entry.checkpoint;
      } catch {
        continue;
      }
    }
  } catch {
    // File read error — start fresh
  }

  return '';
}

/**
 * Serialize an entry for checkpoint computation (without the checkpoint field).
 */
function serializeForCheckpoint(entry: Omit<DocsAuditEntry, 'checkpoint'>): string {
  // Deterministic serialization — sorted keys
  return JSON.stringify(entry, Object.keys(entry).sort());
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Append an immutable audit log entry for a doc mutation.
 *
 * This is the single write surface for the docs audit trail. Every doc
 * mutation MUST call this after successfully completing its write.
 *
 * The entry is written as a single JSON line appended to the audit log.
 * A checkpoint is computed that chains this entry to all prior entries.
 *
 * Best-effort: failures to write the audit log are swallowed — the
 * mutation itself already succeeded and audit drift is non-fatal.
 *
 * @param projectRoot - Absolute project root path.
 * @param params - Entry parameters.
 */
export function writeAuditEntry(
  projectRoot: string,
  params: WriteAuditEntryParams,
): void {
  const auditPath = join(projectRoot, DOCS_AUDIT_FILE);
  const auditDir = join(auditPath, '..');

  try {
    mkdirSync(auditDir, { recursive: true });

    const secret = getCheckpointSecret(projectRoot);
    const prevCheckpoint = readLastCheckpoint(auditPath);
    const now = new Date().toISOString();

    const entryWithoutCheckpoint: Omit<DocsAuditEntry, 'checkpoint'> = {
      op: params.op,
      ts: now,
      actor: params.actor ?? 'human',
      ...(params.slug !== undefined ? { slug: params.slug } : {}),
      ...(params.type !== undefined ? { type: params.type } : {}),
      ...(params.attachmentId !== undefined ? { attachmentId: params.attachmentId } : {}),
      ...(params.sha256 !== undefined ? { sha256: params.sha256 } : {}),
      ...(params.previousSha256 !== undefined ? { previousSha256: params.previousSha256 } : {}),
      ...(params.ownerId !== undefined ? { ownerId: params.ownerId } : {}),
      summary: params.summary,
    };

    const serialized = serializeForCheckpoint(entryWithoutCheckpoint);
    const checkpoint = computeCheckpoint(secret, prevCheckpoint, serialized);

    const entry: DocsAuditEntry = {
      ...entryWithoutCheckpoint,
      checkpoint,
    };

    appendFileSync(auditPath, `${JSON.stringify(entry)}\n`, { encoding: 'utf-8' });
  } catch {
    /* Audit drift is non-fatal — the mutation already succeeded. */
  }
}

/**
 * Read the full audit log and verify the checkpoint chain.
 *
 * @param projectRoot - Absolute project root path.
 * @param slug - Optional filter: only return entries for this slug.
 * @returns The audit log read result with chain integrity status.
 */
export function readAuditLog(
  projectRoot: string,
  slug?: string,
): AuditLogReadResult {
  const auditPath = join(projectRoot, DOCS_AUDIT_FILE);
  const entries: DocsAuditEntry[] = [];
  let chainIntact = true;
  let chainBrokenAt = -1;

  if (!existsSync(auditPath)) {
    return { entries, chainIntact: true, chainBrokenAt: -1 };
  }

  const secret = getCheckpointSecret(projectRoot);
  let prevCheckpoint = '';

  try {
    const raw = readFileSync(auditPath, 'utf-8');
    const lines = raw.split('\n');

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!line || line.length === 0) continue;

      let entry: DocsAuditEntry;
      try {
        entry = JSON.parse(line) as DocsAuditEntry;
      } catch {
        continue; // Skip unparseable lines
      }

      // Filter by slug if requested
      if (slug !== undefined && entry.slug !== slug) continue;

      // Verify checkpoint chain
      const { checkpoint: _cp, ...entryWithoutCheckpoint } = entry;
      const serialized = serializeForCheckpoint(entryWithoutCheckpoint);
      const expectedCheckpoint = computeCheckpoint(secret, prevCheckpoint, serialized);

      if (expectedCheckpoint !== entry.checkpoint) {
        if (chainIntact) {
          chainIntact = false;
          chainBrokenAt = entries.length;
        }
      }

      entries.push(entry);
      prevCheckpoint = entry.checkpoint;
    }
  } catch {
    // File read error
    chainIntact = false;
  }

  return { entries, chainIntact, chainBrokenAt };
}

/**
 * Full audit verification — checks checkpoint chain integrity and
 * cross-references against the attachment store.
 *
 * @param projectRoot - Absolute project root path.
 * @returns Verification result with findings.
 */
export function verifyAuditTrail(projectRoot: string): AuditVerifyResult {
  const findings: AuditFinding[] = [];
  const auditResult = readAuditLog(projectRoot);

  // Check 1: Chain integrity
  if (!auditResult.chainIntact) {
    findings.push({
      severity: 'error',
      message: `Audit log checkpoint chain broken at entry index ${auditResult.chainBrokenAt}. ` +
        `Entries after this point cannot be verified as authentic.`,
      entryIndex: auditResult.chainBrokenAt,
    });
  }

  // Check 2: Timestamp monotonicity
  for (let i = 1; i < auditResult.entries.length; i++) {
    if (auditResult.entries[i].ts < auditResult.entries[i - 1].ts) {
      findings.push({
        severity: 'warning',
        message: `Non-monotonic timestamps: entry ${i} (${auditResult.entries[i].ts}) ` +
          `is earlier than entry ${i - 1} (${auditResult.entries[i - 1].ts}).`,
        entryIndex: i,
      });
    }
  }

  // Check 3: No duplicate operations on same slug within 1 second (race detection)
  const seenOps = new Map<string, number>();
  for (let i = 0; i < auditResult.entries.length; i++) {
    const entry = auditResult.entries[i];
    if (!entry.slug || !entry.attachmentId) continue;

    const key = `${entry.op}:${entry.slug}:${entry.attachmentId}`;
    const prevIdx = seenOps.get(key);

    if (prevIdx !== undefined && i - prevIdx <= 1) {
      // Adjacent entries with same op+slug+attachmentId — possible race
      const prevEntry = auditResult.entries[prevIdx];
      if (Math.abs(Date.parse(entry.ts) - Date.parse(prevEntry.ts)) < 1000) {
        findings.push({
          severity: 'warning',
          message: `Possible race condition: entries ${prevIdx} and ${i} ` +
            `have same op="${entry.op}", slug="${entry.slug}", attachmentId="${entry.attachmentId}" ` +
            `within 1 second.`,
          entryIndex: i,
          slug: entry.slug,
        });
      }
    }
    seenOps.set(key, i);
  }

  return {
    consistent: findings.filter((f) => f.severity === 'error').length === 0,
    entriesExamined: auditResult.entries.length,
    chainIntact: auditResult.chainIntact,
    findings,
  };
}

/**
 * Count audit entries for a specific slug.
 *
 * @param projectRoot - Absolute project root path.
 * @param slug - Slug to count entries for.
 * @returns Number of audit entries referencing this slug.
 */
export function countAuditEntriesForSlug(projectRoot: string, slug: string): number {
  const result = readAuditLog(projectRoot, slug);
  return result.entries.length;
}
