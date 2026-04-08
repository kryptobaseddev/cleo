/**
 * Unit tests for agent-registry-accessor.ts — cross-DB refactor (T355, T310).
 *
 * Covers:
 * - TC-050: lookupAgent returns null for unknown agentId
 * - TC-051: lookupAgent returns agent when project_agent_refs row exists and enabled=1
 * - TC-052: lookupAgent returns null when project_agent_refs row has enabled=0
 * - TC-053: lookupAgent with includeGlobal=true returns agent even without project ref
 * - TC-054: listAgentsForProject returns only project-attached agents by default
 * - TC-055: listAgentsForProject with includeGlobal=true returns all global agents
 * - TC-056: createProjectAgent writes to global signaldock.db AND creates project_agent_refs row
 * - TC-057: AgentRegistryAccessor.remove() detaches from project; global row untouched
 * - TC-058: AgentRegistryAccessor.removeGlobal() deletes global agents row
 * - TC-059: AgentRegistryAccessor.markUsed() updates last_used_at in both DBs
 *
 * Additional tests:
 * - lookupAgent warns on dangling soft-FK (ref exists in conduit but not in global)
 * - createProjectAgent re-enables a previously detached agent
 * - listAgentsForProject with includeDisabled=true includes enabled=0 rows
 * - AgentRegistryAccessor.list() returns project-scoped agents only
 * - AgentRegistryAccessor.listGlobal() returns all global agents
 * - AgentRegistryAccessor.getActive() returns most-recently-used project agent
 *
 * All tests use real node:sqlite in tmp directories. The real user's
 * $XDG_DATA_HOME and project directories are never touched.
 *
 * @task T355
 * @epic T310
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Fixtures shared across tests
// ---------------------------------------------------------------------------

/** Minimal valid AgentCredential spec for test agents. */
const BASE_SPEC = {
  agentId: 'test-agent-alpha',
  displayName: 'Test Agent Alpha',
  apiKey: 'sk_live_test_alpha',
  apiBaseUrl: 'https://api.signaldock.io',
  privacyTier: 'public' as const,
  capabilities: ['chat'],
  skills: ['coding'],
  transportType: 'http' as const,
  transportConfig: {},
  isActive: true,
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Create an isolated tmp directory pair:
 *   - cleoHome: simulates $XDG_DATA_HOME/cleo (global tier)
 *   - projectRoot: simulates a project directory (project tier)
 *
 * Returns helpers to open both databases directly for assertions.
 */
function makeTmpEnv(suffix: string): {
  cleoHome: string;
  projectRoot: string;
  openGlobal: () => DatabaseSync;
  openConduit: () => DatabaseSync;
  cleanup: () => void;
} {
  const base = mkdtempSync(join(tmpdir(), `cleo-t355-${suffix}-`));
  const cleoHome = join(base, 'cleo-home');
  const projectRoot = join(base, 'project');

  mkdirSync(cleoHome, { recursive: true });
  mkdirSync(join(projectRoot, '.cleo'), { recursive: true });

  const openGlobal = (): DatabaseSync => {
    const db = new DatabaseSync(join(cleoHome, 'signaldock.db'));
    db.exec('PRAGMA foreign_keys = ON');
    db.exec('PRAGMA journal_mode = WAL');
    return db;
  };

  const openConduit = (): DatabaseSync => {
    const db = new DatabaseSync(join(projectRoot, '.cleo', 'conduit.db'));
    db.exec('PRAGMA foreign_keys = ON');
    db.exec('PRAGMA journal_mode = WAL');
    return db;
  };

  const cleanup = (): void => {
    rmSync(base, { recursive: true, force: true });
  };

  return { cleoHome, projectRoot, openGlobal, openConduit, cleanup };
}

/**
 * Bootstrap both databases (schema only) in the tmp environment.
 * Uses the real ensureGlobalSignaldockDb / ensureConduitDb with mocked paths.
 */
async function bootstrapDbs(
  cleoHome: string,
  projectRoot: string,
): Promise<{
  ensureGlobal: () => Promise<void>;
  ensureConduit: () => void;
}> {
  vi.doMock('../../paths.js', () => ({ getCleoHome: () => cleoHome }));
  // Write a deterministic machine-key and global-salt so KDF is testable
  const machineKey = Buffer.alloc(32, 0xab);
  const globalSalt = Buffer.alloc(32, 0xcd);
  writeFileSync(join(cleoHome, 'machine-key'), machineKey, { mode: 0o600 });
  writeFileSync(join(cleoHome, 'global-salt'), globalSalt, { mode: 0o600 });

  const { ensureGlobalSignaldockDb } = await import('../signaldock-sqlite.js');
  const { ensureConduitDb, closeConduitDb } = await import('../conduit-sqlite.js');

  return {
    ensureGlobal: async () => {
      await ensureGlobalSignaldockDb();
    },
    ensureConduit: () => {
      ensureConduitDb(projectRoot);
      closeConduitDb();
    },
  };
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('agent-registry-accessor (cross-DB T355)', () => {
  let env: ReturnType<typeof makeTmpEnv>;

  beforeEach(() => {
    vi.resetModules();
    env = makeTmpEnv(`${Math.random().toString(36).slice(2)}`);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    env.cleanup();
  });

  // -------------------------------------------------------------------------
  // TC-050: lookupAgent returns null for unknown agentId
  // -------------------------------------------------------------------------

  it('TC-050: lookupAgent returns null for unknown agentId', async () => {
    vi.doMock('../../paths.js', () => ({ getCleoHome: () => env.cleoHome }));
    const machineKey = Buffer.alloc(32, 0xab);
    const globalSalt = Buffer.alloc(32, 0xcd);
    writeFileSync(join(env.cleoHome, 'machine-key'), machineKey, { mode: 0o600 });
    writeFileSync(join(env.cleoHome, 'global-salt'), globalSalt, { mode: 0o600 });

    const { ensureGlobalSignaldockDb } = await import('../signaldock-sqlite.js');
    const { ensureConduitDb, closeConduitDb } = await import('../conduit-sqlite.js');
    const { lookupAgent } = await import('../agent-registry-accessor.js');

    await ensureGlobalSignaldockDb();
    ensureConduitDb(env.projectRoot);
    closeConduitDb();

    const result = lookupAgent(env.projectRoot, 'nonexistent-agent');
    expect(result).toBeNull();
  });

  // -------------------------------------------------------------------------
  // TC-051: lookupAgent returns agent when project_agent_refs row exists enabled=1
  // -------------------------------------------------------------------------

  it('TC-051: lookupAgent returns merged agent when ref exists with enabled=1', async () => {
    vi.doMock('../../paths.js', () => ({ getCleoHome: () => env.cleoHome }));
    const machineKey = Buffer.alloc(32, 0xab);
    const globalSalt = Buffer.alloc(32, 0xcd);
    writeFileSync(join(env.cleoHome, 'machine-key'), machineKey, { mode: 0o600 });
    writeFileSync(join(env.cleoHome, 'global-salt'), globalSalt, { mode: 0o600 });

    const { ensureGlobalSignaldockDb } = await import('../signaldock-sqlite.js');
    const { ensureConduitDb, closeConduitDb } = await import('../conduit-sqlite.js');
    const { createProjectAgent, lookupAgent } = await import('../agent-registry-accessor.js');

    await ensureGlobalSignaldockDb();
    ensureConduitDb(env.projectRoot);
    closeConduitDb();

    // Create agent (writes global + conduit ref)
    const created = createProjectAgent(env.projectRoot, BASE_SPEC);
    expect(created.agentId).toBe(BASE_SPEC.agentId);
    expect(created.projectRef).not.toBeNull();
    expect(created.projectRef?.enabled).toBe(1);

    // Lookup should return the merged record
    const found = lookupAgent(env.projectRoot, BASE_SPEC.agentId);
    expect(found).not.toBeNull();
    expect(found?.agentId).toBe(BASE_SPEC.agentId);
    expect(found?.displayName).toBe(BASE_SPEC.displayName);
    expect(found?.projectRef).not.toBeNull();
    expect(found?.projectRef?.enabled).toBe(1);
  });

  // -------------------------------------------------------------------------
  // TC-052: lookupAgent returns null when project_agent_refs row has enabled=0
  // -------------------------------------------------------------------------

  it('TC-052: lookupAgent returns null when project_agent_refs row has enabled=0', async () => {
    vi.doMock('../../paths.js', () => ({ getCleoHome: () => env.cleoHome }));
    const machineKey = Buffer.alloc(32, 0xab);
    const globalSalt = Buffer.alloc(32, 0xcd);
    writeFileSync(join(env.cleoHome, 'machine-key'), machineKey, { mode: 0o600 });
    writeFileSync(join(env.cleoHome, 'global-salt'), globalSalt, { mode: 0o600 });

    const { ensureGlobalSignaldockDb } = await import('../signaldock-sqlite.js');
    const { ensureConduitDb, closeConduitDb } = await import('../conduit-sqlite.js');
    const { createProjectAgent, lookupAgent } = await import('../agent-registry-accessor.js');

    await ensureGlobalSignaldockDb();
    ensureConduitDb(env.projectRoot);
    closeConduitDb();

    createProjectAgent(env.projectRoot, BASE_SPEC);

    // Manually set enabled=0 in conduit.db
    const conduitDb = env.openConduit();
    conduitDb
      .prepare('UPDATE project_agent_refs SET enabled = 0 WHERE agent_id = ?')
      .run(BASE_SPEC.agentId);
    conduitDb.close();

    const result = lookupAgent(env.projectRoot, BASE_SPEC.agentId);
    expect(result).toBeNull();
  });

  // -------------------------------------------------------------------------
  // TC-053: lookupAgent with includeGlobal=true returns agent without project ref
  // -------------------------------------------------------------------------

  it('TC-053: lookupAgent with includeGlobal=true returns global agent even without project ref', async () => {
    vi.doMock('../../paths.js', () => ({ getCleoHome: () => env.cleoHome }));
    const machineKey = Buffer.alloc(32, 0xab);
    const globalSalt = Buffer.alloc(32, 0xcd);
    writeFileSync(join(env.cleoHome, 'machine-key'), machineKey, { mode: 0o600 });
    writeFileSync(join(env.cleoHome, 'global-salt'), globalSalt, { mode: 0o600 });

    const { ensureGlobalSignaldockDb } = await import('../signaldock-sqlite.js');
    const { ensureConduitDb, closeConduitDb } = await import('../conduit-sqlite.js');
    const { lookupAgent } = await import('../agent-registry-accessor.js');

    await ensureGlobalSignaldockDb();
    ensureConduitDb(env.projectRoot);
    closeConduitDb();

    // Insert directly into global signaldock.db without touching conduit.db
    const globalDb = env.openGlobal();
    const nowTs = Math.floor(Date.now() / 1000);
    globalDb
      .prepare(
        `INSERT INTO agents (id, agent_id, name, class, privacy_tier, capabilities, skills,
         transport_type, api_base_url, classification, transport_config, is_active, status,
         created_at, updated_at, requires_reauth)
         VALUES (?, ?, ?, 'custom', 'public', '[]', '[]', 'http',
                 'https://api.signaldock.io', NULL, '{}', 1, 'online', ?, ?, 0)`,
      )
      .run(crypto.randomUUID(), 'global-only-agent', 'Global Only Agent', nowTs, nowTs);
    globalDb.close();

    // Default (includeGlobal=false): should return null because no project ref
    const defaultResult = lookupAgent(env.projectRoot, 'global-only-agent');
    expect(defaultResult).toBeNull();

    // includeGlobal=true: should return the global agent with projectRef=null
    const globalResult = lookupAgent(env.projectRoot, 'global-only-agent', {
      includeGlobal: true,
    });
    expect(globalResult).not.toBeNull();
    expect(globalResult?.agentId).toBe('global-only-agent');
    expect(globalResult?.projectRef).toBeNull();
  });

  // -------------------------------------------------------------------------
  // TC-054: listAgentsForProject returns only project-attached agents by default
  // -------------------------------------------------------------------------

  it('TC-054: listAgentsForProject returns only project-attached agents by default', async () => {
    vi.doMock('../../paths.js', () => ({ getCleoHome: () => env.cleoHome }));
    const machineKey = Buffer.alloc(32, 0xab);
    const globalSalt = Buffer.alloc(32, 0xcd);
    writeFileSync(join(env.cleoHome, 'machine-key'), machineKey, { mode: 0o600 });
    writeFileSync(join(env.cleoHome, 'global-salt'), globalSalt, { mode: 0o600 });

    const { ensureGlobalSignaldockDb } = await import('../signaldock-sqlite.js');
    const { ensureConduitDb, closeConduitDb } = await import('../conduit-sqlite.js');
    const { createProjectAgent, listAgentsForProject } = await import(
      '../agent-registry-accessor.js'
    );

    await ensureGlobalSignaldockDb();
    ensureConduitDb(env.projectRoot);
    closeConduitDb();

    // Insert a global-only agent (no project ref)
    const globalDb = env.openGlobal();
    const nowTs = Math.floor(Date.now() / 1000);
    globalDb
      .prepare(
        `INSERT INTO agents (id, agent_id, name, class, privacy_tier, capabilities, skills,
         transport_type, api_base_url, classification, transport_config, is_active, status,
         created_at, updated_at, requires_reauth)
         VALUES (?, ?, ?, 'custom', 'public', '[]', '[]', 'http',
                 'https://api.signaldock.io', NULL, '{}', 1, 'online', ?, ?, 0)`,
      )
      .run(crypto.randomUUID(), 'global-only', 'Global Only', nowTs, nowTs);
    globalDb.close();

    // Create one project-attached agent
    createProjectAgent(env.projectRoot, BASE_SPEC);

    const list = listAgentsForProject(env.projectRoot);
    expect(list).toHaveLength(1);
    expect(list[0]?.agentId).toBe(BASE_SPEC.agentId);
    expect(list[0]?.projectRef).not.toBeNull();
  });

  // -------------------------------------------------------------------------
  // TC-055: listAgentsForProject with includeGlobal=true returns all global agents
  // -------------------------------------------------------------------------

  it('TC-055: listAgentsForProject with includeGlobal=true returns all global agents', async () => {
    vi.doMock('../../paths.js', () => ({ getCleoHome: () => env.cleoHome }));
    const machineKey = Buffer.alloc(32, 0xab);
    const globalSalt = Buffer.alloc(32, 0xcd);
    writeFileSync(join(env.cleoHome, 'machine-key'), machineKey, { mode: 0o600 });
    writeFileSync(join(env.cleoHome, 'global-salt'), globalSalt, { mode: 0o600 });

    const { ensureGlobalSignaldockDb } = await import('../signaldock-sqlite.js');
    const { ensureConduitDb, closeConduitDb } = await import('../conduit-sqlite.js');
    const { createProjectAgent, listAgentsForProject } = await import(
      '../agent-registry-accessor.js'
    );

    await ensureGlobalSignaldockDb();
    ensureConduitDb(env.projectRoot);
    closeConduitDb();

    // Insert a global-only agent
    const globalDb = env.openGlobal();
    const nowTs = Math.floor(Date.now() / 1000);
    globalDb
      .prepare(
        `INSERT INTO agents (id, agent_id, name, class, privacy_tier, capabilities, skills,
         transport_type, api_base_url, classification, transport_config, is_active, status,
         created_at, updated_at, requires_reauth)
         VALUES (?, ?, ?, 'custom', 'public', '[]', '[]', 'http',
                 'https://api.signaldock.io', NULL, '{}', 1, 'online', ?, ?, 0)`,
      )
      .run(crypto.randomUUID(), 'global-only-2', 'Global Only 2', nowTs, nowTs);
    globalDb.close();

    // Create one project-attached agent
    createProjectAgent(env.projectRoot, BASE_SPEC);

    const list = listAgentsForProject(env.projectRoot, { includeGlobal: true });

    // Should return both agents
    expect(list.length).toBeGreaterThanOrEqual(2);

    const agentIds = list.map((a) => a.agentId);
    expect(agentIds).toContain(BASE_SPEC.agentId);
    expect(agentIds).toContain('global-only-2');

    // Project-attached one has projectRef populated; global-only has null
    const attached = list.find((a) => a.agentId === BASE_SPEC.agentId);
    const globalOnly = list.find((a) => a.agentId === 'global-only-2');
    expect(attached?.projectRef).not.toBeNull();
    expect(globalOnly?.projectRef).toBeNull();
  });

  // -------------------------------------------------------------------------
  // TC-056: createProjectAgent writes to global signaldock.db AND conduit.db
  // -------------------------------------------------------------------------

  it('TC-056: createProjectAgent writes to global signaldock.db AND project_agent_refs', async () => {
    vi.doMock('../../paths.js', () => ({ getCleoHome: () => env.cleoHome }));
    const machineKey = Buffer.alloc(32, 0xab);
    const globalSalt = Buffer.alloc(32, 0xcd);
    writeFileSync(join(env.cleoHome, 'machine-key'), machineKey, { mode: 0o600 });
    writeFileSync(join(env.cleoHome, 'global-salt'), globalSalt, { mode: 0o600 });

    const { ensureGlobalSignaldockDb } = await import('../signaldock-sqlite.js');
    const { ensureConduitDb, closeConduitDb } = await import('../conduit-sqlite.js');
    const { createProjectAgent } = await import('../agent-registry-accessor.js');

    await ensureGlobalSignaldockDb();
    ensureConduitDb(env.projectRoot);
    closeConduitDb();

    const result = createProjectAgent(env.projectRoot, BASE_SPEC);

    // Verify return type
    expect(result.agentId).toBe(BASE_SPEC.agentId);
    expect(result.displayName).toBe(BASE_SPEC.displayName);
    expect(result.projectRef).not.toBeNull();
    expect(result.projectRef?.agentId).toBe(BASE_SPEC.agentId);
    expect(result.projectRef?.enabled).toBe(1);
    expect(result.projectRef?.attachedAt).toBeTruthy();

    // Verify global signaldock.db was written
    const globalDb = env.openGlobal();
    const globalRow = globalDb
      .prepare('SELECT agent_id, name FROM agents WHERE agent_id = ?')
      .get(BASE_SPEC.agentId) as { agent_id: string; name: string } | undefined;
    globalDb.close();
    expect(globalRow).toBeDefined();
    expect(globalRow?.name).toBe(BASE_SPEC.displayName);

    // Verify conduit.db project_agent_refs was written
    const conduitDb = env.openConduit();
    const refRow = conduitDb
      .prepare('SELECT agent_id, enabled FROM project_agent_refs WHERE agent_id = ?')
      .get(BASE_SPEC.agentId) as { agent_id: string; enabled: number } | undefined;
    conduitDb.close();
    expect(refRow).toBeDefined();
    expect(refRow?.enabled).toBe(1);
  });

  // -------------------------------------------------------------------------
  // TC-057: AgentRegistryAccessor.remove() detaches from project; global row untouched
  // -------------------------------------------------------------------------

  it('TC-057: AgentRegistryAccessor.remove() sets project_agent_refs.enabled=0; global row intact', async () => {
    vi.doMock('../../paths.js', () => ({ getCleoHome: () => env.cleoHome }));
    const machineKey = Buffer.alloc(32, 0xab);
    const globalSalt = Buffer.alloc(32, 0xcd);
    writeFileSync(join(env.cleoHome, 'machine-key'), machineKey, { mode: 0o600 });
    writeFileSync(join(env.cleoHome, 'global-salt'), globalSalt, { mode: 0o600 });

    const { ensureGlobalSignaldockDb } = await import('../signaldock-sqlite.js');
    const { ensureConduitDb, closeConduitDb } = await import('../conduit-sqlite.js');
    const { AgentRegistryAccessor, createProjectAgent } = await import(
      '../agent-registry-accessor.js'
    );

    await ensureGlobalSignaldockDb();
    ensureConduitDb(env.projectRoot);
    closeConduitDb();

    createProjectAgent(env.projectRoot, BASE_SPEC);

    const accessor = new AgentRegistryAccessor(env.projectRoot);
    await accessor.remove(BASE_SPEC.agentId);

    // project_agent_refs row should be disabled (enabled=0), not deleted
    const conduitDb = env.openConduit();
    const refRow = conduitDb
      .prepare('SELECT agent_id, enabled FROM project_agent_refs WHERE agent_id = ?')
      .get(BASE_SPEC.agentId) as { agent_id: string; enabled: number } | undefined;
    conduitDb.close();
    expect(refRow).toBeDefined();
    expect(refRow?.enabled).toBe(0);

    // Global signaldock.db row should still exist
    const globalDb = env.openGlobal();
    const globalRow = globalDb
      .prepare('SELECT agent_id FROM agents WHERE agent_id = ?')
      .get(BASE_SPEC.agentId) as { agent_id: string } | undefined;
    globalDb.close();
    expect(globalRow).toBeDefined();
  });

  // -------------------------------------------------------------------------
  // TC-058: AgentRegistryAccessor.removeGlobal() deletes global agents row
  // -------------------------------------------------------------------------

  it('TC-058: AgentRegistryAccessor.removeGlobal() deletes row from global signaldock.db', async () => {
    vi.doMock('../../paths.js', () => ({ getCleoHome: () => env.cleoHome }));
    const machineKey = Buffer.alloc(32, 0xab);
    const globalSalt = Buffer.alloc(32, 0xcd);
    writeFileSync(join(env.cleoHome, 'machine-key'), machineKey, { mode: 0o600 });
    writeFileSync(join(env.cleoHome, 'global-salt'), globalSalt, { mode: 0o600 });

    const { ensureGlobalSignaldockDb } = await import('../signaldock-sqlite.js');
    const { ensureConduitDb, closeConduitDb } = await import('../conduit-sqlite.js');
    const { AgentRegistryAccessor, createProjectAgent } = await import(
      '../agent-registry-accessor.js'
    );

    await ensureGlobalSignaldockDb();
    ensureConduitDb(env.projectRoot);
    closeConduitDb();

    createProjectAgent(env.projectRoot, BASE_SPEC);

    // First detach from project so removeGlobal succeeds without force
    const accessor = new AgentRegistryAccessor(env.projectRoot);
    await accessor.remove(BASE_SPEC.agentId);

    // Now remove globally (no active project ref → no warning)
    await accessor.removeGlobal(BASE_SPEC.agentId);

    // Global row should be gone
    const globalDb = env.openGlobal();
    const globalRow = globalDb
      .prepare('SELECT agent_id FROM agents WHERE agent_id = ?')
      .get(BASE_SPEC.agentId) as { agent_id: string } | undefined;
    globalDb.close();
    expect(globalRow).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // TC-059: AgentRegistryAccessor.markUsed() updates last_used_at in both DBs
  // -------------------------------------------------------------------------

  it('TC-059: AgentRegistryAccessor.markUsed() updates last_used_at in both DBs', async () => {
    vi.doMock('../../paths.js', () => ({ getCleoHome: () => env.cleoHome }));
    const machineKey = Buffer.alloc(32, 0xab);
    const globalSalt = Buffer.alloc(32, 0xcd);
    writeFileSync(join(env.cleoHome, 'machine-key'), machineKey, { mode: 0o600 });
    writeFileSync(join(env.cleoHome, 'global-salt'), globalSalt, { mode: 0o600 });

    const { ensureGlobalSignaldockDb } = await import('../signaldock-sqlite.js');
    const { ensureConduitDb, closeConduitDb } = await import('../conduit-sqlite.js');
    const { AgentRegistryAccessor, createProjectAgent } = await import(
      '../agent-registry-accessor.js'
    );

    await ensureGlobalSignaldockDb();
    ensureConduitDb(env.projectRoot);
    closeConduitDb();

    createProjectAgent(env.projectRoot, BASE_SPEC);

    const before = Date.now();

    const accessor = new AgentRegistryAccessor(env.projectRoot);
    await accessor.markUsed(BASE_SPEC.agentId);

    const after = Date.now();

    // Check global signaldock.db last_used_at was updated (stored as Unix timestamp)
    const globalDb = env.openGlobal();
    const globalRow = globalDb
      .prepare('SELECT last_used_at FROM agents WHERE agent_id = ?')
      .get(BASE_SPEC.agentId) as { last_used_at: number } | undefined;
    globalDb.close();
    expect(globalRow?.last_used_at).toBeDefined();
    expect(globalRow!.last_used_at * 1000).toBeGreaterThanOrEqual(Math.floor(before / 1000) * 1000);
    expect(globalRow!.last_used_at * 1000).toBeLessThanOrEqual(after + 1000);

    // Check conduit.db project_agent_refs last_used_at was updated (stored as ISO string)
    const conduitDb = env.openConduit();
    const refRow = conduitDb
      .prepare('SELECT last_used_at FROM project_agent_refs WHERE agent_id = ?')
      .get(BASE_SPEC.agentId) as { last_used_at: string | null } | undefined;
    conduitDb.close();
    expect(refRow?.last_used_at).toBeTruthy();
    // Should be a parseable ISO string
    const ts = new Date(refRow!.last_used_at!).getTime();
    expect(ts).toBeGreaterThanOrEqual(before - 1000);
    expect(ts).toBeLessThanOrEqual(after + 1000);
  });

  // -------------------------------------------------------------------------
  // Additional: dangling soft-FK logs warn and returns null
  // -------------------------------------------------------------------------

  it('lookupAgent logs warn and returns null for dangling soft-FK', async () => {
    vi.doMock('../../paths.js', () => ({ getCleoHome: () => env.cleoHome }));
    const machineKey = Buffer.alloc(32, 0xab);
    const globalSalt = Buffer.alloc(32, 0xcd);
    writeFileSync(join(env.cleoHome, 'machine-key'), machineKey, { mode: 0o600 });
    writeFileSync(join(env.cleoHome, 'global-salt'), globalSalt, { mode: 0o600 });

    const { ensureGlobalSignaldockDb } = await import('../signaldock-sqlite.js');
    const { ensureConduitDb, closeConduitDb } = await import('../conduit-sqlite.js');
    const { lookupAgent } = await import('../agent-registry-accessor.js');

    await ensureGlobalSignaldockDb();
    ensureConduitDb(env.projectRoot);
    closeConduitDb();

    // Insert a project_agent_refs row without a corresponding global agent
    const conduitDb = env.openConduit();
    conduitDb
      .prepare(
        `INSERT INTO project_agent_refs (agent_id, attached_at, enabled)
         VALUES (?, ?, 1)`,
      )
      .run('dangling-agent', new Date().toISOString());
    conduitDb.close();

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = lookupAgent(env.projectRoot, 'dangling-agent');
    expect(result).toBeNull();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('dangling project_agent_refs row'),
    );
    warnSpy.mockRestore();
  });

  // -------------------------------------------------------------------------
  // Additional: createProjectAgent re-enables previously detached agent
  // -------------------------------------------------------------------------

  it('createProjectAgent re-enables a previously detached (enabled=0) project ref', async () => {
    vi.doMock('../../paths.js', () => ({ getCleoHome: () => env.cleoHome }));
    const machineKey = Buffer.alloc(32, 0xab);
    const globalSalt = Buffer.alloc(32, 0xcd);
    writeFileSync(join(env.cleoHome, 'machine-key'), machineKey, { mode: 0o600 });
    writeFileSync(join(env.cleoHome, 'global-salt'), globalSalt, { mode: 0o600 });

    const { ensureGlobalSignaldockDb } = await import('../signaldock-sqlite.js');
    const { ensureConduitDb, closeConduitDb } = await import('../conduit-sqlite.js');
    const { AgentRegistryAccessor, createProjectAgent, lookupAgent } = await import(
      '../agent-registry-accessor.js'
    );

    await ensureGlobalSignaldockDb();
    ensureConduitDb(env.projectRoot);
    closeConduitDb();

    // Create and then detach
    createProjectAgent(env.projectRoot, BASE_SPEC);
    const accessor = new AgentRegistryAccessor(env.projectRoot);
    await accessor.remove(BASE_SPEC.agentId);

    // Confirm detached
    const afterRemove = lookupAgent(env.projectRoot, BASE_SPEC.agentId);
    expect(afterRemove).toBeNull();

    // Re-create should re-enable
    createProjectAgent(env.projectRoot, BASE_SPEC);

    const afterReCreate = lookupAgent(env.projectRoot, BASE_SPEC.agentId);
    expect(afterReCreate).not.toBeNull();
    expect(afterReCreate?.projectRef?.enabled).toBe(1);

    // Verify no duplicate rows in conduit.db
    const conduitDb = env.openConduit();
    const rows = conduitDb
      .prepare('SELECT agent_id FROM project_agent_refs WHERE agent_id = ?')
      .all(BASE_SPEC.agentId) as Array<{ agent_id: string }>;
    conduitDb.close();
    expect(rows).toHaveLength(1);
  });

  // -------------------------------------------------------------------------
  // Additional: listAgentsForProject with includeDisabled=true
  // -------------------------------------------------------------------------

  it('listAgentsForProject with includeDisabled=true includes enabled=0 rows', async () => {
    vi.doMock('../../paths.js', () => ({ getCleoHome: () => env.cleoHome }));
    const machineKey = Buffer.alloc(32, 0xab);
    const globalSalt = Buffer.alloc(32, 0xcd);
    writeFileSync(join(env.cleoHome, 'machine-key'), machineKey, { mode: 0o600 });
    writeFileSync(join(env.cleoHome, 'global-salt'), globalSalt, { mode: 0o600 });

    const { ensureGlobalSignaldockDb } = await import('../signaldock-sqlite.js');
    const { ensureConduitDb, closeConduitDb } = await import('../conduit-sqlite.js');
    const { AgentRegistryAccessor, createProjectAgent, listAgentsForProject } = await import(
      '../agent-registry-accessor.js'
    );

    await ensureGlobalSignaldockDb();
    ensureConduitDb(env.projectRoot);
    closeConduitDb();

    createProjectAgent(env.projectRoot, BASE_SPEC);

    // Detach the agent
    const accessor = new AgentRegistryAccessor(env.projectRoot);
    await accessor.remove(BASE_SPEC.agentId);

    // Default: should not include disabled
    const defaultList = listAgentsForProject(env.projectRoot);
    expect(defaultList).toHaveLength(0);

    // includeDisabled=true: should include disabled
    const disabledList = listAgentsForProject(env.projectRoot, { includeDisabled: true });
    expect(disabledList).toHaveLength(1);
    expect(disabledList[0]?.agentId).toBe(BASE_SPEC.agentId);
    expect(disabledList[0]?.projectRef?.enabled).toBe(0);
  });

  // -------------------------------------------------------------------------
  // Additional: AgentRegistryAccessor.list() is project-scoped only
  // -------------------------------------------------------------------------

  it('AgentRegistryAccessor.list() returns only project-attached agents', async () => {
    vi.doMock('../../paths.js', () => ({ getCleoHome: () => env.cleoHome }));
    const machineKey = Buffer.alloc(32, 0xab);
    const globalSalt = Buffer.alloc(32, 0xcd);
    writeFileSync(join(env.cleoHome, 'machine-key'), machineKey, { mode: 0o600 });
    writeFileSync(join(env.cleoHome, 'global-salt'), globalSalt, { mode: 0o600 });

    const { ensureGlobalSignaldockDb } = await import('../signaldock-sqlite.js');
    const { ensureConduitDb, closeConduitDb } = await import('../conduit-sqlite.js');
    const { AgentRegistryAccessor, createProjectAgent } = await import(
      '../agent-registry-accessor.js'
    );

    await ensureGlobalSignaldockDb();
    ensureConduitDb(env.projectRoot);
    closeConduitDb();

    // Add global-only agent
    const globalDb = env.openGlobal();
    const nowTs = Math.floor(Date.now() / 1000);
    globalDb
      .prepare(
        `INSERT INTO agents (id, agent_id, name, class, privacy_tier, capabilities, skills,
         transport_type, api_base_url, classification, transport_config, is_active, status,
         created_at, updated_at, requires_reauth)
         VALUES (?, ?, ?, 'custom', 'public', '[]', '[]', 'http',
                 'https://api.signaldock.io', NULL, '{}', 1, 'online', ?, ?, 0)`,
      )
      .run(crypto.randomUUID(), 'global-only-list', 'Global Only List', nowTs, nowTs);
    globalDb.close();

    createProjectAgent(env.projectRoot, BASE_SPEC);

    const accessor = new AgentRegistryAccessor(env.projectRoot);
    const list = await accessor.list();
    expect(list).toHaveLength(1);
    expect(list[0]?.agentId).toBe(BASE_SPEC.agentId);
  });

  // -------------------------------------------------------------------------
  // Additional: AgentRegistryAccessor.listGlobal() returns all global agents
  // -------------------------------------------------------------------------

  it('AgentRegistryAccessor.listGlobal() returns all global agents', async () => {
    vi.doMock('../../paths.js', () => ({ getCleoHome: () => env.cleoHome }));
    const machineKey = Buffer.alloc(32, 0xab);
    const globalSalt = Buffer.alloc(32, 0xcd);
    writeFileSync(join(env.cleoHome, 'machine-key'), machineKey, { mode: 0o600 });
    writeFileSync(join(env.cleoHome, 'global-salt'), globalSalt, { mode: 0o600 });

    const { ensureGlobalSignaldockDb } = await import('../signaldock-sqlite.js');
    const { ensureConduitDb, closeConduitDb } = await import('../conduit-sqlite.js');
    const { AgentRegistryAccessor, createProjectAgent } = await import(
      '../agent-registry-accessor.js'
    );

    await ensureGlobalSignaldockDb();
    ensureConduitDb(env.projectRoot);
    closeConduitDb();

    // Add global-only agent
    const globalDb = env.openGlobal();
    const nowTs = Math.floor(Date.now() / 1000);
    globalDb
      .prepare(
        `INSERT INTO agents (id, agent_id, name, class, privacy_tier, capabilities, skills,
         transport_type, api_base_url, classification, transport_config, is_active, status,
         created_at, updated_at, requires_reauth)
         VALUES (?, ?, ?, 'custom', 'public', '[]', '[]', 'http',
                 'https://api.signaldock.io', NULL, '{}', 1, 'online', ?, ?, 0)`,
      )
      .run(crypto.randomUUID(), 'global-only-listg', 'Global Only ListG', nowTs, nowTs);
    globalDb.close();

    createProjectAgent(env.projectRoot, BASE_SPEC);

    const accessor = new AgentRegistryAccessor(env.projectRoot);
    const list = await accessor.listGlobal();
    const agentIds = list.map((a) => a.agentId);
    expect(agentIds).toContain(BASE_SPEC.agentId);
    expect(agentIds).toContain('global-only-listg');
  });

  // -------------------------------------------------------------------------
  // Additional: removeGlobal throws when active project ref exists (no force)
  // -------------------------------------------------------------------------

  it('AgentRegistryAccessor.removeGlobal() throws when active project ref exists without force', async () => {
    vi.doMock('../../paths.js', () => ({ getCleoHome: () => env.cleoHome }));
    const machineKey = Buffer.alloc(32, 0xab);
    const globalSalt = Buffer.alloc(32, 0xcd);
    writeFileSync(join(env.cleoHome, 'machine-key'), machineKey, { mode: 0o600 });
    writeFileSync(join(env.cleoHome, 'global-salt'), globalSalt, { mode: 0o600 });

    const { ensureGlobalSignaldockDb } = await import('../signaldock-sqlite.js');
    const { ensureConduitDb, closeConduitDb } = await import('../conduit-sqlite.js');
    const { AgentRegistryAccessor, createProjectAgent } = await import(
      '../agent-registry-accessor.js'
    );

    await ensureGlobalSignaldockDb();
    ensureConduitDb(env.projectRoot);
    closeConduitDb();

    createProjectAgent(env.projectRoot, BASE_SPEC);

    const accessor = new AgentRegistryAccessor(env.projectRoot);
    await expect(accessor.removeGlobal(BASE_SPEC.agentId)).rejects.toThrow(
      /still has project references/,
    );

    // With force=true: should succeed
    await expect(accessor.removeGlobal(BASE_SPEC.agentId, { force: true })).resolves.not.toThrow();
  });
});
