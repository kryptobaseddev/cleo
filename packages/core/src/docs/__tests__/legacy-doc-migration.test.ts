/**
 * T13360 — honest legacy docs migration, proven against a seeded fixture
 * store and through the T13448 safety harness.
 *
 * Fixture shapes:
 *   - healthy blob doc with two audit events (real authors)  → 2 versions
 *   - healthy local-file doc with no audit log                → 1 base version
 *   - dangling local-file pointer, bytes recoverable by sha  → captured (recovered)
 *   - dangling local-file pointer, bytes gone                → ledger 'dangling'
 *   - ephemeral (tmp) pointer, bytes recoverable             → captured (recovered)
 *   - already-migrated doc (ledger row pre-seeded)           → skipped
 *
 * Assertions cover every AC: origin:migrated labels (AC1), real-or-system
 * authors with no fabrication (AC2), dangling capture-or-record (AC3), and a
 * second run that is a verified no-op — byte- and fingerprint-identical
 * conduit tables (AC4).
 *
 * @task T13360
 */

import { createHash } from 'node:crypto';
import { appendFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestDb, type TestDbEnv } from '../../store/__tests__/test-db-helper.js';
import { blobFilePath } from '../../store/blob-keep.js';
import {
  listConduitAttachmentVersions,
  listConduitDocMigrations,
  recordConduitDocMigration,
  resolveConduitDocUid,
} from '../../store/conduit-doc-history.js';
import { fingerprintTable } from '../../store/migration-safety.js';
import {
  conduitAttachments,
  conduitAttachmentVersions,
  conduitDocHeads,
} from '../../store/schema/cleo-project/conduit.js';
import { getDb, getNativeDb } from '../../store/sqlite.js';
import { docsAttachments } from '../../store/tasks-schema.js';
import { DOCS_AUDIT_FILE, writeAuditEntry } from '../docs-audit.js';
import {
  deriveLegacyDocMigrationPlan,
  MIGRATION_SYSTEM_AUTHOR,
  runLegacyDocMigration,
} from '../legacy-doc-migration.js';

let env: TestDbEnv;
let db: NonNullable<ReturnType<typeof getNativeDb>>;

const MIME = 'text/markdown';

function sha(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** Write bytes into the content-addressed blob store and return the sha. */
function seedBlob(bytes: Buffer): string {
  const hash = sha(bytes);
  const path = blobFilePath(env.cleoDir, hash, MIME);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, bytes);
  return hash;
}

/** Seed one legacy docs_attachments row. */
async function seedLegacyDoc(opts: {
  slug: string;
  payload: Record<string, unknown>;
  sha256: string;
  summary?: string;
}): Promise<void> {
  const store = await getDb(env.tempDir);
  await store
    .insert(docsAttachments)
    .values({
      id: `att-${opts.slug}`,
      sha256: opts.sha256,
      attachmentJson: JSON.stringify(opts.payload),
      ...(opts.summary !== undefined ? { summary: opts.summary } : {}),
      slug: opts.slug,
      createdAt: '2026-09-01T00:00:00.000Z',
    })
    .run();
}

beforeEach(async () => {
  env = await createTestDb();
  const native = getNativeDb(env.tempDir);
  if (!native) throw new Error('expected a native handle');
  db = native;
});

afterEach(async () => {
  await env.cleanup();
});

describe('legacy docs migration (T13360)', () => {
  it('imports docs honestly: origin labels, real authors, dangling capture-or-record', async () => {
    // ── fixture ──
    const v1Bytes = Buffer.from('# Doc A\nfirst revision body');
    const v2Bytes = Buffer.from('# Doc A\nsecond revision body');
    const v1Sha = seedBlob(v1Bytes);
    const v2Sha = seedBlob(v2Bytes);
    // Healthy blob doc with real audit history (two authors, real shas).
    await seedLegacyDoc({
      slug: 'doc-a',
      sha256: v2Sha,
      summary: 'Doc A',
      payload: { kind: 'blob', mime: MIME },
    });
    writeAuditEntry(env.tempDir, {
      op: 'docs.add',
      slug: 'doc-a',
      sha256: v1Sha,
      actor: 'agent-reviewer',
      summary: 'add doc-a',
    });
    writeAuditEntry(env.tempDir, {
      op: 'docs.update',
      slug: 'doc-a',
      sha256: v2Sha,
      actor: 'agent-editor',
      summary: 'update doc-a',
    });

    // Healthy local-file doc with NO audit provenance → base version. NOTE:
    // the fixture root lives under the OS tmp dir, so the doctor-parity
    // ephemeral rule classifies this pointer as 'path-ephemeral:tmp' even
    // though the file exists — the blob-store recovery branch captures it
    // (that recovery IS the production behavior for tmp pointers).
    const localBytes = Buffer.from('# Doc B\nlocal file body');
    const localPath = join(env.tempDir, 'docs-b.md');
    writeFileSync(localPath, localBytes);
    const localSha = sha(localBytes);
    seedBlob(localBytes); // bytes recoverable by sha → captured, not dangling
    await seedLegacyDoc({
      slug: 'doc-b',
      sha256: localSha,
      payload: { kind: 'local-file', path: 'docs-b.md', mime: MIME },
    });

    // Dangling pointer, bytes recoverable from the blob store by sha.
    const recBytes = Buffer.from('# Doc C\nrecovered body');
    const recSha = seedBlob(recBytes);
    await seedLegacyDoc({
      slug: 'doc-c',
      sha256: recSha,
      payload: { kind: 'local-file', path: '/nonexistent-gone/doc-c.md', mime: MIME },
    });

    // Dangling pointer, bytes gone → must be RECORDED dangling.
    await seedLegacyDoc({
      slug: 'doc-d',
      sha256: 'f'.repeat(64),
      payload: { kind: 'local-file', path: '/nonexistent-gone/doc-d.md', mime: MIME },
    });

    // Ephemeral (tmp) pointer — file EXISTS in tmp (the ephemeral rule fires
    // on existence, not absence); bytes recoverable → captured with reason.
    const tmpBytes = Buffer.from('# Doc E\ntmp body');
    const tmpSha = seedBlob(tmpBytes);
    const tmpPointer = join(tmpdir(), `doc-e-${process.pid}.md`);
    writeFileSync(tmpPointer, tmpBytes);
    await seedLegacyDoc({
      slug: 'doc-e',
      sha256: tmpSha,
      payload: { kind: 'local-file', path: tmpPointer, mime: MIME },
    });

    // Already migrated → skipped.
    await seedLegacyDoc({
      slug: 'doc-f',
      sha256: v1Sha,
      payload: { kind: 'blob', mime: MIME },
    });
    await recordConduitDocMigration(env.tempDir, {
      slug: 'doc-f',
      docUid: 'uid-already',
      status: 'captured',
      reason: 'captured',
      versionsImported: 1,
    });

    // Native conduit doc sharing a legacy slug → explicit native-conflict
    // skip: never clobbered, no ledger receipt, counted separately (T13633).
    const nativeBytes = Buffer.from('# Native doc G');
    const store0 = await getDb(env.tempDir);
    await store0
      .insert(conduitAttachments)
      .values({
        slug: 'doc-g',
        conversationId: 'conv-native',
        fromAgentId: 'agent-native',
        content: nativeBytes,
        originalSize: nativeBytes.length,
        compressedSize: nativeBytes.length,
        contentHash: 'sha-native-g',
        format: 'markdown',
        tokens: 3,
        versionCount: 1,
        currentVersion: 1,
        createdAt: '2026-08-01T00:00:00.000Z',
        uid: 'uid-native-g',
      })
      .run();
    await seedLegacyDoc({
      slug: 'doc-g',
      sha256: 'e'.repeat(64), // never read — the native-conflict skip fires first
      payload: { kind: 'blob', mime: MIME },
    });

    // ── run 1 ──
    const result = await runLegacyDocMigration({
      projectRoot: env.tempDir,
      db,
      cwd: env.tempDir,
    });
    expect(result.report.status).toBe('completed');
    const step = result.report.steps[0];
    if (!step) throw new Error('expected a step report');
    expect(step.transaction).toBe('committed');
    expect(step.foreignKeyViolations).toBe(0);
    expect(step.failures).toEqual([]);
    expect(result.counts.toCapture).toBe(4); // a, b, c, e
    expect(result.counts.toMarkDangling).toBe(1); // d
    expect(result.counts.toSkip).toBe(1); // f
    expect(result.counts.nativeConflicts).toBe(1); // g
    rmSync(tmpPointer, { force: true }); // ephemeral fixture served its purpose

    // ── AC1: every imported history row is labeled origin:migrated ──
    const store = await getDb(env.tempDir);
    const versions = await store.select().from(conduitAttachmentVersions).all();
    expect(versions.length).toBe(5); // doc-a 2 + doc-b base + doc-c base + doc-e base
    for (const version of versions) {
      expect(version.origin).toBe('migrated');
    }

    // ── AC2: authors are real audit actors or the honest system attribution ──
    const docAVersions = versions
      .filter((v) => v.slug === 'doc-a')
      .sort((a, b) => a.versionNumber - b.versionNumber);
    expect(docAVersions.map((v) => v.authorAgentId)).toEqual(['agent-reviewer', 'agent-editor']);
    expect(docAVersions.map((v) => v.versionNumber)).toEqual([1, 2]);
    expect(docAVersions[1]?.parentVersionUid).toBe(docAVersions[0]?.uid);
    expect(docAVersions[0]?.parentVersionUid).toBeNull();
    const authors = new Set(versions.map((v) => v.authorAgentId));
    for (const author of authors) {
      expect(['agent-reviewer', 'agent-editor', MIGRATION_SYSTEM_AUTHOR]).toContain(author);
    }
    // No-invented-versions: doc-b has exactly one base version, system-attributed.
    const docBVersions = versions.filter((v) => v.slug === 'doc-b');
    expect(docBVersions).toHaveLength(1);
    expect(docBVersions[0]?.authorAgentId).toBe(MIGRATION_SYSTEM_AUTHOR);
    expect(docBVersions[0]?.changeSummary).toContain('no audit provenance');

    // ── doc rows: content captured, uid resolvable ──
    const docs = await store.select().from(conduitAttachments).all();
    expect(docs.map((d) => d.slug).sort()).toEqual(['doc-a', 'doc-b', 'doc-c', 'doc-e', 'doc-g']);
    const docA = docs.find((d) => d.slug === 'doc-a');
    expect(docA?.content?.toString('utf-8')).toBe(v2Bytes.toString('utf-8'));
    expect(docA?.versionCount).toBe(2);
    expect(docA?.fromAgentId).toBe('agent-editor');
    expect(await resolveConduitDocUid(env.tempDir, 'doc-a')).toBe(docA?.uid);
    // The captured bytes are the recovered (identical) content.
    const docB = docs.find((d) => d.slug === 'doc-b');
    expect(docB?.content?.toString('utf-8')).toBe(localBytes.toString('utf-8'));

    // Heads point at each doc's last version.
    const heads = await store.select().from(conduitDocHeads).all();
    expect(heads).toHaveLength(4);
    const headSlugs = new Set<string>();
    for (const head of heads) {
      headSlugs.add(head.attachmentUid);
      const last = versions.find((v) => v.uid === head.headVersionUid);
      expect(last).toBeDefined();
      const newer = versions.filter(
        (v) =>
          v.attachmentUid === head.attachmentUid && v.versionNumber > (last?.versionNumber ?? 0),
      );
      expect(newer).toHaveLength(0);
    }
    expect(headSlugs.size).toBe(4);

    // ── AC3: dangling doc recorded with an auditable row; captured ones too ──
    const ledger = await listConduitDocMigrations(env.tempDir);
    expect(ledger.map((l) => l.slug).sort()).toEqual([
      'doc-a',
      'doc-b',
      'doc-c',
      'doc-d',
      'doc-e',
      'doc-f',
    ]);
    // The native doc-g row is untouched and received NO ledger receipt.
    const nativeDoc = db
      .prepare(`SELECT uid, from_agent_id FROM conduit_attachments WHERE slug = 'doc-g'`)
      .get() as { uid: string; from_agent_id: string };
    expect(nativeDoc.uid).toBe('uid-native-g');
    expect(nativeDoc.from_agent_id).toBe('agent-native');
    const d = ledger.find((l) => l.slug === 'doc-d');
    expect(d?.status).toBe('dangling');
    expect(d?.reason).toBe('path-missing');
    expect(d?.legacyPath).toBe('/nonexistent-gone/doc-d.md');
    expect(d?.docUid).toBeNull();
    const c = ledger.find((l) => l.slug === 'doc-c');
    expect(c?.status).toBe('captured');
    expect(c?.reason).toBe('recovered:path-missing');
    expect(c?.versionsImported).toBe(1);
    const b = ledger.find((l) => l.slug === 'doc-b');
    expect(b?.status).toBe('captured');
    expect(b?.reason).toBe('recovered:path-ephemeral:tmp');
    const e = ledger.find((l) => l.slug === 'doc-e');
    expect(e?.status).toBe('captured');
    expect(e?.reason).toBe('recovered:path-ephemeral:tmp');

    // ── AC4: re-run is a verified no-op ──
    const before = {
      docs: fingerprintTable(db, 'conduit_attachments'),
      versions: fingerprintTable(db, 'conduit_attachment_versions'),
      heads: fingerprintTable(db, 'conduit_doc_heads'),
      ledger: fingerprintTable(db, 'conduit_doc_migration_ledger'),
    };
    const rerun = await runLegacyDocMigration({
      projectRoot: env.tempDir,
      db,
      cwd: env.tempDir,
    });
    expect(rerun.report.status).toBe('completed');
    expect(rerun.counts.toCapture).toBe(0);
    expect(rerun.counts.toMarkDangling).toBe(0);
    expect(rerun.counts.toSkip).toBe(6);
    expect(rerun.counts.nativeConflicts).toBe(1); // g is a native skip on every run
    const rerunStep = rerun.report.steps[0];
    expect(rerunStep?.transaction).toBe('committed');
    expect(fingerprintTable(db, 'conduit_attachments')).toEqual(before.docs);
    expect(fingerprintTable(db, 'conduit_attachment_versions')).toEqual(before.versions);
    expect(fingerprintTable(db, 'conduit_doc_heads')).toEqual(before.heads);
    expect(fingerprintTable(db, 'conduit_doc_migration_ledger')).toEqual(before.ledger);
    // Still exactly 5 versions — nothing duplicated.
    const store2 = await getDb(env.tempDir);
    expect((await store2.select().from(conduitAttachmentVersions).all()).length).toBe(5);
  });

  it('plan reports the same deltas the step will write (declared expectedDelta)', async () => {
    const bytes = Buffer.from('# Only doc');
    const hash = seedBlob(bytes);
    await seedLegacyDoc({ slug: 'solo', sha256: hash, payload: { kind: 'blob', mime: MIME } });
    const plan = await deriveLegacyDocMigrationPlan(env.tempDir);
    expect(plan.expectedDelta).toEqual({
      conduit_attachments: 1,
      conduit_attachment_versions: 1,
      conduit_doc_heads: 1,
      conduit_doc_migration_ledger: 1,
    });
    const result = await runLegacyDocMigration({
      projectRoot: env.tempDir,
      db,
      cwd: env.tempDir,
    });
    expect(result.report.status).toBe('completed');
    // The harness verified the declared deltas — a mismatch would have
    // rolled back and reported 'halted'.
    expect(result.report.steps[0]?.transaction).toBe('committed');
    expect(await listConduitDocMigrations(env.tempDir)).toHaveLength(1);
    const resolvedUid = await resolveConduitDocUid(env.tempDir, 'solo');
    const versions = await listConduitAttachmentVersions(env.tempDir, resolvedUid ?? '');
    expect(versions).toHaveLength(1);
    expect(versions[0]?.origin).toBe('migrated');
  });
});

/**
 * T13638 — the migrated version uid is a pure function of (doc uid, content
 * hash, event timestamp), never of the audit log's device-local row
 * position. These tests run the migration on independent stores whose
 * docs-audit.jsonl files hold the SAME events at DIFFERENT file positions
 * (and with device-specific noise events) and prove the migrations derive
 * identical uids — and that distinct contents can never collide.
 *
 * The two "devices" run SEQUENTIALLY: createTestDb owns process-global state
 * (the DB singleton and CLEO_DIR), so only one fixture store may be live at
 * a time.
 */
describe('content-derived version uids (T13638)', () => {
  /** A synthetic audit event (written directly, with an explicit timestamp). */
  interface AuditSpec {
    op: string;
    ts: string;
    actor: string;
    slug: string;
    sha256: string;
  }

  /** Write bytes into `target`'s blob store and return the sha. */
  function seedBlobIn(target: TestDbEnv, bytes: Buffer): string {
    const hash = sha(bytes);
    const path = blobFilePath(target.cleoDir, hash, MIME);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, bytes);
    return hash;
  }

  /** Seed one legacy docs_attachments row in `target`. */
  async function seedLegacyDocIn(
    target: TestDbEnv,
    opts: { slug: string; payload: Record<string, unknown>; sha256: string },
  ): Promise<void> {
    const store = await getDb(target.tempDir);
    await store
      .insert(docsAttachments)
      .values({
        id: `att-${opts.slug}`,
        sha256: opts.sha256,
        attachmentJson: JSON.stringify(opts.payload),
        slug: opts.slug,
        createdAt: '2026-09-01T00:00:00.000Z',
      })
      .run();
  }

  /**
   * Append one audit line directly, with an EXPLICIT timestamp (the public
   * writeAuditEntry stamps wall-clock time, which would differ across the
   * two seeded stores and defeat the comparison). The checkpoint value is a
   * placeholder: readAuditLog reports the chain broken but still returns
   * every entry, and the migration path reads only the event facts.
   */
  function writeAuditLine(projectRoot: string, entry: AuditSpec): void {
    const path = join(projectRoot, DOCS_AUDIT_FILE);
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(
      path,
      `${JSON.stringify({ ...entry, summary: `${entry.op} ${entry.slug}`, checkpoint: 'test' })}\n`,
    );
  }

  /** Run the migration in `target` and return slug → ordered version uids. */
  async function migrateAndCollectUids(target: TestDbEnv): Promise<Map<string, string[]>> {
    const native = getNativeDb(target.tempDir);
    if (!native) throw new Error('expected a native handle');
    const result = await runLegacyDocMigration({
      projectRoot: target.tempDir,
      db: native,
      cwd: target.tempDir,
    });
    expect(result.report.status).toBe('completed');
    const store = await getDb(target.tempDir);
    const versions = await store.select().from(conduitAttachmentVersions).all();
    const bySlug = new Map<string, string[]>();
    for (const version of versions.sort((a, b) => a.versionNumber - b.versionNumber)) {
      const slug = version.slug ?? '';
      bySlug.set(slug, [...(bySlug.get(slug) ?? []), version.uid]);
    }
    return bySlug;
  }

  it('derives identical version uids from two divergent device-local audit logs', async () => {
    const x1 = Buffer.from('# Doc X\nfirst revision');
    const x2 = Buffer.from('# Doc X\nsecond revision');
    const y1 = Buffer.from('# Doc Y\nonly revision');
    const x1Sha = sha(x1);
    const x2Sha = sha(x2);
    const y1Sha = sha(y1);
    // Fixed event instants — identical on both "devices".
    const xAddTs = '2026-09-10T10:00:00.000Z';
    const xUpdateTs = '2026-09-10T11:00:00.000Z';
    const yAddTs = '2026-09-10T09:30:00.000Z';

    // One shared fixture (same docs, same blobs, same event facts); only the
    // device-local audit log differs per run.
    const seedFixture = async (device: TestDbEnv): Promise<void> => {
      seedBlobIn(device, x1);
      seedBlobIn(device, x2);
      seedBlobIn(device, y1);
      await seedLegacyDocIn(device, {
        slug: 'doc-x',
        sha256: x2Sha,
        payload: { kind: 'blob', mime: MIME },
      });
      await seedLegacyDocIn(device, {
        slug: 'doc-y',
        sha256: y1Sha,
        payload: { kind: 'blob', mime: MIME },
      });
    };

    // Device A's log: doc-x's events sit at file positions 2 and 4, split
    // by a doc-y event. (Position-derived keys — the old 'evt-<i>' — would
    // mint 'evt-1'/'evt-3' here.)
    const deviceALog: AuditSpec[] = [
      {
        op: 'docs.add',
        ts: '2026-09-10T08:00:00.000Z',
        actor: 'agent-noise',
        slug: 'doc-a-only',
        sha256: '1'.repeat(64),
      },
      { op: 'docs.add', ts: xAddTs, actor: 'agent-author-a', slug: 'doc-x', sha256: x1Sha },
      { op: 'docs.add', ts: yAddTs, actor: 'agent-author-y', slug: 'doc-y', sha256: y1Sha },
      { op: 'docs.update', ts: xUpdateTs, actor: 'agent-author-b', slug: 'doc-x', sha256: x2Sha },
    ];

    // Device B's log: same doc-x events, but at file positions 1 and 2,
    // followed by noise A lacks and the doc-y event last. The old
    // derivation would mint 'evt-1'/'evt-2' — different uids for the same
    // logical versions.
    const deviceBLog: AuditSpec[] = [
      { op: 'docs.add', ts: xAddTs, actor: 'agent-author-a', slug: 'doc-x', sha256: x1Sha },
      { op: 'docs.update', ts: xUpdateTs, actor: 'agent-author-b', slug: 'doc-x', sha256: x2Sha },
      {
        op: 'docs.add',
        ts: '2026-09-10T12:00:00.000Z',
        actor: 'agent-noise',
        slug: 'doc-b-only',
        sha256: '2'.repeat(64),
      },
      { op: 'docs.add', ts: yAddTs, actor: 'agent-author-y', slug: 'doc-y', sha256: y1Sha },
    ];

    // The two devices run sequentially (createTestDb owns process-global
    // state); each result is captured before the next store opens.
    let uidsA: Map<string, string[]>;
    let docUidA: string | null;
    const deviceA = await createTestDb();
    try {
      await seedFixture(deviceA);
      for (const entry of deviceALog) writeAuditLine(deviceA.tempDir, entry);
      uidsA = await migrateAndCollectUids(deviceA);
      docUidA = await resolveConduitDocUid(deviceA.tempDir, 'doc-x');
    } finally {
      await deviceA.cleanup();
    }

    let uidsB: Map<string, string[]>;
    let docUidB: string | null;
    const deviceB = await createTestDb();
    try {
      await seedFixture(deviceB);
      for (const entry of deviceBLog) writeAuditLine(deviceB.tempDir, entry);
      uidsB = await migrateAndCollectUids(deviceB);
      docUidB = await resolveConduitDocUid(deviceB.tempDir, 'doc-x');
    } finally {
      await deviceB.cleanup();
    }

    // Same doc, same content, same event timestamps — IDENTICAL uids,
    // whatever the device-local audit position or noise.
    expect(uidsA.get('doc-x')).toEqual([...(uidsB.get('doc-x') ?? [])]);
    expect(uidsA.get('doc-y')).toEqual([...(uidsB.get('doc-y') ?? [])]);
    expect(uidsA.get('doc-x')).toHaveLength(2);
    // Doc identity was already device-independent and stays so.
    expect(docUidA).toBe(docUidB);
  });

  it('never collides: same instant with different contents derives different uids', async () => {
    const first = Buffer.from('# Doc C\ncontent one');
    const second = Buffer.from('# Doc C\ncontent two — different');
    const firstSha = sha(first);
    const secondSha = sha(second);
    const sameInstant = '2026-09-11T10:00:00.000Z';

    // The module-level fixture from beforeEach is not used here, but a fresh
    // store is required: createTestDb resets the singleton.
    const target = await createTestDb();
    try {
      seedBlobIn(target, first);
      seedBlobIn(target, second);
      await seedLegacyDocIn(target, {
        slug: 'doc-c',
        sha256: secondSha,
        payload: { kind: 'blob', mime: MIME },
      });
      // Two DISTINCT contents recorded at the SAME instant — the adversarial
      // case for a content-derived key. A third event repeats the second
      // event's content+instant exactly: one logical version, collapsed,
      // not a self-parented duplicate row.
      const log: AuditSpec[] = [
        { op: 'docs.add', ts: sameInstant, actor: 'agent-author', slug: 'doc-c', sha256: firstSha },
        {
          op: 'docs.update',
          ts: sameInstant,
          actor: 'agent-author',
          slug: 'doc-c',
          sha256: secondSha,
        },
        {
          op: 'docs.update',
          ts: sameInstant,
          actor: 'agent-author',
          slug: 'doc-c',
          sha256: secondSha,
        },
      ];
      for (const entry of log) writeAuditLine(target.tempDir, entry);

      const native = getNativeDb(target.tempDir);
      if (!native) throw new Error('expected a native handle');
      const result = await runLegacyDocMigration({
        projectRoot: target.tempDir,
        db: native,
        cwd: target.tempDir,
      });
      expect(result.report.status).toBe('completed');

      const docUid = await resolveConduitDocUid(target.tempDir, 'doc-c');
      const versions = await listConduitAttachmentVersions(target.tempDir, docUid ?? '');
      // The exact duplicate event collapsed: two versions, not three.
      expect(versions).toHaveLength(2);
      expect(new Set(versions.map((v) => v.uid)).size).toBe(2);
      const [v1, v2] = [versions[1], versions[0]]; // listConduitAttachmentVersions is newest-first
      expect(v1?.parentVersionUid).toBeNull();
      expect(v2?.parentVersionUid).toBe(v1?.uid);
      expect(v2?.changeSummary).toContain('collapsed 1 duplicate');
    } finally {
      await target.cleanup();
    }
  });
});
