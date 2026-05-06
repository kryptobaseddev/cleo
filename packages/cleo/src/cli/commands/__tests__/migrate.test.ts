/**
 * Unit tests for T1938: cleo migrate agents-v2
 *
 * Tests drive the migration walker (runMigrateAgentsV2 + walkAgentsDir) against
 * a real node:sqlite signaldock.db created under a per-test tmp CLEO_HOME.
 * The filesystem is real; only `paths.ts` is redirected to point at the tmp
 * workspace rather than the developer's real ~/.local/share/cleo.
 *
 * Coverage:
 * 1. Empty .cleo/agents/ — no files, reports "0 registered, 0 skipped, 0 conflicts"
 * 2. Pre-populated files already in DB — walker reports "0 registered, N skipped, 0 conflicts"
 * 3. Pre-populated files, DB empty — walker registers all N, reports "N registered, 0 skipped, 0 conflicts"
 * 4. Mix of canonical + custom agents — registers all
 * 5. Conflict detection — same name, different content → logged, not overwritten, exit 0
 * 6. Idempotency — re-running on previously-migrated state produces no changes
 * 7. Doctor surfaces conflicts — readMigrationConflicts returns conflict entries
 *
 * @task T1938
 * @epic T1929
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MigrationSummary } from '../migrate-agents-v2.js';
// extractAgentName and walkAgentsDir are used directly in unit describe blocks.
// runMigrateAgentsV2 and readMigrationConflicts are dynamically imported per-test
// (after vi.resetModules()) so they pick up the mocked paths module.
import { extractAgentName, walkAgentsDir } from '../migrate-agents-v2.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Build a minimal valid .cant manifest for a given agent name. */
function makeCant(agentName: string, role = 'worker'): string {
  return `---
kind: agent
version: 1
---

agent ${agentName}:
  role: ${role}
  parent: cleo-prime
  description: "Fixture agent ${agentName} for migration tests."
  prompt: "You are the ${agentName} fixture."
  skills: []
`;
}

/** A modified version of a fixture — different content, same filename. */
function makeModifiedCant(agentName: string): string {
  return `---
kind: agent
version: 1
---

agent ${agentName}:
  role: reviewer
  parent: cleo-prime
  description: "MODIFIED fixture agent ${agentName} — simulates user customisation."
  prompt: "You are the modified ${agentName}."
  skills: []
`;
}

// ---------------------------------------------------------------------------
// Tmp-environment helper (mirrors the W2-6 install test pattern)
// ---------------------------------------------------------------------------

interface TmpEnv {
  base: string;
  cleoHome: string;
  projectRoot: string;
  dbPath: string;
  cleanup: () => void;
}

/**
 * Create a fresh per-test workspace, override `paths.ts` to point at it,
 * and run the real signaldock.db migrations.
 * Must be called before any dynamic import of `@cleocode/core` in the test.
 */
async function makeTmpEnv(suffix: string): Promise<TmpEnv> {
  const base = mkdtempSync(join(tmpdir(), `cleo-migrate-av2-${suffix}-`));
  const cleoHome = join(base, 'cleo-home');
  const projectRoot = join(base, 'project');

  mkdirSync(cleoHome, { recursive: true });
  mkdirSync(join(projectRoot, '.cleo', 'cant', 'agents'), { recursive: true });
  mkdirSync(join(projectRoot, '.cleo', 'agents'), { recursive: true });
  mkdirSync(join(projectRoot, '.cleo', 'audit'), { recursive: true });

  // Deterministic machine-key / global-salt so ensureGlobalSignaldockDb() is happy.
  writeFileSync(join(cleoHome, 'machine-key'), Buffer.alloc(32, 0xab), { mode: 0o600 });
  writeFileSync(join(cleoHome, 'global-salt'), Buffer.alloc(32, 0xcd), { mode: 0o600 });

  // Redirect paths.ts — the ONLY module substitution in this suite.
  vi.doMock('../../../../../../packages/core/src/paths.js', async () => {
    const actual = await vi.importActual<typeof import('../../../../../core/src/paths.js')>(
      '../../../../../../packages/core/src/paths.js',
    );
    return {
      ...actual,
      getCleoHome: () => cleoHome,
      getCleoGlobalAgentsDir: () => join(cleoHome, 'agents'),
      getCleoGlobalCantAgentsDir: () => join(cleoHome, 'cant', 'agents'),
    };
  });

  vi.doMock('@cleocode/core/paths', async () => {
    const actual = await vi.importActual<typeof import('../../../../../core/src/paths.js')>(
      '../../../../../../packages/core/src/paths.js',
    );
    return {
      ...actual,
      getCleoHome: () => cleoHome,
      getCleoGlobalAgentsDir: () => join(cleoHome, 'agents'),
      getCleoGlobalCantAgentsDir: () => join(cleoHome, 'cant', 'agents'),
    };
  });

  // Bootstrap the signaldock.db with real migrations.
  const { ensureGlobalSignaldockDb, _resetGlobalSignaldockDb_TESTING_ONLY } = await import(
    '@cleocode/core/internal'
  );
  _resetGlobalSignaldockDb_TESTING_ONLY();
  await ensureGlobalSignaldockDb();

  const dbPath = join(cleoHome, 'signaldock.db');

  const cleanup = (): void => {
    _resetGlobalSignaldockDb_TESTING_ONLY();
    rmSync(base, { recursive: true, force: true });
  };

  return { base, cleoHome, projectRoot, dbPath, cleanup };
}

/** Open a direct read-only handle to signaldock.db for assertions. */
function openDb(dbPath: string): DatabaseSync {
  const d = new DatabaseSync(dbPath);
  d.exec('PRAGMA foreign_keys = ON');
  return d;
}

/** Write a .cant file at the given directory and filename. */
function writeCant(dir: string, filename: string, body: string): string {
  mkdirSync(dir, { recursive: true });
  const p = join(dir, filename);
  writeFileSync(p, body, 'utf8');
  return p;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('T1938 cleo migrate agents-v2', () => {
  let env: TmpEnv;
  let origCwd: string;

  beforeEach(async () => {
    vi.resetModules();
    process.exitCode = undefined;
    origCwd = process.cwd();
    env = await makeTmpEnv(Math.random().toString(36).slice(2));
    process.chdir(env.projectRoot);
  });

  afterEach(() => {
    process.chdir(origCwd);
    env.cleanup();
    vi.doUnmock('../../../../../../packages/core/src/paths.js');
    vi.doUnmock('@cleocode/core/paths');
    vi.resetModules();
  });

  // 1. Empty directories — no files → 0/0/0
  it('reports 0/0/0 when both agent directories are empty', async () => {
    const { _resetGlobalSignaldockDb_TESTING_ONLY } = await import('@cleocode/core/internal');
    _resetGlobalSignaldockDb_TESTING_ONLY();
    const { runMigrateAgentsV2: run } = await import('../migrate-agents-v2.js');

    const summary = await run(env.projectRoot, false);

    expect(summary.registered).toBe(0);
    expect(summary.skipped).toBe(0);
    expect(summary.conflicts).toBe(0);
    expect(summary.errors).toBe(0);
  });

  // 2. Files already in DB with same sha256 → all skipped
  it('skips all files when they are already registered with matching sha256', async () => {
    const {
      _resetGlobalSignaldockDb_TESTING_ONLY,
      ensureGlobalSignaldockDb,
      getGlobalSignaldockDbPath,
    } = await import('@cleocode/core/internal');
    _resetGlobalSignaldockDb_TESTING_ONLY();
    await ensureGlobalSignaldockDb();

    const cantDir = join(env.projectRoot, '.cleo', 'cant', 'agents');
    const agents = [
      'alpha-worker',
      'beta-worker',
      'gamma-worker',
      'delta-worker',
      'epsilon-worker',
    ];

    // Write .cant files and pre-register them in the DB.
    const { installAgentFromCant } = await import('@cleocode/core/internal');
    const db = new DatabaseSync(getGlobalSignaldockDbPath());
    db.exec('PRAGMA foreign_keys = ON');
    db.exec('PRAGMA journal_mode = WAL');
    try {
      for (const name of agents) {
        writeCant(cantDir, `${name}.cant`, makeCant(name));
        // Pre-register via installAgentFromCant with the same content.
        installAgentFromCant(db, {
          cantSource: join(cantDir, `${name}.cant`),
          targetTier: 'project',
          installedFrom: 'seed',
          projectRoot: env.projectRoot,
          force: true,
        });
      }
    } finally {
      db.close();
    }

    _resetGlobalSignaldockDb_TESTING_ONLY();
    const { runMigrateAgentsV2: run } = await import('../migrate-agents-v2.js');
    const summary = await run(env.projectRoot, false);

    expect(summary.registered).toBe(0);
    expect(summary.skipped).toBe(agents.length);
    expect(summary.conflicts).toBe(0);
    expect(summary.errors).toBe(0);
  });

  // 3. Files on disk, DB empty → all registered
  it('registers all .cant files when DB has no matching rows', async () => {
    const { _resetGlobalSignaldockDb_TESTING_ONLY } = await import('@cleocode/core/internal');
    _resetGlobalSignaldockDb_TESTING_ONLY();

    const cantDir = join(env.projectRoot, '.cleo', 'cant', 'agents');
    const agents = ['foo-worker', 'bar-worker', 'baz-worker', 'qux-worker', 'quux-worker'];

    for (const name of agents) {
      writeCant(cantDir, `${name}.cant`, makeCant(name));
    }

    const { runMigrateAgentsV2: run } = await import('../migrate-agents-v2.js');
    const summary = await run(env.projectRoot, false);

    expect(summary.registered).toBe(agents.length);
    expect(summary.skipped).toBe(0);
    expect(summary.conflicts).toBe(0);
    expect(summary.errors).toBe(0);

    // Verify rows exist in signaldock.db.
    const { getGlobalSignaldockDbPath } = await import('@cleocode/core/internal');
    const db = openDb(getGlobalSignaldockDbPath());
    try {
      for (const name of agents) {
        const row = db.prepare('SELECT tier FROM agents WHERE agent_id = ?').get(name) as
          | { tier: string }
          | undefined;
        expect(row).toBeDefined();
        expect(row?.tier).toBe('project');
      }
    } finally {
      db.close();
    }
  });

  // 4. Mix of canonical + custom agents → all registered
  it('registers all agents including custom (non-template) names', async () => {
    const { _resetGlobalSignaldockDb_TESTING_ONLY } = await import('@cleocode/core/internal');
    _resetGlobalSignaldockDb_TESTING_ONLY();

    const cantDir = join(env.projectRoot, '.cleo', 'cant', 'agents');
    const canonicalAgents = [
      'project-docs-worker',
      'project-test-writer',
      'project-code-reviewer',
      'project-planner',
      'project-summarizer',
    ];
    const customAgent = 'project-data-scientist';

    for (const name of [...canonicalAgents, customAgent]) {
      writeCant(cantDir, `${name}.cant`, makeCant(name));
    }

    const { runMigrateAgentsV2: run } = await import('../migrate-agents-v2.js');
    const summary = await run(env.projectRoot, false);

    expect(summary.registered).toBe(canonicalAgents.length + 1);
    expect(summary.skipped).toBe(0);
    expect(summary.conflicts).toBe(0);
    expect(summary.errors).toBe(0);
  });

  // 5. Conflict detection — same name, different content → conflict logged, not overwritten
  it('detects conflicts when disk content differs from registered sha256 — does not overwrite', async () => {
    const {
      _resetGlobalSignaldockDb_TESTING_ONLY,
      ensureGlobalSignaldockDb,
      getGlobalSignaldockDbPath,
    } = await import('@cleocode/core/internal');
    _resetGlobalSignaldockDb_TESTING_ONLY();
    await ensureGlobalSignaldockDb();

    const cantDir = join(env.projectRoot, '.cleo', 'cant', 'agents');
    const agentName = 'conflict-agent';

    // Write the ORIGINAL .cant and register it.
    const originalCant = makeCant(agentName);
    writeCant(cantDir, `${agentName}.cant`, originalCant);

    const { installAgentFromCant } = await import('@cleocode/core/internal');
    const db = new DatabaseSync(getGlobalSignaldockDbPath());
    db.exec('PRAGMA foreign_keys = ON');
    db.exec('PRAGMA journal_mode = WAL');
    let originalSha256: string;
    try {
      const result = installAgentFromCant(db, {
        cantSource: join(cantDir, `${agentName}.cant`),
        targetTier: 'project',
        installedFrom: 'seed',
        projectRoot: env.projectRoot,
      });
      originalSha256 = result.cantSha256;
    } finally {
      db.close();
    }

    // Now overwrite the .cant on disk with DIFFERENT content (simulates user customisation).
    writeFileSync(join(cantDir, `${agentName}.cant`), makeModifiedCant(agentName), 'utf8');

    _resetGlobalSignaldockDb_TESTING_ONLY();
    const { runMigrateAgentsV2: run } = await import('../migrate-agents-v2.js');
    const summary = await run(env.projectRoot, false);

    // Walker should detect conflict and NOT overwrite.
    expect(summary.registered).toBe(0);
    expect(summary.skipped).toBe(0);
    expect(summary.conflicts).toBe(1);
    expect(summary.errors).toBe(0);

    // DB row should still have the original sha256.
    const { getGlobalSignaldockDbPath: dbPath } = await import('@cleocode/core/internal');
    const verifyDb = openDb(dbPath());
    try {
      const row = verifyDb
        .prepare('SELECT cant_sha256 FROM agents WHERE agent_id = ?')
        .get(agentName) as { cant_sha256: string } | undefined;
      expect(row?.cant_sha256).toBe(originalSha256);
    } finally {
      verifyDb.close();
    }

    // Audit log should contain a conflict entry.
    const auditPath = join(env.projectRoot, '.cleo', 'audit', 'migration-agents-v2.jsonl');
    expect(existsSync(auditPath)).toBe(true);
    const lines = readFileSync(auditPath, 'utf8').split('\n').filter(Boolean);
    const conflictEntry = lines
      .map(
        (l) => JSON.parse(l) as { type: string; agentName: string; doctor_diagnostic_id?: string },
      )
      .find((e) => e.type === 'conflict' && e.agentName === agentName);
    expect(conflictEntry).toBeDefined();
    expect(conflictEntry?.doctor_diagnostic_id).toBe('MIGRATE-AGENTS-V2-CONFLICT');
  });

  // 6. Idempotency — re-running on previously-migrated state produces no changes
  it('is idempotent: re-running on a fully-migrated state produces 0 registered / N skipped', async () => {
    const { _resetGlobalSignaldockDb_TESTING_ONLY } = await import('@cleocode/core/internal');
    _resetGlobalSignaldockDb_TESTING_ONLY();

    const cantDir = join(env.projectRoot, '.cleo', 'cant', 'agents');
    const agents = ['idempotent-alpha', 'idempotent-beta', 'idempotent-gamma'];

    for (const name of agents) {
      writeCant(cantDir, `${name}.cant`, makeCant(name));
    }

    // First run — registers all.
    const { runMigrateAgentsV2: run } = await import('../migrate-agents-v2.js');
    const first = await run(env.projectRoot, false);
    expect(first.registered).toBe(agents.length);

    // Second run — all should be skipped.
    _resetGlobalSignaldockDb_TESTING_ONLY();
    const { runMigrateAgentsV2: run2 } = await import('../migrate-agents-v2.js');
    const second = await run2(env.projectRoot, false);
    expect(second.registered).toBe(0);
    expect(second.skipped).toBe(agents.length);
    expect(second.conflicts).toBe(0);
    expect(second.errors).toBe(0);
  });

  // 7. Doctor surfaces conflicts — readMigrationConflicts returns conflict entries
  it('readMigrationConflicts returns conflict entries written by the walker', async () => {
    const {
      _resetGlobalSignaldockDb_TESTING_ONLY,
      ensureGlobalSignaldockDb,
      getGlobalSignaldockDbPath,
    } = await import('@cleocode/core/internal');
    _resetGlobalSignaldockDb_TESTING_ONLY();
    await ensureGlobalSignaldockDb();

    const cantDir = join(env.projectRoot, '.cleo', 'cant', 'agents');
    const agentName = 'doctor-conflict-agent';

    // Register the agent first.
    writeCant(cantDir, `${agentName}.cant`, makeCant(agentName));
    const { installAgentFromCant } = await import('@cleocode/core/internal');
    const db = new DatabaseSync(getGlobalSignaldockDbPath());
    db.exec('PRAGMA foreign_keys = ON');
    db.exec('PRAGMA journal_mode = WAL');
    try {
      installAgentFromCant(db, {
        cantSource: join(cantDir, `${agentName}.cant`),
        targetTier: 'project',
        installedFrom: 'seed',
        projectRoot: env.projectRoot,
      });
    } finally {
      db.close();
    }

    // Overwrite the .cant with different content to trigger conflict.
    writeFileSync(join(cantDir, `${agentName}.cant`), makeModifiedCant(agentName), 'utf8');

    _resetGlobalSignaldockDb_TESTING_ONLY();
    const { runMigrateAgentsV2: run } = await import('../migrate-agents-v2.js');
    await run(env.projectRoot, false);

    // readMigrationConflicts should now return the planted conflict.
    const { readMigrationConflicts: readConflicts } = await import('../migrate-agents-v2.js');
    const conflicts = readConflicts(env.projectRoot);

    expect(conflicts.length).toBeGreaterThan(0);
    const match = conflicts.find((c) => c.agentName === agentName);
    expect(match).toBeDefined();
    expect(match?.type).toBe('conflict');
    expect(match?.doctor_diagnostic_id).toBe('MIGRATE-AGENTS-V2-CONFLICT');
    expect(match?.existingSha256).toBeDefined();
    expect(match?.newSha256).toBeDefined();
    expect(match?.existingSha256).not.toBe(match?.newSha256);
  });
});

// ---------------------------------------------------------------------------
// Unit tests for extractAgentName helper
// ---------------------------------------------------------------------------

describe('extractAgentName', () => {
  it('returns the agent name from a valid .cant manifest', () => {
    expect(extractAgentName(makeCant('my-worker'))).toBe('my-worker');
  });

  it('strips frontmatter before scanning', () => {
    const withFm = `---
kind: agent
version: 1
---

agent stripped-name:
  role: worker
`;
    expect(extractAgentName(withFm)).toBe('stripped-name');
  });

  it('returns null when no agent declaration is present', () => {
    expect(extractAgentName('this is not a cant file')).toBeNull();
  });

  it('returns null for an empty string', () => {
    expect(extractAgentName('')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Unit tests for walkAgentsDir with mocked DB
// ---------------------------------------------------------------------------

describe('walkAgentsDir — filesystem integration', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'cleo-walk-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('does nothing when the directory does not exist', () => {
    const missingDir = join(tmpDir, 'no-such-dir');
    const summary: MigrationSummary = { registered: 0, skipped: 0, conflicts: 0, errors: 0 };
    // We need a stub DB — use a real in-memory SQLite for isolation.
    const db = new DatabaseSync(':memory:');
    db.exec(`CREATE TABLE IF NOT EXISTS agents (
      id TEXT, agent_id TEXT PRIMARY KEY, cant_sha256 TEXT
    )`);
    try {
      walkAgentsDir(db, missingDir, tmpDir, summary, false);
      expect(summary.registered).toBe(0);
      expect(summary.skipped).toBe(0);
      expect(summary.conflicts).toBe(0);
      expect(summary.errors).toBe(0);
    } finally {
      db.close();
    }
  });

  it('increments errors when a .cant file has no agent declaration', () => {
    const cantDir = join(tmpDir, 'agents');
    mkdirSync(cantDir, { recursive: true });
    writeFileSync(join(cantDir, 'bad-file.cant'), 'not a valid manifest', 'utf8');

    const summary: MigrationSummary = { registered: 0, skipped: 0, conflicts: 0, errors: 0 };
    const db = new DatabaseSync(':memory:');
    db.exec(`CREATE TABLE IF NOT EXISTS agents (
      id TEXT, agent_id TEXT PRIMARY KEY, cant_sha256 TEXT
    )`);
    try {
      walkAgentsDir(db, cantDir, tmpDir, summary, false);
      expect(summary.errors).toBe(1);
    } finally {
      db.close();
    }
  });
});
