/**
 * Tests for conduit-sqlite.ts — project-tier CONDUIT domain module.
 *
 * ## E6-L3 (T11523)
 *
 * `ensureConduitDb()` now routes through `openDualScopeDb('project')` — the
 * conduit domain lives inside the consolidated project `cleo.db`, not a standalone
 * `conduit.db`. The 16-table inline DDL blob was converted to the forward Drizzle
 * migration `drizzle-conduit/20260601000003_t11523-conduit-inline-schema`. The
 * BARE legacy tables (`conversations`, `messages`, …) co-exist with the
 * consolidated `conduit_*` tables (disjoint names — no drop/rebuild).
 *
 * These tests therefore:
 * - await the now-async `ensureConduitDb`,
 * - assert the consolidated `cleo.db` path,
 * - assert the legacy BARE tables are PRESENT (via arrayContaining) rather than
 *   the only tables (the shared cleo.db also holds `tasks_*` / `brain_*` /
 *   `conduit_*` / etc.),
 * - reset the shared dual-scope cache between cases for deterministic
 *   created/exists semantics.
 *
 * Uses real node:sqlite DatabaseSync (genuine SQLite operations, not mocks).
 * All filesystem interactions occur in tmp directories; the real user's
 * project root is never touched.
 *
 * @task T344
 * @task T11523
 * @epic T310
 * @epic T11249
 */

import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  applyConduitSchema,
  attachAgentToProject,
  CONDUIT_SCHEMA_VERSION,
  checkConduitDbHealth,
  closeConduitDb,
  detachAgentFromProject,
  ensureConduitDb,
  getConduitDbPath,
  getConduitNativeDb,
  getProjectAgentRef,
  listProjectAgentRefs,
  updateProjectAgentLastUsed,
} from '../conduit-sqlite.js';
import { _resetDualScopeDbCache, resolveDualScopeDbPath } from '../dual-scope-db.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * The legacy BARE conduit tables the forward migration creates. These now live
 * INSIDE the consolidated `cleo.db` alongside the prefixed `conduit_*` tables and
 * the `tasks_*` / `brain_*` domains, so we assert PRESENCE (arrayContaining)
 * rather than equality. `_conduit_meta` / `_conduit_migrations` are the two legacy
 * meta tables.
 */
const EXPECTED_LEGACY_TABLES = [
  '_conduit_meta',
  '_conduit_migrations',
  'attachment_approvals',
  'attachment_contributors',
  'attachment_versions',
  'attachments',
  'conversations',
  'dead_letters',
  'delivery_jobs',
  'message_pins',
  'messages',
  'project_agent_refs',
  'topic_message_acks',
  'topic_messages',
  'topic_subscriptions',
  'topics',
];

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('conduit-sqlite', () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'cleo-t344-'));
    // E6-L3: the path now resolves via resolveCleoDir(tmpRoot), which requires a
    // `.cleo/` directory to be present. Create it so the dual-scope resolver finds
    // the project root (the `cleo.db` file itself is created by ensureConduitDb).
    mkdirSync(join(tmpRoot, '.cleo'), { recursive: true });
    // Ensure each test starts with a clean singleton AND a clean shared
    // dual-scope cache so the consolidated cleo.db is re-opened per case
    // (deterministic created/exists semantics).
    closeConduitDb();
    _resetDualScopeDbCache();
  });

  afterEach(() => {
    closeConduitDb();
    _resetDualScopeDbCache();
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  // TC-001 — path resolution (E6-L3: consolidated cleo.db)
  it('getConduitDbPath resolves to the consolidated <projectRoot>/.cleo/cleo.db', () => {
    const expected = resolveDualScopeDbPath('project', tmpRoot);
    expect(getConduitDbPath(tmpRoot)).toBe(expected);
    expect(getConduitDbPath(tmpRoot)).toMatch(/\.cleo[/\\]cleo\.db$/);
  });

  // TC-002 — fresh install creates file + directory (in cleo.db)
  it('ensureConduitDb creates .cleo/ dir and cleo.db on a fresh project root', async () => {
    expect(existsSync(join(tmpRoot, '.cleo', 'cleo.db'))).toBe(false);

    const result = await ensureConduitDb(tmpRoot);

    expect(result.path).toBe(getConduitDbPath(tmpRoot));
    expect(result.action).toBe('created');
    expect(existsSync(join(tmpRoot, '.cleo'))).toBe(true);
    expect(existsSync(join(tmpRoot, '.cleo', 'cleo.db'))).toBe(true);
  });

  // TC-002 continued — all legacy messaging tables + 2 tracking tables present
  it('ensureConduitDb creates all expected legacy tables on fresh install', async () => {
    await ensureConduitDb(tmpRoot);
    const db = getConduitNativeDb();
    expect(db).not.toBeNull();

    const rows = db!
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .all() as Array<{ name: string }>;

    const tableNames = rows.map((r) => r.name);
    // The consolidated cleo.db holds tasks_*/brain_*/conduit_* too, so assert the
    // legacy BARE conduit tables are PRESENT rather than the only tables.
    expect(tableNames).toEqual(expect.arrayContaining(EXPECTED_LEGACY_TABLES));
  });

  // TC-011 — messages_fts virtual table created
  it('ensureConduitDb creates messages_fts virtual table', async () => {
    await ensureConduitDb(tmpRoot);
    const db = getConduitNativeDb();
    expect(db).not.toBeNull();

    const row = db!
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='messages_fts'")
      .get() as { name: string } | undefined;
    expect(row?.name).toBe('messages_fts');
  });

  // TC-012 — FTS5 triggers created and functional
  it('messages_fts triggers are created and FTS search works after insert', async () => {
    await ensureConduitDb(tmpRoot);
    const db = getConduitNativeDb();
    expect(db).not.toBeNull();

    // Verify all three triggers exist.
    const triggers = db!
      .prepare("SELECT name FROM sqlite_master WHERE type='trigger' ORDER BY name")
      .all() as Array<{ name: string }>;
    const triggerNames = triggers.map((t) => t.name);
    expect(triggerNames).toContain('messages_ai');
    expect(triggerNames).toContain('messages_ad');
    expect(triggerNames).toContain('messages_au');

    // FK is enabled under the dual-scope pragma SSoT — insert a conversation
    // first to satisfy the messages → conversations FK.
    db!.exec(`INSERT INTO conversations (id, participants, created_at, updated_at)
              VALUES ('conv-1', '["a","b"]', 1000, 1000)`);

    // Insert a message — messages_ai trigger should populate messages_fts.
    db!.exec(`INSERT INTO messages
              (id, conversation_id, from_agent_id, to_agent_id, content, created_at)
              VALUES ('msg-1', 'conv-1', 'agent-a', 'agent-b', 'hello world', 1000)`);

    const ftsRow = db!
      .prepare("SELECT * FROM messages_fts WHERE messages_fts MATCH 'hello'")
      .get() as Record<string, unknown> | undefined;
    expect(ftsRow).toBeDefined();
  });

  // TC-003 — idempotent re-open
  it('ensureConduitDb returns action=exists on second call for same project root', async () => {
    const first = await ensureConduitDb(tmpRoot);
    expect(first.action).toBe('created');

    // Close the conduit singleton + evict the shared cache to simulate a second
    // process open against the now-existing file.
    closeConduitDb();
    _resetDualScopeDbCache();

    const second = await ensureConduitDb(tmpRoot);
    expect(second.action).toBe('exists');
    expect(second.path).toBe(first.path);
  });

  it('ensureConduitDb is idempotent: data survives across two opens', async () => {
    await ensureConduitDb(tmpRoot);
    const db1 = getConduitNativeDb()!;
    db1.exec(`INSERT INTO project_agent_refs (agent_id, attached_at)
              VALUES ('test-agent', '2026-04-12T00:00:00Z')`);
    closeConduitDb();
    _resetDualScopeDbCache();

    await ensureConduitDb(tmpRoot);
    const db2 = getConduitNativeDb()!;
    const row = db2
      .prepare('SELECT agent_id FROM project_agent_refs WHERE agent_id = ?')
      .get('test-agent') as { agent_id: string } | undefined;
    expect(row?.agent_id).toBe('test-agent');
  });

  // getConduitNativeDb — returns null before init
  it('getConduitNativeDb returns null before ensureConduitDb is called', () => {
    expect(getConduitNativeDb()).toBeNull();
  });

  // getConduitNativeDb — returns live handle after init
  it('getConduitNativeDb returns the live DatabaseSync handle after ensureConduitDb', async () => {
    await ensureConduitDb(tmpRoot);
    const db = getConduitNativeDb();
    expect(db).not.toBeNull();
    expect(db!.isOpen).toBe(true);
  });

  // getConduitNativeDb — returns null after close (drops conduit singleton ref)
  it('getConduitNativeDb returns null after closeConduitDb', async () => {
    await ensureConduitDb(tmpRoot);
    closeConduitDb();
    expect(getConduitNativeDb()).toBeNull();
  });

  // integrity_check
  it('cleo.db passes PRAGMA integrity_check after conduit creation', async () => {
    await ensureConduitDb(tmpRoot);
    const db = getConduitNativeDb()!;
    const result = db.prepare('PRAGMA integrity_check').get() as { integrity_check: string };
    expect(result.integrity_check).toBe('ok');
  });

  // project_agent_refs schema
  it('project_agent_refs has expected columns with correct constraints', async () => {
    await ensureConduitDb(tmpRoot);
    const db = getConduitNativeDb()!;

    const cols = db.prepare('PRAGMA table_info(project_agent_refs)').all() as Array<{
      cid: number;
      name: string;
      type: string;
      notnull: number;
      dflt_value: unknown;
      pk: number;
    }>;

    const colNames = cols.map((c) => c.name);
    expect(colNames).toEqual([
      'agent_id',
      'attached_at',
      'role',
      'capabilities_override',
      'last_used_at',
      'enabled',
    ]);

    const agentIdCol = cols.find((c) => c.name === 'agent_id');
    expect(agentIdCol?.pk).toBe(1);

    const enabledCol = cols.find((c) => c.name === 'enabled');
    expect(enabledCol?.notnull).toBe(1);
    expect(enabledCol?.dflt_value).toBe('1');
  });

  // partial index on project_agent_refs
  it('idx_project_agent_refs_enabled partial index exists on project_agent_refs', async () => {
    await ensureConduitDb(tmpRoot);
    const db = getConduitNativeDb()!;

    const indices = db.prepare('PRAGMA index_list(project_agent_refs)').all() as Array<{
      seq: number;
      name: string;
      unique: number;
      origin: string;
      partial: number;
    }>;
    const enabledIdx = indices.find((i) => i.name === 'idx_project_agent_refs_enabled');
    expect(enabledIdx).toBeDefined();
    expect(enabledIdx?.partial).toBe(1);
  });

  // applyConduitSchema — idempotent on a caller-owned db
  it('applyConduitSchema is idempotent when called twice on the same db', () => {
    const dbPath = join(tmpRoot, 'manual.db');
    mkdirSync(tmpRoot, { recursive: true });
    const db = new DatabaseSync(dbPath);
    expect(() => applyConduitSchema(db)).not.toThrow();
    expect(() => applyConduitSchema(db)).not.toThrow();
    db.close();
  });

  // schema version recorded in _conduit_meta
  it('ensureConduitDb records CONDUIT_SCHEMA_VERSION in _conduit_meta', async () => {
    await ensureConduitDb(tmpRoot);
    const db = getConduitNativeDb()!;
    const meta = db.prepare("SELECT value FROM _conduit_meta WHERE key = 'schema_version'").get() as
      | { value: string }
      | undefined;
    expect(meta?.value).toBe(CONDUIT_SCHEMA_VERSION);
  });

  // migration row recorded in __drizzle_migrations (T1407 baseline marker)
  it('ensureConduitDb records the conduit baseline in __drizzle_migrations', async () => {
    await ensureConduitDb(tmpRoot);
    const db = getConduitNativeDb()!;
    const mig = db
      .prepare('SELECT name FROM "__drizzle_migrations" WHERE name = ?')
      .get('20260425000000_initial-conduit') as { name: string } | undefined;
    expect(mig?.name).toBe('20260425000000_initial-conduit');
  });

  // forward migration row recorded (E6-L3 conduit inline-schema migration)
  it('ensureConduitDb records the E6-L3 conduit inline-schema migration', async () => {
    await ensureConduitDb(tmpRoot);
    const db = getConduitNativeDb()!;
    const mig = db
      .prepare('SELECT name FROM "__drizzle_migrations" WHERE name = ?')
      .get('20260601000003_t11523-conduit-inline-schema') as { name: string } | undefined;
    expect(mig?.name).toBe('20260601000003_t11523-conduit-inline-schema');
  });

  // re-stamp on stale sentinel (no longer a fast-path, but ensure() re-stamps)
  it('ensureConduitDb re-stamps CONDUIT_SCHEMA_VERSION on a stale _conduit_meta sentinel', async () => {
    await ensureConduitDb(tmpRoot);
    let db = getConduitNativeDb()!;
    // Corrupt the sentinel to an older version.
    db.exec("UPDATE _conduit_meta SET value = '1900.0.0' WHERE key = 'schema_version'");
    closeConduitDb();
    _resetDualScopeDbCache();

    const result = await ensureConduitDb(tmpRoot);
    expect(result.action).toBe('exists');
    db = getConduitNativeDb()!;
    const after = db
      .prepare("SELECT value FROM _conduit_meta WHERE key = 'schema_version'")
      .get() as { value: string };
    expect(after.value).toBe(CONDUIT_SCHEMA_VERSION);
  });

  // checkConduitDbHealth — db absent
  it('checkConduitDbHealth returns exists=false when cleo.db does not exist', () => {
    const health = checkConduitDbHealth(tmpRoot);
    expect(health.exists).toBe(false);
    expect(health.tableCount).toBe(0);
    expect(health.walMode).toBe(false);
    expect(health.schemaVersion).toBeNull();
    expect(health.foreignKeysEnabled).toBe(false);
  });

  // checkConduitDbHealth — after creation
  it('checkConduitDbHealth returns correct health after ensureConduitDb', async () => {
    await ensureConduitDb(tmpRoot);
    closeConduitDb();
    _resetDualScopeDbCache();

    const health = checkConduitDbHealth(tmpRoot);
    expect(health.exists).toBe(true);
    expect(health.walMode).toBe(true);
    expect(health.schemaVersion).toBe(CONDUIT_SCHEMA_VERSION);
    expect(health.foreignKeysEnabled).toBe(true);
    // At minimum all legacy conduit tables (the consolidated cleo.db has more).
    expect(health.tableCount).toBeGreaterThanOrEqual(EXPECTED_LEGACY_TABLES.length);
  });

  // ensureConduitDb with pre-existing .cleo/ dir
  it('ensureConduitDb works when .cleo/ dir already exists', async () => {
    mkdirSync(join(tmpRoot, '.cleo'), { recursive: true });
    await expect(ensureConduitDb(tmpRoot)).resolves.toBeDefined();
    expect(existsSync(join(tmpRoot, '.cleo', 'cleo.db'))).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // project_agent_refs CRUD (T353)
  // ---------------------------------------------------------------------------

  describe('project_agent_refs CRUD (T353)', () => {
    it('TC-004: attachAgentToProject inserts a new row with enabled=1', async () => {
      await ensureConduitDb(tmpRoot);
      const db = getConduitNativeDb()!;
      attachAgentToProject(db, 'agent-1');
      const ref = getProjectAgentRef(db, 'agent-1');
      expect(ref).not.toBeNull();
      expect(ref?.agentId).toBe('agent-1');
      expect(ref?.enabled).toBe(1);
      expect(ref?.role).toBeNull();
      expect(ref?.capabilitiesOverride).toBeNull();
      expect(ref?.lastUsedAt).toBeNull();
    });

    it('TC-005: attachAgentToProject re-enables an existing enabled=0 row without duplicate', async () => {
      await ensureConduitDb(tmpRoot);
      const db = getConduitNativeDb()!;
      attachAgentToProject(db, 'agent-1');
      detachAgentFromProject(db, 'agent-1');
      const detached = getProjectAgentRef(db, 'agent-1');
      expect(detached?.enabled).toBe(0);
      attachAgentToProject(db, 'agent-1', { role: 'reviewer' });
      const reattached = getProjectAgentRef(db, 'agent-1');
      expect(reattached?.enabled).toBe(1);
      expect(reattached?.role).toBe('reviewer');
      const count = (
        db
          .prepare('SELECT COUNT(*) AS c FROM project_agent_refs WHERE agent_id = ?')
          .get('agent-1') as {
          c: number;
        }
      ).c;
      expect(count).toBe(1);
    });

    it('TC-006: detachAgentFromProject sets enabled=0 without deleting', async () => {
      await ensureConduitDb(tmpRoot);
      const db = getConduitNativeDb()!;
      attachAgentToProject(db, 'agent-1');
      detachAgentFromProject(db, 'agent-1');
      const ref = getProjectAgentRef(db, 'agent-1');
      expect(ref).not.toBeNull();
      expect(ref?.enabled).toBe(0);
    });

    it('TC-007: listProjectAgentRefs returns only enabled=1 rows by default', async () => {
      await ensureConduitDb(tmpRoot);
      const db = getConduitNativeDb()!;
      attachAgentToProject(db, 'agent-1');
      attachAgentToProject(db, 'agent-2');
      attachAgentToProject(db, 'agent-3');
      detachAgentFromProject(db, 'agent-2');
      const enabled = listProjectAgentRefs(db);
      expect(enabled.length).toBe(2);
      expect(enabled.map((r) => r.agentId).sort()).toEqual(['agent-1', 'agent-3']);
    });

    it('TC-008: listProjectAgentRefs returns all rows when enabledOnly=false', async () => {
      await ensureConduitDb(tmpRoot);
      const db = getConduitNativeDb()!;
      attachAgentToProject(db, 'agent-1');
      attachAgentToProject(db, 'agent-2');
      detachAgentFromProject(db, 'agent-2');
      const all = listProjectAgentRefs(db, { enabledOnly: false });
      expect(all.length).toBe(2);
    });

    it('TC-009: getProjectAgentRef returns null for unknown agent', async () => {
      await ensureConduitDb(tmpRoot);
      const db = getConduitNativeDb()!;
      const ref = getProjectAgentRef(db, 'nonexistent');
      expect(ref).toBeNull();
    });

    it('TC-010: updateProjectAgentLastUsed sets last_used_at to current ISO timestamp', async () => {
      await ensureConduitDb(tmpRoot);
      const db = getConduitNativeDb()!;
      attachAgentToProject(db, 'agent-1');
      const before = new Date().toISOString();
      updateProjectAgentLastUsed(db, 'agent-1');
      const after = new Date().toISOString();
      const ref = getProjectAgentRef(db, 'agent-1');
      expect(ref?.lastUsedAt).not.toBeNull();
      expect(ref!.lastUsedAt! >= before).toBe(true);
      expect(ref!.lastUsedAt! <= after).toBe(true);
    });
  });
});
