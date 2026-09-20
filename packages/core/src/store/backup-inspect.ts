/**
 * Backup bundle inspect primitives (SDK).
 *
 * Manifest parsing helpers and exact read-only observation inspection.
 *
 * Manifest helpers were extracted from
 * `packages/cleo/src/cli/commands/backup-inspect.ts` per the AGENTS.md
 * Package-Boundary Check (T9985 / E8-CLI-LAYERING). The snapshot inspector
 * accepts explicit paths, validates a private copy through the canonical opener,
 * and returns provenance without live-store routing or CLI rendering.
 *
 * The CLI command file retains the orchestrator (`inspectAction`,
 * `inspectTarball`, `printInspectReport`) because those bind to
 * {@link cliError}, {@link humanLine}, and `process.exitCode`.
 *
 * Spec: T311-backup-portability-spec.md §5.3.
 *
 * @task T9985
 * @epic T9985 (E8-CLI-LAYERING)
 * @saga T9977 (SG-WORKTRUNK-OWN)
 * @see packages/cleo/src/cli/commands/backup-inspect.ts — CLI orchestrator
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type {
  BackupObservationInspectFailure,
  BackupObservationInspection,
  BackupObservationInspectOptions,
  BackupObservationRecord,
  BackupObservationValue,
} from '@cleocode/contracts';
import { openCleoDbSnapshot } from './open-cleo-db.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Magic string that identifies a CLEO encrypted bundle (ASCII "CLEOENC1"). */
export const CLEO_ENC_MAGIC = 'CLEOENC1';

/** Byte offset of the format-version byte in the encrypted header. */
export const ENC_VERSION_OFFSET = 8;

/** Supported encrypted-bundle format version. */
export const ENC_VERSION_SUPPORTED = 0x01;

/** Total fixed overhead of the encrypted bundle header (76 bytes) + auth tag (16 bytes). */
export const ENC_MIN_LENGTH = 8 + 1 + 7 + 32 + 12 + 16;

// ---------------------------------------------------------------------------
// Tar parsing helpers
// ---------------------------------------------------------------------------

/** Size of a single POSIX tar header block in bytes. */
const TAR_BLOCK_SIZE = 512;

/** Byte offset of the filename field in a tar header. */
const TAR_NAME_OFFSET = 0;

/** Byte length of the filename field in a tar header. */
const TAR_NAME_LENGTH = 100;

/** Byte offset of the file size (octal ASCII) in a tar header. */
const TAR_SIZE_OFFSET = 124;

/** Byte length of the file size field in a tar header. */
const TAR_SIZE_LENGTH = 12;

/** Byte offset of the type flag in a tar header. */
const TAR_TYPE_OFFSET = 156;

/**
 * Reads `manifest.json` from an already-decompressed tar buffer (i.e., the
 * raw tar bytes after gunzip). Stops as soon as the entry is found, honoring
 * the spec requirement that `manifest.json` MUST be the first entry.
 *
 * Returns `null` if the entry is not found in the buffer.
 *
 * @param tarBuf - Raw (uncompressed) tar bytes.
 * @returns UTF-8 content of `manifest.json`, or `null` if not found.
 * @task T363
 * @epic T311
 * @public
 */
export function extractManifestFromTar(tarBuf: Buffer): string | null {
  let offset = 0;

  while (offset + TAR_BLOCK_SIZE <= tarBuf.length) {
    const header = tarBuf.subarray(offset, offset + TAR_BLOCK_SIZE);

    // Detect end-of-archive (two consecutive zero-filled 512-byte blocks).
    if (header.every((b) => b === 0)) {
      break;
    }

    // Read filename (null-terminated within the 100-byte field).
    const rawName = header.subarray(TAR_NAME_OFFSET, TAR_NAME_OFFSET + TAR_NAME_LENGTH);
    const nullIdx = rawName.indexOf(0);
    const entryName = rawName
      .subarray(0, nullIdx === -1 ? TAR_NAME_LENGTH : nullIdx)
      .toString('utf8');

    // Read type flag (regular file = '0' or '\0').
    const typeFlag = String.fromCharCode(header[TAR_TYPE_OFFSET] ?? 0);
    const isRegular = typeFlag === '0' || typeFlag === '\0';

    // Read file size (null-terminated octal ASCII within 12-byte field).
    const rawSize = header
      .subarray(TAR_SIZE_OFFSET, TAR_SIZE_OFFSET + TAR_SIZE_LENGTH)
      .toString('utf8')
      .replace(/\0/g, '')
      .trim();
    const fileSize = parseInt(rawSize, 8);

    offset += TAR_BLOCK_SIZE;

    const normalizedName = entryName.replace(/^\.\//, '');

    if (isRegular && normalizedName === 'manifest.json') {
      if (offset + fileSize > tarBuf.length) {
        return null;
      }
      return tarBuf.subarray(offset, offset + fileSize).toString('utf8');
    }

    // Advance past file data (rounded up to 512-byte boundary).
    if (!Number.isNaN(fileSize) && fileSize > 0) {
      offset += Math.ceil(fileSize / TAR_BLOCK_SIZE) * TAR_BLOCK_SIZE;
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Integrity helpers
// ---------------------------------------------------------------------------

/**
 * Verifies `manifest.json` content against its embedded `integrity.manifestHash`.
 *
 * Per spec §4.2 Layer 2: the hash is SHA-256 of the manifest JSON with
 * `manifestHash` set to `""`, then hex-encoded.
 *
 * @param raw - Raw manifest.json UTF-8 string as extracted from the bundle.
 * @param manifest - Parsed manifest object.
 * @returns `true` if the hash matches; `false` if tampered or field absent.
 * @task T363
 * @epic T311
 * @public
 */
export function verifyManifestHash(raw: string, manifest: Record<string, unknown>): boolean {
  const integrity = manifest['integrity'] as Record<string, unknown> | undefined;
  if (!integrity || typeof integrity['manifestHash'] !== 'string') {
    return false;
  }

  const expectedHash = integrity['manifestHash'] as string;

  // Re-parse the raw JSON, zero out manifestHash, serialize, and hash.
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return false;
  }

  const intObj = obj['integrity'] as Record<string, unknown>;
  intObj['manifestHash'] = '';
  const forHashing = JSON.stringify(obj);
  const computed = crypto.createHash('sha256').update(forHashing).digest('hex');

  return computed === expectedHash;
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

/**
 * Formats a byte count into a human-readable string (B, KB, MB).
 *
 * @param bytes - Raw byte count.
 * @returns Formatted string such as `"5.0 MB"` or `"512 B"`.
 * @task T363
 * @epic T311
 * @public
 */
export function fmtBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }
  if (bytes >= 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${bytes} B`;
}

// ---------------------------------------------------------------------------
// Encrypted-bundle detect
// ---------------------------------------------------------------------------

/**
 * Tests whether the file at `filePath` starts with the CLEO encrypted bundle
 * magic bytes ("CLEOENC1"). Reads only 8 bytes.
 *
 * @param filePath - Absolute path to the bundle file.
 * @returns `true` if the file is an encrypted CLEO bundle.
 * @task T363
 * @epic T311
 * @public
 */
export function detectEncryption(filePath: string): boolean {
  const header = Buffer.alloc(8);
  const fd = fs.openSync(filePath, 'r');
  try {
    fs.readSync(fd, header, 0, 8, 0);
  } finally {
    fs.closeSync(fd);
  }
  return header.toString('utf8') === CLEO_ENC_MAGIC;
}

/** Explicit inspection failure; callers must not translate this into not-found. */
export class BackupObservationInspectionError extends Error {
  /**
   * Construct a scoped inspection diagnostic.
   * @param code - Stable failure category.
   * @param message - Specific refusal or observed failure.
   * @remarks No error category establishes absence of the requested record.
   * @example
   * ```ts
   * throw new BackupObservationInspectionError('SOURCE_CHANGED', 'Snapshot changed during copy.');
   * ```
   */
  constructor(
    public readonly code: BackupObservationInspectFailure,
    message: string,
  ) {
    super(message);
    this.name = 'BackupObservationInspectionError';
  }
}

/**
 * Reject an unproven inspection state without inventing a missing-record result.
 * @param code - Stable diagnostic category.
 * @param message - Observed reason for refusal.
 * @returns Never; throws the typed inspection error.
 * @remarks Failure is distinct from a successful lookup returning no row.
 * @example
 * ```ts
 * inspectionFailure('SOURCE_CHANGED', 'Snapshot was replaced.');
 * ```
 */
function inspectionFailure(code: BackupObservationInspectFailure, message: string): never {
  throw new BackupObservationInspectionError(code, message);
}

/**
 * Validate one caller-supplied byte ceiling before touching the filesystem.
 * @param value - Optional requested bound.
 * @param fallback - Default when the caller omitted a bound.
 * @param ceiling - Maximum accepted bound.
 * @returns Validated positive integer bound.
 * @remarks Nonfinite, fractional and oversized values are rejected.
 * @example
 * ```ts
 * const limit = inspectionBound(1024, 2048, 4096);
 * ```
 */
function inspectionBound(value: number | undefined, fallback: number, ceiling: number): number {
  const bound = value ?? fallback;
  if (!Number.isSafeInteger(bound) || bound <= 0 || bound > ceiling)
    inspectionFailure('INVALID_INPUT', `Byte limit must be an integer in 1..${ceiling}.`);
  return bound;
}

/**
 * Reject unresolved SQLite companions instead of silently discarding committed WAL data.
 * @param source - Canonical path of the source snapshot.
 * @returns Resolves only if every supported companion path is absent.
 * @remarks Even empty companions require a separately verified coherent snapshot.
 * @example
 * ```ts
 * await rejectSnapshotJournals('/authorized/snapshot.db');
 * ```
 */
async function rejectSnapshotJournals(source: string): Promise<void> {
  for (const suffix of ['-wal', '-shm', '-journal']) {
    try {
      await fs.promises.lstat(source + suffix);
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') continue;
      throw error;
    }
    inspectionFailure('JOURNAL_PRESENT', `Unresolved snapshot companion: ${source}${suffix}`);
  }
}

/**
 * Quote a schema-derived column name; callers cannot supply an SQL expression.
 * @param name - Actual stored column or index name.
 * @returns SQLite identifier with embedded quotes escaped.
 * @remarks Only allowlisted tables are queried; this helper never quotes table input.
 * @example
 * ```ts
 * const identifier = snapshotColumn('narrative');
 * ```
 */
function snapshotColumn(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

/**
 * Read one eligible table using exact binary equality and a proven unique index.
 * @param db - Caller-owned private read-only snapshot handle.
 * @param table - Allowlisted ordinary observation table.
 * @param recordId - Exact textual identity.
 * @param payloadLimit - Maximum stored payload size in bytes.
 * @returns Authentic lossless row, or null after an eligible exact lookup.
 * @remarks Unsupported schemas fail rather than implying absence. TEXT and BLOB
 * bytes are captured without UTF-8 decoding, and INTEGER precision is retained.
 * @example
 * ```ts
 * const row = readSnapshotObservation(snapshot.db, 'brain_observations', 'O-1', 1048576);
 * ```
 */
function readSnapshotObservation(
  db: ReturnType<typeof openCleoDbSnapshot>['db'],
  table: 'brain_observations' | 'observations',
  recordId: string,
  payloadLimit: number,
): BackupObservationRecord | null {
  const columns = db.prepare(`PRAGMA main.table_xinfo(${table})`).all();
  if (
    columns.length === 0 ||
    columns.length > 256 ||
    columns.some((column) => column.hidden !== 0 || typeof column.name !== 'string')
  )
    inspectionFailure('UNSUPPORTED_SCHEMA', `${table} requires 1..256 ordinary stored columns.`);
  const id = columns.find((column) => column.name === 'id');
  if (!id || typeof id.type !== 'string' || id.type.toUpperCase() !== 'TEXT')
    inspectionFailure('UNSUPPORTED_SCHEMA', `${table} requires a TEXT id column.`);
  const indexes = db.prepare(`PRAGMA main.index_list(${table})`).all();
  const uniqueId = indexes.some((index) => {
    if (index.unique !== 1 || index.partial !== 0 || typeof index.name !== 'string') return false;
    const parts = db
      .prepare(`PRAGMA main.index_xinfo(${snapshotColumn(index.name)})`)
      .all()
      .filter((part) => part.key === 1);
    return parts.length === 1 && parts[0]?.name === 'id' && parts[0]?.coll === 'BINARY';
  });
  if (!uniqueId)
    inspectionFailure('UNSUPPORTED_SCHEMA', `${table} lacks a unique binary id index.`);
  const where = "WHERE id = ? COLLATE BINARY AND typeof(id) = 'text'";
  const plan = db.prepare(`EXPLAIN QUERY PLAN SELECT id FROM main.${table} ${where}`).all(recordId);
  if (plan.some((step) => typeof step.detail !== 'string' || !step.detail.startsWith('SEARCH ')))
    inspectionFailure('UNSUPPORTED_SCHEMA', `${table} exact lookup requires an indexed SEARCH.`);
  const names = columns.map((column) => String(column.name)).sort();
  const sizeExpression = names
    .map((name) => `coalesce(length(CAST(${snapshotColumn(name)} AS BLOB)),0)`)
    .join('+');
  const size = db
    .prepare(`SELECT ${sizeExpression} AS bytes FROM main.${table} ${where}`)
    .get(recordId);
  if (!size) return null;
  if (typeof size.bytes !== 'number' || size.bytes > payloadLimit)
    inspectionFailure('PAYLOAD_LIMIT', `Observation payload exceeds ${payloadLimit} bytes.`);
  const expressions = names.flatMap((name, index) => {
    const quoted = snapshotColumn(name);
    return [
      `typeof(${quoted}) AS t${index}`,
      `CASE WHEN typeof(${quoted}) IN ('text','blob') THEN hex(CAST(${quoted} AS BLOB)) ELSE ${quoted} END AS v${index}`,
    ];
  });
  const query = db.prepare(`SELECT ${expressions.join(',')} FROM main.${table} ${where}`);
  query.setReadBigInts(true);
  const row = query.get(recordId);
  if (!row)
    inspectionFailure('INVALID_SNAPSHOT', 'Observation disappeared inside the private snapshot.');
  const entries: Array<[string, BackupObservationValue]> = names.map((name, index) => {
    const type = row[`t${index}`];
    const value = row[`v${index}`];
    if (type === 'null' && value === null) return [name, { type: 'null' }];
    if (type === 'integer' && typeof value === 'bigint')
      return [name, { type, decimal: value.toString() }];
    if (type === 'real' && typeof value === 'number') {
      const bytes = Buffer.alloc(8);
      bytes.writeDoubleBE(value);
      return [name, { type, ieee754Hex: bytes.toString('hex') }];
    }
    if ((type === 'text' || type === 'blob') && typeof value === 'string')
      return [name, { type, bytesBase64: Buffer.from(value, 'hex').toString('base64') }];
    return inspectionFailure('INVALID_SNAPSHOT', `Unsupported stored value in ${table}.${name}.`);
  });
  return {
    table,
    payload: Object.fromEntries(entries),
    payloadSha256: crypto.createHash('sha256').update(JSON.stringify(entries)).digest('hex'),
    payloadBytes: size.bytes,
  };
}

/**
 * Inspect one exact historical observation without opening or restoring a live store.
 * @param options - Explicit snapshot identity, record ID and byte ceilings.
 * @returns Scoped authentic payload and provenance, or scoped not-found.
 * @throws BackupObservationInspectionError - The source, schema, identity or bounds are unproven.
 * @remarks Linux O_NOATIME/O_NOFOLLOW preserves source timestamps. Unsupported platforms
 * fail explicitly. Queries are synchronous and are not claimed to be preemptible;
 * source/payload sizes and indexed exact lookups bound the accepted workload.
 * @example
 * ```ts
 * const evidence = await inspectBackupObservation({
 *   snapshotPath: '/authorized/backups/tasks-20260919-120000.db',
 *   recordId: 'O-mspmgvbg-0',
 * });
 * // evidence.status concerns only evidence.inspectedTables in this snapshot.
 * ```
 */
export async function inspectBackupObservation(
  options: BackupObservationInspectOptions,
): Promise<BackupObservationInspection> {
  const sourceLimit = inspectionBound(options.maxSnapshotBytes, 512 * 1024 ** 2, 1024 ** 3);
  const payloadLimit = inspectionBound(options.maxPayloadBytes, 1024 ** 2, 16 * 1024 ** 2);
  if (
    !path.isAbsolute(options.snapshotPath) ||
    !options.recordId ||
    Buffer.byteLength(options.recordId) > 512 ||
    options.recordId.includes('\0')
  )
    inspectionFailure(
      'INVALID_INPUT',
      'An absolute snapshot path and exact nonempty ID up to 512 bytes are required.',
    );
  if (
    options.expectedProjectId !== undefined &&
    (!options.expectedProjectId || Buffer.byteLength(options.expectedProjectId) > 512)
  )
    inspectionFailure(
      'INVALID_INPUT',
      'Expected project identity must be nonempty and at most 512 bytes.',
    );
  if (process.platform !== 'linux' || !fs.constants.O_NOATIME || !fs.constants.O_NOFOLLOW)
    inspectionFailure(
      'UNSUPPORTED_SOURCE',
      'Timestamp-preserving inspection requires Linux O_NOATIME and O_NOFOLLOW.',
    );
  let temporary: string | undefined;
  let handle: fs.promises.FileHandle | undefined;
  let snapshot: ReturnType<typeof openCleoDbSnapshot> | undefined;
  try {
    const source = await fs.promises.realpath(options.snapshotPath);
    if (source !== path.resolve(options.snapshotPath))
      inspectionFailure(
        'UNSUPPORTED_SOURCE',
        'Snapshot symlinks or ambiguous source paths are unsupported.',
      );
    await rejectSnapshotJournals(source);
    const before = await fs.promises.lstat(source, { bigint: true });
    if (!before.isFile())
      inspectionFailure('UNSUPPORTED_SOURCE', 'Snapshot must be an ordinary file.');
    if (before.size > BigInt(sourceLimit))
      inspectionFailure('SOURCE_LIMIT', `Snapshot exceeds ${sourceLimit} bytes.`);
    handle = await fs.promises.open(
      source,
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NOATIME,
    );
    const same = (current: fs.BigIntStats): boolean =>
      ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs', 'atimeNs'].every((key) => {
        const name = key as 'dev' | 'ino' | 'size' | 'mtimeNs' | 'ctimeNs' | 'atimeNs';
        return current[name] === before[name];
      });
    if (!same(await handle.stat({ bigint: true })))
      inspectionFailure('SOURCE_CHANGED', 'Snapshot changed before opening.');
    temporary = await fs.promises.mkdtemp(path.join(tmpdir(), 'cleo-observation-inspect-'));
    const copy = path.join(temporary, 'snapshot.db');
    const destination = await fs.promises.open(copy, 'wx', 0o600);
    const buffer = Buffer.alloc(1024 ** 2);
    const hash = crypto.createHash('sha256');
    let position = 0;
    try {
      while (position < Number(before.size)) {
        const { bytesRead } = await handle.read(
          buffer,
          0,
          Math.min(buffer.length, Number(before.size) - position),
          position,
        );
        if (bytesRead === 0) inspectionFailure('SOURCE_CHANGED', 'Snapshot truncated during copy.');
        hash.update(buffer.subarray(0, bytesRead));
        let written = 0;
        while (written < bytesRead) {
          const result = await destination.write(
            buffer,
            written,
            bytesRead - written,
            position + written,
          );
          if (!result.bytesWritten)
            inspectionFailure('INVALID_SNAPSHOT', 'Private snapshot write made no progress.');
          written += result.bytesWritten;
        }
        position += bytesRead;
      }
    } finally {
      await destination.close();
    }
    const sourceHash = hash.digest('hex');
    const copyReader = await fs.promises.open(copy, 'r');
    const copyHash = crypto.createHash('sha256');
    try {
      let offset = 0;
      while (offset < position) {
        const { bytesRead } = await copyReader.read(
          buffer,
          0,
          Math.min(buffer.length, position - offset),
          offset,
        );
        if (!bytesRead)
          inspectionFailure('SOURCE_CHANGED', 'Private snapshot truncated during verification.');
        copyHash.update(buffer.subarray(0, bytesRead));
        offset += bytesRead;
      }
    } finally {
      await copyReader.close();
    }
    const copiedHash = copyHash.digest('hex');
    if (copiedHash !== sourceHash)
      inspectionFailure('SOURCE_CHANGED', 'Private snapshot hash mismatch.');
    const recheck = async (): Promise<void> => {
      if (
        !handle ||
        !same(await handle.stat({ bigint: true })) ||
        !same(await fs.promises.lstat(source, { bigint: true }))
      )
        inspectionFailure('SOURCE_CHANGED', 'Source snapshot identity or timestamps changed.');
      await rejectSnapshotJournals(source);
    };
    await recheck();
    snapshot = openCleoDbSnapshot(copy, { readOnly: true, applyPragmas: false });
    snapshot.db.exec('PRAGMA trusted_schema=OFF; PRAGMA query_only=ON');
    const integrity = snapshot.db.prepare('PRAGMA integrity_check(1)').all();
    if (integrity.length !== 1 || integrity[0]?.integrity_check !== 'ok')
      inspectionFailure('INVALID_SNAPSHOT', 'Snapshot integrity_check did not return ok.');
    const schemas = snapshot.db
      .prepare(
        "SELECT name, type, sql FROM main.sqlite_schema WHERE name IN ('brain_observations','observations')",
      )
      .all();
    if (schemas.length === 0)
      inspectionFailure('UNSUPPORTED_SCHEMA', 'No supported observation table exists.');
    const inspected: BackupObservationInspection['inspectedTables'] = [];
    let record: BackupObservationRecord | null = null;
    for (const schema of schemas) {
      if (
        (schema.name !== 'brain_observations' && schema.name !== 'observations') ||
        schema.type !== 'table' ||
        typeof schema.sql !== 'string' ||
        /\bCREATE\s+VIRTUAL\b/i.test(schema.sql)
      )
        inspectionFailure(
          'UNSUPPORTED_SCHEMA',
          'Observation lookup requires ordinary stored tables.',
        );
      const candidate = readSnapshotObservation(
        snapshot.db,
        schema.name,
        options.recordId,
        payloadLimit,
      );
      inspected.push(schema.name);
      if (candidate && record)
        inspectionFailure(
          'AMBIGUOUS_RECORD',
          'Exact identity exists in multiple observation tables.',
        );
      record = candidate ?? record;
    }
    const project = record?.payload.project_id;
    const recorded =
      project?.type === 'text' ? Buffer.from(project.bytesBase64, 'base64').toString('utf8') : null;
    if (
      project &&
      project.type !== 'null' &&
      (project.type !== 'text' ||
        !recorded ||
        Buffer.from(recorded).toString('base64') !== project.bytesBase64)
    )
      inspectionFailure('UNSUPPORTED_SCHEMA', 'Recorded project_id must be nonempty UTF-8 text.');
    if (recorded && options.expectedProjectId && recorded !== options.expectedProjectId)
      inspectionFailure(
        'PROJECT_MISMATCH',
        'Observation project_id conflicts with the requested project identity.',
      );
    const version = snapshot.db.prepare('PRAGMA user_version').get()?.user_version;
    if (typeof version !== 'number')
      inspectionFailure('INVALID_SNAPSHOT', 'Snapshot user_version is unreadable.');
    await recheck();
    return {
      status: record ? 'found' : 'not-found',
      recordId: options.recordId,
      source: {
        path: source,
        label: options.label ?? null,
        sha256: sourceHash,
        bytes: Number(before.size),
        mtimeNs: before.mtimeNs.toString(),
        ctimeNs: before.ctimeNs.toString(),
        atimeNs: before.atimeNs.toString(),
      },
      userVersion: version,
      inspectedTables: inspected.sort(),
      projectIdentity: {
        expected: options.expectedProjectId ?? null,
        recorded,
        status: recorded ? (options.expectedProjectId ? 'matched' : 'recorded') : 'unknown',
        evidence: recorded && record ? `${record.table}.project_id` : null,
      },
      record,
      limitations: [
        'Only the named supported tables in this exact snapshot were inspected; not-found is not exhaustive backup absence.',
        'Recorded project_id is historical row provenance, not independently authenticated ownership; matching the caller expectation does not promote authority.',
        'Filename labels and project/name fields do not establish stable project identity.',
        'Synchronous SQLite work is size-bounded, not deadline-preempted; integrity_check does not validate every application invariant.',
        'Payload hash covers the documented lossless value representation, not an original SQLite row byte span.',
      ],
    };
  } catch (error) {
    if (error instanceof BackupObservationInspectionError) throw error;
    inspectionFailure('INVALID_SNAPSHOT', error instanceof Error ? error.message : String(error));
  } finally {
    try {
      snapshot?.close();
    } finally {
      try {
        await handle?.close();
      } finally {
        if (temporary) await fs.promises.rm(temporary, { recursive: true, force: true });
      }
    }
  }
}
