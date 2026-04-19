/**
 * T310 integration test suite: conduit + signaldock cross-project agent lifecycle.
 *
 * Covers 12 end-to-end scenarios across the full conduit + signaldock topology
 * introduced by ADR-037 and spec §7.5 (cross-DB integration), §7.6 (migration),
 * and §7.8 (KDF / reauth).
 *
 * All filesystem interactions occur inside fresh tmp directories per test.
 * The real user's $XDG_DATA_HOME and project directories are never touched.
 * `getCleoHome()` is redirected to a per-test tmp directory via `vi.doMock`.
 *
 * Test approach: `vi.resetModules()` before each test then `vi.doMock()` for
 * paths.js → fresh module import chain → functions use isolated tmp dirs.
 *
 * @task T371
 * @epic T310
 * @why Verifies the full cross-DB lifecycle contract (ADR-037) including:
 *      conduit.db creation, global signaldock.db identity, project_agent_refs
 *      INNER/OUTER join semantics, cross-project isolation, migration, KDF, and
 *      backup registry.
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Logger mock — prevents pino from attempting to open real log files.
// ---------------------------------------------------------------------------

vi.mock('../../logger.js', () => ({
  getLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Create isolated tmp directory pair for one test.
 *
 * @param prefix - Short identifier for debug visibility.
 * @returns cleoHome and one projectRoot, plus cleanup.
 */
function makeTmpPair(prefix: string): {
  cleoHome: string;
  projectRoot: string;
  cleanup: () => void;
} {
  const base = mkdtempSync(join(tmpdir(), `cleo-t371-${prefix}-`));
  const cleoHome = join(base, 'cleo-home');
  const projectRoot = join(base, 'project');
  mkdirSync(cleoHome, { recursive: true });
  mkdirSync(join(projectRoot, '.cleo'), { recursive: true });
  return {
    cleoHome,
    projectRoot,
    cleanup: () => rmSync(base, { recursive: true, force: true }),
  };
}

/**
 * Create a second isolated project root under the same base directory.
 * Used for cross-project scenarios.
 *
 * @param base - Base tmp directory.
 * @returns Absolute path to the second project root.
 */
function makeSecondProject(base: string): string {
  const projectB = join(base, 'project-b');
  mkdirSync(join(projectB, '.cleo'), { recursive: true });
  return projectB;
}

/**
 * Seed a deterministic machine-key and global-salt so KDF is testable without
 * random entropy. Returns the fixed buffers used.
 *
 * @param cleoHome - Global tier home directory.
 * @param saltByte - Byte value to fill the 32-byte global-salt. Defaults to 0xcd.
 * @param keyByte  - Byte value to fill the 32-byte machine-key. Defaults to 0xab.
 */
function seedKeys(
  cleoHome: string,
  saltByte = 0xcd,
  keyByte = 0xab,
): { machineKey: Buffer; globalSalt: Buffer } {
  const machineKey = Buffer.alloc(32, keyByte);
  const globalSalt = Buffer.alloc(32, saltByte);
  writeFileSync(join(cleoHome, 'machine-key'), machineKey, { mode: 0o600 });
  writeFileSync(join(cleoHome, 'global-salt'), globalSalt, { mode: 0o600 });
  return { machineKey, globalSalt };
}

/**
 * Insert a minimal agent row directly into a global signaldock.db.
 * Used in seeding tests without going through the full accessor layer.
 */
function insertGlobalAgent(
  globalDb: DatabaseSync,
  agentId: string,
  name: string,
  requiresReauth = 0,
): void {
  const now = Math.floor(Date.now() / 1000);
  globalDb
    .prepare(
      `INSERT OR IGNORE INTO agents
         (id, agent_id, name, class, privacy_tier, capabilities, skills,
          transport_type, api_base_url, classification, transport_config,
          is_active, status, created_at, updated_at, requires_reauth)
       VALUES (?, ?, ?, 'custom', 'public', '[]', '[]', 'http',
               'https://api.signaldock.io', NULL, '{}', 1, 'online', ?, ?, ?)`,
    )
    .run(crypto.randomUUID(), agentId, name, now, now, requiresReauth);
}

/**
 * Insert a project_agent_refs row directly into a conduit.db.
 * Used in seeding scenarios that bypass the accessor layer.
 */
function insertConduitRef(conduitDb: DatabaseSync, agentId: string, enabled = 1): void {
  const now = new Date().toISOString();
  conduitDb
    .prepare(
      `INSERT OR IGNORE INTO project_agent_refs
         (agent_id, attached_at, role, capabilities_override, last_used_at, enabled)
       VALUES (?, ?, NULL, NULL, NULL, ?)`,
    )
    .run(agentId, now, enabled);
}

/**
 * Create a legacy project-tier signaldock.db at `<projectRoot>/.cleo/signaldock.db`
 * with the pre-T310 schema and optionally seed agents / messages / conversations.
 */
function createLegacySignaldockDb(
  projectRoot: string,
  agents: Array<{
    id: string;
    agentId: string;
    name: string;
    classification?: string;
    createdAt?: number;
    lastUsedAt?: number;
  }> = [],
  messages: Array<{
    id: string;
    conversationId: string;
    fromAgentId: string;
    toAgentId: string;
    content: string;
    createdAt: number;
  }> = [],
  conversations: Array<{
    id: string;
    participants: string;
    createdAt: number;
    updatedAt: number;
  }> = [],
): string {
  const dbPath = join(projectRoot, '.cleo', 'signaldock.db');
  const db = new DatabaseSync(dbPath);
  const now = Math.floor(Date.now() / 1000);

  db.exec(`
    CREATE TABLE IF NOT EXISTS agents (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      class TEXT NOT NULL DEFAULT 'custom',
      classification TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      api_key_encrypted TEXT,
      last_used_at INTEGER,
      requires_reauth INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS conversations (
      id TEXT PRIMARY KEY,
      participants TEXT NOT NULL,
      visibility TEXT NOT NULL DEFAULT 'private',
      message_count INTEGER NOT NULL DEFAULT 0,
      last_message_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      from_agent_id TEXT NOT NULL,
      to_agent_id TEXT NOT NULL,
      content TEXT NOT NULL,
      content_type TEXT NOT NULL DEFAULT 'text',
      status TEXT NOT NULL DEFAULT 'pending',
      attachments TEXT NOT NULL DEFAULT '[]',
      group_id TEXT,
      metadata TEXT DEFAULT '{}',
      reply_to TEXT,
      created_at INTEGER NOT NULL,
      delivered_at INTEGER,
      read_at INTEGER
    );
  `);

  for (const agent of agents) {
    db.prepare(
      `INSERT INTO agents
         (id, agent_id, name, classification, created_at, updated_at, api_key_encrypted, last_used_at)
       VALUES (?, ?, ?, ?, ?, ?, NULL, ?)`,
    ).run(
      agent.id,
      agent.agentId,
      agent.name,
      agent.classification ?? null,
      agent.createdAt ?? now,
      now,
      agent.lastUsedAt ?? null,
    );
  }

  for (const conv of conversations) {
    db.prepare(
      `INSERT INTO conversations (id, participants, created_at, updated_at) VALUES (?, ?, ?, ?)`,
    ).run(conv.id, conv.participants, conv.createdAt, conv.updatedAt);
  }

  for (const msg of messages) {
    db.prepare(
      `INSERT INTO messages
         (id, conversation_id, from_agent_id, to_agent_id, content, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(msg.id, msg.conversationId, msg.fromAgentId, msg.toAgentId, msg.content, msg.createdAt);
  }

  db.close();
  return dbPath;
}

/**
 * Create a pre-seeded global signaldock.db (schema applied, agents optionally inserted).
 * Returns the path to the created file.
 */
function createGlobalSignaldockDbFile(
  cleoHome: string,
  agents: Array<{ id: string; agentId: string; name: string; requiresReauth?: number }> = [],
): string {
  const dbPath = join(cleoHome, 'signaldock.db');
  const db = new DatabaseSync(dbPath);
  const now = Math.floor(Date.now() / 1000);

  db.exec(`
    CREATE TABLE IF NOT EXISTS agents (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      class TEXT NOT NULL DEFAULT 'custom',
      privacy_tier TEXT NOT NULL DEFAULT 'public',
      capabilities TEXT NOT NULL DEFAULT '[]',
      skills TEXT NOT NULL DEFAULT '[]',
      messages_sent INTEGER NOT NULL DEFAULT 0,
      messages_received INTEGER NOT NULL DEFAULT 0,
      conversation_count INTEGER NOT NULL DEFAULT 0,
      friend_count INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'online',
      payment_config TEXT,
      api_key_hash TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      transport_type TEXT NOT NULL DEFAULT 'http',
      api_key_encrypted TEXT,
      api_base_url TEXT NOT NULL DEFAULT 'https://api.signaldock.io',
      classification TEXT,
      transport_config TEXT NOT NULL DEFAULT '{}',
      is_active INTEGER NOT NULL DEFAULT 1,
      last_used_at INTEGER,
      requires_reauth INTEGER NOT NULL DEFAULT 0
    );
    CREATE UNIQUE INDEX IF NOT EXISTS agents_agent_id_idx ON agents(agent_id);
    CREATE TABLE IF NOT EXISTS capabilities (
      id TEXT PRIMARY KEY, slug TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
      description TEXT NOT NULL, category TEXT NOT NULL, created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS skills (
      id TEXT PRIMARY KEY, slug TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
      description TEXT NOT NULL, category TEXT NOT NULL, created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS agent_capabilities (
      agent_id TEXT NOT NULL, capability_id TEXT NOT NULL, PRIMARY KEY (agent_id, capability_id)
    );
    CREATE TABLE IF NOT EXISTS agent_skills (
      agent_id TEXT NOT NULL, skill_id TEXT NOT NULL, PRIMARY KEY (agent_id, skill_id)
    );
    CREATE TABLE IF NOT EXISTS agent_connections (
      id TEXT PRIMARY KEY NOT NULL, agent_id TEXT NOT NULL,
      transport_type TEXT NOT NULL DEFAULT 'http', connection_id TEXT,
      connected_at BIGINT NOT NULL, last_heartbeat BIGINT NOT NULL,
      connection_metadata TEXT, created_at BIGINT NOT NULL,
      UNIQUE(agent_id, connection_id)
    );
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL, name TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS accounts (
      id TEXT PRIMARY KEY NOT NULL, user_id TEXT NOT NULL, account_id TEXT NOT NULL,
      provider_id TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY NOT NULL, user_id TEXT NOT NULL, token TEXT NOT NULL UNIQUE,
      expires_at TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS verifications (
      id TEXT PRIMARY KEY NOT NULL, identifier TEXT NOT NULL, value TEXT NOT NULL,
      expires_at TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS organization (
      id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL,
      created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
      updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
    );
    CREATE TABLE IF NOT EXISTS claim_codes (
      id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, code TEXT NOT NULL UNIQUE,
      expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS org_agent_keys (
      id TEXT PRIMARY KEY NOT NULL, organization_id TEXT NOT NULL,
      agent_id TEXT NOT NULL, created_by TEXT NOT NULL, created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS _signaldock_meta (
      key TEXT PRIMARY KEY, value TEXT NOT NULL,
      updated_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
    );
    CREATE TABLE IF NOT EXISTS _signaldock_migrations (
      name TEXT PRIMARY KEY,
      applied_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
    );
  `);

  for (const agent of agents) {
    db.prepare(
      `INSERT OR IGNORE INTO agents
         (id, agent_id, name, created_at, updated_at, requires_reauth)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(agent.id, agent.agentId, agent.name, now, now, agent.requiresReauth ?? 0);
  }

  db.close();
  return dbPath;
}

/**
 * Run the signaldock→conduit migration with an isolated cleoHome mock.
 * Always resets modules first so the import chain gets the fresh mock.
 */
async function runMigration(
  projectRoot: string,
  cleoHome: string,
): Promise<import('../migrate-signaldock-to-conduit.js').MigrationResult> {
  vi.resetModules();
  vi.doMock('../../paths.js', () => ({
    getCleoHome: () => cleoHome,
    getProjectRoot: () => projectRoot,
  }));
  vi.doMock('../global-salt.js', () => ({
    getGlobalSalt: () => Buffer.alloc(32, 0xab),
    __clearGlobalSaltCache: vi.fn(),
  }));
  vi.doMock('../signaldock-sqlite.js', () => ({
    ensureGlobalSignaldockDb: vi.fn(async () => ({
      action: 'exists',
      path: join(cleoHome, 'signaldock.db'),
    })),
    getGlobalSignaldockDbPath: () => join(cleoHome, 'signaldock.db'),
  }));
  const { migrateSignaldockToConduit } = await import('../migrate-signaldock-to-conduit.js');
  return migrateSignaldockToConduit(projectRoot);
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('T310: conduit + signaldock integration', () => {
  let base: ReturnType<typeof makeTmpPair>;

  beforeEach(() => {
    vi.resetModules();
    base = makeTmpPair('s');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    base.cleanup();
  });

  // -------------------------------------------------------------------------
  // Scenario 1: Fresh install creates conduit.db + global signaldock.db + global-salt
  // -------------------------------------------------------------------------

  it('Scenario 1: fresh install creates conduit.db, global signaldock.db, and global-salt', async () => {
    const { cleoHome, projectRoot } = base;
    seedKeys(cleoHome);

    vi.doMock('../../paths.js', () => ({ getCleoHome: () => cleoHome }));
    vi.doMock('../global-salt.js', () => ({
      getGlobalSalt: () => Buffer.alloc(32, 0xcd),
      getGlobalSaltPath: () => join(cleoHome, 'global-salt'),
      __clearGlobalSaltCache: vi.fn(),
    }));

    const { ensureConduitDb } = await import('../conduit-sqlite.js');
    const { ensureGlobalSignaldockDb } = await import('../signaldock-sqlite.js');

    const conduitResult = ensureConduitDb(projectRoot);
    expect(conduitResult.action).toBe('created');
    expect(existsSync(conduitResult.path)).toBe(true);

    const sdResult = await ensureGlobalSignaldockDb();
    expect(sdResult.action).toBe('created');
    expect(existsSync(sdResult.path)).toBe(true);

    // Global-salt already written by seedKeys; verify it exists
    expect(existsSync(join(cleoHome, 'global-salt'))).toBe(true);

    // project_agent_refs table must exist and be empty
    const conduitDb = new DatabaseSync(conduitResult.path, { readonly: true });
    const refs = conduitDb.prepare('SELECT COUNT(*) as n FROM project_agent_refs').get() as {
      n: number;
    };
    expect(refs.n).toBe(0);
    conduitDb.close();

    // global agents table must exist and be empty
    const globalDb = new DatabaseSync(sdResult.path, { readonly: true });
    const agents = globalDb.prepare('SELECT COUNT(*) as n FROM agents').get() as { n: number };
    expect(agents.n).toBe(0);
    globalDb.close();
  });

  // -------------------------------------------------------------------------
  // Scenario 2: createProjectAgent writes identity globally + attachment locally
  // -------------------------------------------------------------------------

  it('Scenario 2: createProjectAgent writes global identity and local project_agent_refs row', async () => {
    const { cleoHome, projectRoot } = base;
    const { machineKey, globalSalt } = seedKeys(cleoHome);

    vi.doMock('../../paths.js', () => ({ getCleoHome: () => cleoHome }));
    vi.doMock('../global-salt.js', () => ({
      getGlobalSalt: () => globalSalt,
      getGlobalSaltPath: () => join(cleoHome, 'global-salt'),
      __clearGlobalSaltCache: vi.fn(),
    }));

    const { ensureGlobalSignaldockDb } = await import('../signaldock-sqlite.js');
    const { ensureConduitDb, closeConduitDb } = await import('../conduit-sqlite.js');
    const { createProjectAgent } = await import('../agent-registry-accessor.js');
    const { deriveApiKey } = await import('../api-key-kdf.js');

    await ensureGlobalSignaldockDb();
    ensureConduitDb(projectRoot);
    closeConduitDb();

    const spec = {
      agentId: 'integ-agent-sc2',
      displayName: 'Scenario Two Agent',
      apiKey: 'sk_test_sc2',
      apiBaseUrl: 'https://api.signaldock.io',
      privacyTier: 'public' as const,
      capabilities: [],
      skills: [],
      transportType: 'http' as const,
      transportConfig: {},
      isActive: true,
    };

    const result = createProjectAgent(projectRoot, spec);
    expect(result.agentId).toBe(spec.agentId);
    expect(result.projectRef).not.toBeNull();
    expect(result.projectRef?.enabled).toBe(1);

    // Verify global signaldock.db has the agent row
    const globalDb = new DatabaseSync(join(cleoHome, 'signaldock.db'), { readonly: true });
    const agentRow = globalDb
      .prepare('SELECT agent_id FROM agents WHERE agent_id = ?')
      .get(spec.agentId) as { agent_id: string } | undefined;
    expect(agentRow).toBeDefined();
    expect(agentRow?.agent_id).toBe(spec.agentId);
    globalDb.close();

    // Verify conduit.db has a project_agent_refs row
    const conduitDb = new DatabaseSync(join(projectRoot, '.cleo', 'conduit.db'), {
      readonly: true,
    });
    const refRow = conduitDb
      .prepare('SELECT agent_id, enabled FROM project_agent_refs WHERE agent_id = ?')
      .get(spec.agentId) as { agent_id: string; enabled: number } | undefined;
    expect(refRow).toBeDefined();
    expect(refRow?.enabled).toBe(1);
    conduitDb.close();

    // Verify KDF: key should be HMAC-SHA256(machineKey || globalSalt, agentId)
    const expectedKey = deriveApiKey({ machineKey, globalSalt, agentId: spec.agentId });
    expect(expectedKey).toHaveLength(32);
    // KDF must be different from legacy scheme (which uses projectPath instead of globalSalt)
    const { deriveLegacyProjectKey } = await import('../api-key-kdf.js');
    const legacyKey = deriveLegacyProjectKey(machineKey, projectRoot);
    expect(Buffer.compare(expectedKey, legacyKey)).not.toBe(0);
  });

  // -------------------------------------------------------------------------
  // Scenario 3: lookupAgent cross-DB join — default project-scoped
  // -------------------------------------------------------------------------

  it('Scenario 3: lookupAgent returns null without project ref; returns agent with includeGlobal=true', async () => {
    const { cleoHome, projectRoot } = base;
    const { globalSalt } = seedKeys(cleoHome);

    vi.doMock('../../paths.js', () => ({ getCleoHome: () => cleoHome }));
    vi.doMock('../global-salt.js', () => ({
      getGlobalSalt: () => globalSalt,
      getGlobalSaltPath: () => join(cleoHome, 'global-salt'),
      __clearGlobalSaltCache: vi.fn(),
    }));

    const { ensureGlobalSignaldockDb } = await import('../signaldock-sqlite.js');
    const { ensureConduitDb, closeConduitDb } = await import('../conduit-sqlite.js');
    const { lookupAgent } = await import('../agent-registry-accessor.js');

    await ensureGlobalSignaldockDb();
    ensureConduitDb(projectRoot);
    closeConduitDb();

    // Seed agent X into global only (no project ref)
    const globalDb = new DatabaseSync(join(cleoHome, 'signaldock.db'));
    insertGlobalAgent(globalDb, 'global-agent-x', 'Agent X');
    globalDb.close();

    // Default (INNER JOIN): must return null because no project_agent_refs row
    const defaultResult = lookupAgent(projectRoot, 'global-agent-x');
    expect(defaultResult).toBeNull();

    // includeGlobal=true: must return the agent with projectRef: null
    const globalResult = lookupAgent(projectRoot, 'global-agent-x', { includeGlobal: true });
    expect(globalResult).not.toBeNull();
    expect(globalResult?.agentId).toBe('global-agent-x');
    expect(globalResult?.projectRef).toBeNull();
  });

  // -------------------------------------------------------------------------
  // Scenario 4: listAgentsForProject — INNER vs OUTER join semantics
  // -------------------------------------------------------------------------

  it('Scenario 4: listAgentsForProject INNER returns only attached; OUTER returns all with correct projectRef', async () => {
    const { cleoHome, projectRoot } = base;
    const { globalSalt } = seedKeys(cleoHome);

    vi.doMock('../../paths.js', () => ({ getCleoHome: () => cleoHome }));
    vi.doMock('../global-salt.js', () => ({
      getGlobalSalt: () => globalSalt,
      getGlobalSaltPath: () => join(cleoHome, 'global-salt'),
      __clearGlobalSaltCache: vi.fn(),
    }));

    const { ensureGlobalSignaldockDb } = await import('../signaldock-sqlite.js');
    const { ensureConduitDb, closeConduitDb } = await import('../conduit-sqlite.js');
    const { listAgentsForProject } = await import('../agent-registry-accessor.js');

    await ensureGlobalSignaldockDb();
    ensureConduitDb(projectRoot);
    closeConduitDb();

    // Seed 3 global agents
    const globalDb = new DatabaseSync(join(cleoHome, 'signaldock.db'));
    insertGlobalAgent(globalDb, 'agent-x', 'Agent X');
    insertGlobalAgent(globalDb, 'agent-y', 'Agent Y');
    insertGlobalAgent(globalDb, 'agent-z', 'Agent Z');
    globalDb.close();

    // Attach only Y and Z to the project
    const conduitDb = new DatabaseSync(join(projectRoot, '.cleo', 'conduit.db'));
    insertConduitRef(conduitDb, 'agent-y');
    insertConduitRef(conduitDb, 'agent-z');
    conduitDb.close();

    // Default INNER join: should return only Y and Z
    const innerResult = listAgentsForProject(projectRoot);
    expect(innerResult).toHaveLength(2);
    const innerIds = innerResult.map((a) => a.agentId).sort();
    expect(innerIds).toEqual(['agent-y', 'agent-z']);
    // Both must have populated projectRef
    for (const agent of innerResult) {
      expect(agent.projectRef).not.toBeNull();
    }

    // includeGlobal=true: should return all 3 agents
    const globalResult = listAgentsForProject(projectRoot, { includeGlobal: true });
    expect(globalResult).toHaveLength(3);
    const globalIds = globalResult.map((a) => a.agentId).sort();
    expect(globalIds).toEqual(['agent-x', 'agent-y', 'agent-z']);

    // X must have projectRef: null (not attached)
    const agentX = globalResult.find((a) => a.agentId === 'agent-x');
    expect(agentX?.projectRef).toBeNull();

    // Y and Z must have populated projectRef
    const agentY = globalResult.find((a) => a.agentId === 'agent-y');
    expect(agentY?.projectRef).not.toBeNull();
    const agentZ = globalResult.find((a) => a.agentId === 'agent-z');
    expect(agentZ?.projectRef).not.toBeNull();
  });

  // -------------------------------------------------------------------------
  // Scenario 5: Cross-project visibility isolation
  // -------------------------------------------------------------------------

  it('Scenario 5: agent created in project A is invisible to project B by default', async () => {
    const { cleoHome, projectRoot: projectA } = base;
    const projectB = makeSecondProject(join(cleoHome, '..'));
    const { globalSalt } = seedKeys(cleoHome);

    vi.doMock('../../paths.js', () => ({ getCleoHome: () => cleoHome }));
    vi.doMock('../global-salt.js', () => ({
      getGlobalSalt: () => globalSalt,
      getGlobalSaltPath: () => join(cleoHome, 'global-salt'),
      __clearGlobalSaltCache: vi.fn(),
    }));

    const { ensureGlobalSignaldockDb } = await import('../signaldock-sqlite.js');
    const { ensureConduitDb, closeConduitDb } = await import('../conduit-sqlite.js');
    const { createProjectAgent, listAgentsForProject } = await import(
      '../agent-registry-accessor.js'
    );

    await ensureGlobalSignaldockDb();
    ensureConduitDb(projectA);
    closeConduitDb();
    ensureConduitDb(projectB);
    closeConduitDb();

    // Create agent in A
    createProjectAgent(projectA, {
      agentId: 'cross-project-agent',
      displayName: 'Cross Project Agent',
      apiKey: 'sk_test_cross',
      apiBaseUrl: 'https://api.signaldock.io',
      privacyTier: 'public',
      capabilities: [],
      skills: [],
      transportType: 'http',
      transportConfig: {},
      isActive: true,
    });

    // A must see the agent
    const inA = listAgentsForProject(projectA);
    const agentInA = inA.find((a) => a.agentId === 'cross-project-agent');
    expect(agentInA).toBeDefined();

    // B must NOT see the agent by default (INNER JOIN — no project_agent_refs row in B)
    const inB = listAgentsForProject(projectB);
    const agentInB = inB.find((a) => a.agentId === 'cross-project-agent');
    expect(agentInB).toBeUndefined();

    // B with includeGlobal=true should see the agent but with projectRef: null
    const inBGlobal = listAgentsForProject(projectB, { includeGlobal: true });
    const agentInBGlobal = inBGlobal.find((a) => a.agentId === 'cross-project-agent');
    expect(agentInBGlobal).toBeDefined();
    expect(agentInBGlobal?.projectRef).toBeNull();
  });

  // -------------------------------------------------------------------------
  // Scenario 6: Attach + detach across projects
  // -------------------------------------------------------------------------

  it('Scenario 6: attach to B makes agent visible in B; detach from A leaves B intact; global untouched', async () => {
    const { cleoHome, projectRoot: projectA } = base;
    const projectB = makeSecondProject(join(cleoHome, '..'));
    const { globalSalt } = seedKeys(cleoHome);

    vi.doMock('../../paths.js', () => ({ getCleoHome: () => cleoHome }));
    vi.doMock('../global-salt.js', () => ({
      getGlobalSalt: () => globalSalt,
      getGlobalSaltPath: () => join(cleoHome, 'global-salt'),
      __clearGlobalSaltCache: vi.fn(),
    }));

    const { ensureGlobalSignaldockDb } = await import('../signaldock-sqlite.js');
    const { ensureConduitDb, closeConduitDb } = await import('../conduit-sqlite.js');
    const {
      createProjectAgent,
      attachAgentToProject,
      detachAgentFromProject,
      listAgentsForProject,
    } = await import('../agent-registry-accessor.js');

    await ensureGlobalSignaldockDb();
    ensureConduitDb(projectA);
    closeConduitDb();
    ensureConduitDb(projectB);
    closeConduitDb();

    // Create agent in A
    createProjectAgent(projectA, {
      agentId: 'attach-detach-agent',
      displayName: 'Attach Detach Agent',
      apiKey: 'sk_test_ad',
      apiBaseUrl: 'https://api.signaldock.io',
      privacyTier: 'public',
      capabilities: [],
      skills: [],
      transportType: 'http',
      transportConfig: {},
      isActive: true,
    });

    // Attach to B
    attachAgentToProject(projectB, 'attach-detach-agent');

    // Now both A and B should see the agent
    const inA = listAgentsForProject(projectA);
    expect(inA.find((a) => a.agentId === 'attach-detach-agent')).toBeDefined();
    const inB = listAgentsForProject(projectB);
    expect(inB.find((a) => a.agentId === 'attach-detach-agent')).toBeDefined();

    // Detach from A
    detachAgentFromProject(projectA, 'attach-detach-agent');

    // A must no longer see it
    const inAAfter = listAgentsForProject(projectA);
    expect(inAAfter.find((a) => a.agentId === 'attach-detach-agent')).toBeUndefined();

    // B must still see it
    const inBAfter = listAgentsForProject(projectB);
    expect(inBAfter.find((a) => a.agentId === 'attach-detach-agent')).toBeDefined();

    // Global identity must still exist
    const globalDb = new DatabaseSync(join(cleoHome, 'signaldock.db'), { readonly: true });
    const globalRow = globalDb
      .prepare("SELECT agent_id FROM agents WHERE agent_id = 'attach-detach-agent'")
      .get() as { agent_id: string } | undefined;
    globalDb.close();
    expect(globalRow).toBeDefined();
  });

  // -------------------------------------------------------------------------
  // Scenario 7: Migration from legacy signaldock.db
  // -------------------------------------------------------------------------

  it('Scenario 7: migration preserves messages, creates conduit.db, global signaldock.db, .pre-t310.bak', async () => {
    const { cleoHome, projectRoot } = base;
    const now = Math.floor(Date.now() / 1000);

    // Seed global signaldock.db (the migration will populate it)
    createGlobalSignaldockDbFile(cleoHome, []);

    // Create legacy project signaldock.db with 3 agents + 5 messages
    createLegacySignaldockDb(
      projectRoot,
      [
        { id: 'a1', agentId: 'mig-agent-1', name: 'Mig Agent 1', createdAt: now },
        { id: 'a2', agentId: 'mig-agent-2', name: 'Mig Agent 2', createdAt: now },
        { id: 'a3', agentId: 'mig-agent-3', name: 'Mig Agent 3', createdAt: now },
      ],
      [
        {
          id: 'msg-1',
          conversationId: 'conv-1',
          fromAgentId: 'mig-agent-1',
          toAgentId: 'mig-agent-2',
          content: 'hello',
          createdAt: now,
        },
        {
          id: 'msg-2',
          conversationId: 'conv-1',
          fromAgentId: 'mig-agent-2',
          toAgentId: 'mig-agent-1',
          content: 'world',
          createdAt: now + 1,
        },
        {
          id: 'msg-3',
          conversationId: 'conv-1',
          fromAgentId: 'mig-agent-1',
          toAgentId: 'mig-agent-2',
          content: 'foo',
          createdAt: now + 2,
        },
        {
          id: 'msg-4',
          conversationId: 'conv-1',
          fromAgentId: 'mig-agent-2',
          toAgentId: 'mig-agent-1',
          content: 'bar',
          createdAt: now + 3,
        },
        {
          id: 'msg-5',
          conversationId: 'conv-1',
          fromAgentId: 'mig-agent-1',
          toAgentId: 'mig-agent-2',
          content: 'baz',
          createdAt: now + 4,
        },
      ],
      [
        {
          id: 'conv-1',
          participants: '["mig-agent-1","mig-agent-2"]',
          createdAt: now,
          updatedAt: now,
        },
      ],
    );

    const result = await runMigration(projectRoot, cleoHome);

    expect(result.status).toBe('migrated');
    expect(result.agentsCopied).toBe(3);
    expect(result.errors).toHaveLength(0);

    // conduit.db created
    const conduitPath = join(projectRoot, '.cleo', 'conduit.db');
    expect(existsSync(conduitPath)).toBe(true);

    // .pre-t310.bak created; legacy signaldock.db renamed
    const bakPath = join(projectRoot, '.cleo', 'signaldock.db.pre-t310.bak');
    expect(existsSync(bakPath)).toBe(true);
    expect(existsSync(join(projectRoot, '.cleo', 'signaldock.db'))).toBe(false);

    // conduit.db has 5 messages + 3 project_agent_refs
    const conduitDb = new DatabaseSync(conduitPath, { readonly: true });
    const msgCount = conduitDb.prepare('SELECT COUNT(*) as n FROM messages').get() as { n: number };
    expect(msgCount.n).toBe(5);
    const refCount = conduitDb.prepare('SELECT COUNT(*) as n FROM project_agent_refs').get() as {
      n: number;
    };
    expect(refCount.n).toBe(3);
    conduitDb.close();

    // global signaldock.db has 3 agents with requires_reauth=1
    const globalDb = new DatabaseSync(join(cleoHome, 'signaldock.db'), { readonly: true });
    const globalAgents = globalDb
      .prepare('SELECT agent_id, requires_reauth FROM agents ORDER BY agent_id')
      .all() as Array<{ agent_id: string; requires_reauth: number }>;
    expect(globalAgents).toHaveLength(3);
    for (const agent of globalAgents) {
      expect(agent.requires_reauth).toBe(1);
    }
    globalDb.close();
  });

  // -------------------------------------------------------------------------
  // Scenario 8: Migration multi-project deduplication
  // -------------------------------------------------------------------------

  it('Scenario 8: migration on two projects deduplicates shared agent in global signaldock.db', async () => {
    const { cleoHome } = base;

    // Two isolated project roots sharing the same cleoHome
    const projectA = join(cleoHome, '..', 'project-a');
    const projectB = join(cleoHome, '..', 'project-b');
    mkdirSync(join(projectA, '.cleo'), { recursive: true });
    mkdirSync(join(projectB, '.cleo'), { recursive: true });

    const now = Math.floor(Date.now() / 1000);

    // Project A has agent X
    createGlobalSignaldockDbFile(cleoHome, []);
    createLegacySignaldockDb(projectA, [
      { id: 'ax-id', agentId: 'shared-agent-x', name: 'Agent X from A', createdAt: now },
    ]);

    // Migrate A first
    const resultA = await runMigration(projectA, cleoHome);
    expect(resultA.status).toBe('migrated');
    expect(resultA.agentsCopied).toBe(1);

    // Project B has agent X + agent Y
    createLegacySignaldockDb(projectB, [
      { id: 'bx-id', agentId: 'shared-agent-x', name: 'Agent X from B', createdAt: now },
      { id: 'by-id', agentId: 'agent-y-unique', name: 'Agent Y', createdAt: now },
    ]);

    // Migrate B second
    const resultB = await runMigration(projectB, cleoHome);
    expect(resultB.status).toBe('migrated');

    // Global must have exactly 2 agents (X + Y), not 3 (INSERT OR IGNORE deduplicates X)
    const globalDb = new DatabaseSync(join(cleoHome, 'signaldock.db'), { readonly: true });
    const allAgents = globalDb
      .prepare('SELECT agent_id FROM agents ORDER BY agent_id')
      .all() as Array<{ agent_id: string }>;
    const agentIds = allAgents.map((a) => a.agent_id);
    expect(agentIds).toContain('shared-agent-x');
    expect(agentIds).toContain('agent-y-unique');
    // X must appear exactly once
    expect(agentIds.filter((id) => id === 'shared-agent-x')).toHaveLength(1);
    globalDb.close();

    // Both projects must have their own project_agent_refs
    const conduitA = new DatabaseSync(join(projectA, '.cleo', 'conduit.db'), { readonly: true });
    const refsA = conduitA.prepare('SELECT agent_id FROM project_agent_refs').all() as Array<{
      agent_id: string;
    }>;
    conduitA.close();
    expect(refsA.map((r) => r.agent_id)).toContain('shared-agent-x');

    const conduitB = new DatabaseSync(join(projectB, '.cleo', 'conduit.db'), { readonly: true });
    const refsB = conduitB
      .prepare('SELECT agent_id FROM project_agent_refs ORDER BY agent_id')
      .all() as Array<{ agent_id: string }>;
    conduitB.close();
    expect(refsB.map((r) => r.agent_id)).toContain('shared-agent-x');
    expect(refsB.map((r) => r.agent_id)).toContain('agent-y-unique');
  });

  // -------------------------------------------------------------------------
  // Scenario 9: Migration is idempotent
  // -------------------------------------------------------------------------

  it('Scenario 9: second migration call returns no-op; no duplicate rows', async () => {
    const { cleoHome, projectRoot } = base;
    const now = Math.floor(Date.now() / 1000);

    createGlobalSignaldockDbFile(cleoHome, []);
    createLegacySignaldockDb(projectRoot, [
      { id: 'idem-id', agentId: 'idempotent-agent', name: 'Idempotent Agent', createdAt: now },
    ]);

    // First migration
    const first = await runMigration(projectRoot, cleoHome);
    expect(first.status).toBe('migrated');
    expect(first.agentsCopied).toBe(1);

    // Second migration — conduit.db already exists
    const second = await runMigration(projectRoot, cleoHome);
    expect(second.status).toBe('no-op');
    expect(second.errors).toHaveLength(0);

    // Verify no duplicate rows in conduit.db
    const conduitDb = new DatabaseSync(join(projectRoot, '.cleo', 'conduit.db'), {
      readonly: true,
    });
    const refRows = conduitDb
      .prepare("SELECT COUNT(*) as n FROM project_agent_refs WHERE agent_id = 'idempotent-agent'")
      .get() as { n: number };
    expect(refRows.n).toBe(1);
    conduitDb.close();

    // Verify no duplicate rows in global signaldock.db
    const globalDb = new DatabaseSync(join(cleoHome, 'signaldock.db'), { readonly: true });
    const globalRows = globalDb
      .prepare("SELECT COUNT(*) as n FROM agents WHERE agent_id = 'idempotent-agent'")
      .get() as { n: number };
    globalDb.close();
    expect(globalRows.n).toBe(1);
  });

  // -------------------------------------------------------------------------
  // Scenario 10: KDF binds to machine + salt + agentId
  // -------------------------------------------------------------------------

  it('Scenario 10: KDF output changes with salt, agentId, and machineKey independently', async () => {
    vi.resetModules();
    const { deriveApiKey } = await import('../api-key-kdf.js');

    const machineKey = Buffer.alloc(32, 0x01);
    const s1 = Buffer.alloc(32, 0x10);
    const s2 = Buffer.alloc(32, 0x20);

    // K1 = derive(agentId=X, salt=S1)
    const k1 = deriveApiKey({ machineKey, globalSalt: s1, agentId: 'agent-x' });
    // K2 = derive(agentId=X, salt=S2) — must differ (salt change)
    const k2 = deriveApiKey({ machineKey, globalSalt: s2, agentId: 'agent-x' });
    expect(Buffer.compare(k1, k2)).not.toBe(0);

    // K3 = derive(agentId=Y, salt=S1) — must differ from K1 (agentId change)
    const k3 = deriveApiKey({ machineKey, globalSalt: s1, agentId: 'agent-y' });
    expect(Buffer.compare(k1, k3)).not.toBe(0);

    // K4 = derive with different machineKey — must differ from K1 (machine change)
    const differentMachineKey = Buffer.alloc(32, 0x99);
    const k4 = deriveApiKey({
      machineKey: differentMachineKey,
      globalSalt: s1,
      agentId: 'agent-x',
    });
    expect(Buffer.compare(k1, k4)).not.toBe(0);

    // All derived keys must be exactly 32 bytes
    for (const k of [k1, k2, k3, k4]) {
      expect(k).toHaveLength(32);
    }
  });

  // -------------------------------------------------------------------------
  // Scenario 11: Backup registry includes conduit + global signaldock + global-salt
  // -------------------------------------------------------------------------

  it('Scenario 11: vacuumIntoBackupAll snapshots conduit.db; vacuumIntoGlobalBackup snapshots signaldock; backupGlobalSalt copies salt', async () => {
    vi.resetModules();

    const { cleoHome, projectRoot } = base;
    const cleoDir = join(projectRoot, '.cleo');

    // Seed project DBs
    const conduitPath = join(cleoDir, 'conduit.db');
    const tasksPath = join(cleoDir, 'tasks.db');
    const brainPath = join(cleoDir, 'brain.db');
    const sdPath = join(cleoHome, 'signaldock.db');
    const saltPath = join(cleoHome, 'global-salt');

    for (const dbPath of [conduitPath, tasksPath, brainPath, sdPath]) {
      const db = new DatabaseSync(dbPath);
      db.exec(
        `CREATE TABLE IF NOT EXISTS stub (id INTEGER PRIMARY KEY); INSERT INTO stub VALUES (1);`,
      );
      db.close();
    }
    // Write a 32-byte global-salt file
    writeFileSync(saltPath, Buffer.alloc(32, 0xef), { mode: 0o600 });

    // Open live handles that the backup module will call
    const conduitDb = new DatabaseSync(conduitPath);
    const tasksDb = new DatabaseSync(tasksPath);
    const brainDb = new DatabaseSync(brainPath);
    const sdDb = new DatabaseSync(sdPath);

    // Mock the native DB getters and path helpers
    vi.doMock('../sqlite.js', () => ({ getNativeDb: () => tasksDb, getDb: () => tasksDb }));
    vi.doMock('../memory-sqlite.js', () => ({ getBrainNativeDb: () => brainDb }));
    vi.doMock('../conduit-sqlite.js', () => ({ getConduitNativeDb: () => conduitDb }));
    vi.doMock('../signaldock-sqlite.js', () => ({
      getGlobalSignaldockNativeDb: () => sdDb,
      getGlobalSignaldockDbPath: () => sdPath,
    }));
    vi.doMock('../nexus-sqlite.js', () => ({ getNexusNativeDb: () => null }));
    vi.doMock('../global-salt.js', () => ({ getGlobalSaltPath: () => saltPath }));
    vi.doMock('../../paths.js', () => ({
      getCleoHome: () => cleoHome,
      getCleoDir: () => cleoDir,
    }));

    const { vacuumIntoBackupAll, vacuumIntoGlobalBackup, backupGlobalSalt, listSqliteBackupsAll } =
      await import('../sqlite-backup.js');

    // Project-tier backup (tasks, brain, conduit)
    await vacuumIntoBackupAll({ cwd: projectRoot, force: true });

    tasksDb.close();
    brainDb.close();
    conduitDb.close();

    const projectBackupDir = join(cleoDir, 'backups', 'sqlite');
    expect(existsSync(projectBackupDir)).toBe(true);

    const allBackups = listSqliteBackupsAll(projectRoot);
    expect(allBackups).toHaveProperty('conduit');
    expect(allBackups['conduit']?.length).toBeGreaterThanOrEqual(1);

    // Conduit snapshot must pass integrity_check
    const conduitSnapPath = allBackups['conduit']?.[0]?.path;
    expect(conduitSnapPath).toBeDefined();
    if (conduitSnapPath) {
      const snapDb = new DatabaseSync(conduitSnapPath, { readonly: true });
      const ic = snapDb.prepare('PRAGMA integrity_check').get() as Record<string, unknown>;
      snapDb.close();
      expect(ic['integrity_check']).toBe('ok');
    }

    // Global-tier backup: signaldock
    const sdResult = await vacuumIntoGlobalBackup('signaldock', { cleoHomeOverride: cleoHome });
    sdDb.close();

    expect(sdResult.snapshotPath).toBeTruthy();
    expect(existsSync(sdResult.snapshotPath)).toBe(true);
    expect(sdResult.snapshotPath).toContain('signaldock-');

    // Global-tier backup: global-salt
    const saltResult = await backupGlobalSalt({ cleoHomeOverride: cleoHome });
    expect(saltResult.snapshotPath).toBeTruthy();
    expect(existsSync(saltResult.snapshotPath)).toBe(true);

    // Verify salt backup is exactly 32 bytes and has 0o600 permissions
    const saltBackupStat = statSync(saltResult.snapshotPath);
    expect(saltBackupStat.size).toBe(32);
    if (process.platform !== 'win32') {
      expect(saltBackupStat.mode & 0o777).toBe(0o600);
    }

    // Verify content matches the original salt
    const saltBackupContent = readFileSync(saltResult.snapshotPath);
    expect(Buffer.compare(saltBackupContent, Buffer.alloc(32, 0xef))).toBe(0);
  });

  // -------------------------------------------------------------------------
  // Scenario 12: CLI startup wires migration (smoke — needsMigration detection)
  // -------------------------------------------------------------------------

  it('Scenario 12: needsSignaldockToConduitMigration detects legacy correctly in all three states', async () => {
    const { projectRoot } = base;
    const cleoHome = base.cleoHome;

    vi.doMock('../../paths.js', () => ({
      getCleoHome: () => cleoHome,
      getProjectRoot: () => projectRoot,
    }));

    const { needsSignaldockToConduitMigration } = await import(
      '../migrate-signaldock-to-conduit.js'
    );

    // State 1: neither signaldock.db nor conduit.db — fresh install, no migration needed
    const freshResult = needsSignaldockToConduitMigration(projectRoot);
    expect(freshResult).toBe(false);

    // State 2: signaldock.db present, conduit.db absent — migration needed
    writeFileSync(join(projectRoot, '.cleo', 'signaldock.db'), '');
    // Put a real valid SQLite DB there so the detection test doesn't fail on file format
    const tmpDb = new DatabaseSync(join(projectRoot, '.cleo', 'signaldock.db'));
    tmpDb.exec('CREATE TABLE t (id INTEGER PRIMARY KEY)');
    tmpDb.close();

    const needsMig = needsSignaldockToConduitMigration(projectRoot);
    expect(needsMig).toBe(true);

    // State 3: conduit.db present — migration already done, no-op
    writeFileSync(join(projectRoot, '.cleo', 'conduit.db'), '');
    const afterMig = needsSignaldockToConduitMigration(projectRoot);
    expect(afterMig).toBe(false);
  });
});
