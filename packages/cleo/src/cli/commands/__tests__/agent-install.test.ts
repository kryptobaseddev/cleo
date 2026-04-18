/**
 * End-to-end unit tests for T889 / W2-6: `cleo agent install` CLI verb.
 *
 * These tests drive the real citty subcommand handler (`installCommand.run`)
 * against:
 * - a real node:sqlite `signaldock.db` created under a per-test tmp CLEO_HOME,
 * - real `.cant` manifests on disk (seed fixtures + in-process fixtures),
 * - a real project-root tmp dir whose `.cleo/conduit.db` is created on demand
 *   by {@link attachAgentToProject}.
 *
 * The ONLY substitution is `paths.ts` (`getCleoHome` / `getCleoGlobalAgentsDir`)
 * via `vi.doMock` so that the install pipeline points at the tmp workspace
 * instead of the developer's real `~/.local/share/cleo`. No `@cleocode/*`
 * module logic is mocked; no sqlite or fs module is mocked. This mirrors the
 * real-sqlite pattern established by the W2-3 pipeline test at
 * `packages/core/src/store/__tests__/agent-install.test.ts`.
 *
 * Coverage (matches the 8 behaviors of the previous mock-heavy rewrite):
 * 1. project tier default — row tier='project', cantPath under projectRoot/.cleo
 * 2. `--global` — row tier='global', cantPath under the tmp CLEO_HOME
 * 3. `--force` — second install succeeds, inserted=false
 * 4. no-`--force` duplicate — emits E_AGENT_ALREADY_INSTALLED, exitCode=1
 * 5. `--strict` + warnings — emits E_VALIDATION, exitCode=6
 * 6. `--attach` + `--global` — writes to project_agent_refs via real conduit.db
 * 7. missing path — emits E_NOT_FOUND, exitCode=4
 * 8. wrong file extension — emits E_VALIDATION, exitCode=6
 *
 * @task T889 / W2-6
 * @epic T889
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const __dirname = dirname(fileURLToPath(import.meta.url));
/** Monorepo-relative seed-agent — works locally and in CI. */
const SEED_HISTORIAN_SOURCE = resolve(
  __dirname,
  '../../../../../agents/seed-agents/cleo-historian.cant',
);

/** A valid minimal agent .cant we can copy into any working directory. */
const FIXTURE_MINIMAL_CANT = `---
kind: agent
version: 1
---

agent fixture-cli-agent:
  role: worker
  parent: cleo-prime
  description: "Fixture CLI agent for install tests."
  prompt: "You are the fixture agent."
  skills: []
`;

/** Fixture whose only listed skill is not in the local catalog — triggers warnings. */
const FIXTURE_UNKNOWN_SKILL_CANT = `---
kind: agent
version: 1
---

agent fixture-strict-agent:
  role: worker
  parent: cleo-prime
  description: "Fixture with an unknown skill slug to exercise --strict."
  prompt: "You are the strict-mode fixture."
  skills: ["skill-does-not-exist"]
`;

// ---------------------------------------------------------------------------
// Tmp-environment helper (mirrors the W2-3 pipeline test pattern)
// ---------------------------------------------------------------------------

interface TmpEnv {
  base: string;
  cleoHome: string;
  projectRoot: string;
  sourcesDir: string;
  globalCantDir: string;
  dbPath: string;
  cleanup: () => void;
}

/**
 * Create a fresh per-test workspace, override `paths.ts` to point at it, and
 * run the real signaldock.db migrations. Must be called *before* the first
 * dynamic import of anything under `@cleocode/core` in a given test.
 */
async function makeTmpEnv(suffix: string): Promise<TmpEnv> {
  const base = mkdtempSync(join(tmpdir(), `cleo-w2-6-fix-${suffix}-`));
  const cleoHome = join(base, 'cleo-home');
  const projectRoot = join(base, 'project');
  const globalCantDir = join(cleoHome, 'agents');
  const sourcesDir = join(base, 'sources');
  mkdirSync(cleoHome, { recursive: true });
  mkdirSync(join(projectRoot, '.cleo'), { recursive: true });
  mkdirSync(sourcesDir, { recursive: true });

  // Deterministic machine-key / global-salt so ensureGlobalSignaldockDb() is happy.
  writeFileSync(join(cleoHome, 'machine-key'), Buffer.alloc(32, 0xab), { mode: 0o600 });
  writeFileSync(join(cleoHome, 'global-salt'), Buffer.alloc(32, 0xcd), { mode: 0o600 });

  // Redirect paths.ts — the ONLY module substitution in this suite.
  // `@cleocode/core/internal` is aliased by vitest to `packages/core/src/internal.ts`
  // which re-exports everything from `./store/...` which in turn imports
  // `../paths.js`. Mocking that single module is enough to retarget all
  // downstream `getCleoHome()` / `getCleoGlobalAgentsDir()` calls.
  vi.doMock('../../../../../../packages/core/src/paths.js', async () => {
    const actual = await vi.importActual<typeof import('../../../../../core/src/paths.js')>(
      '../../../../../../packages/core/src/paths.js',
    );
    return {
      ...actual,
      getCleoHome: () => cleoHome,
      getCleoGlobalAgentsDir: () => globalCantDir,
    };
  });

  // Also intercept the alias-resolved path that vitest may use internally
  // (relative module id equivalence: both forms resolve to the same absolute
  // file, vitest tracks each as a separate module id).
  vi.doMock('@cleocode/core/paths', async () => {
    const actual = await vi.importActual<typeof import('../../../../../core/src/paths.js')>(
      '../../../../../../packages/core/src/paths.js',
    );
    return {
      ...actual,
      getCleoHome: () => cleoHome,
      getCleoGlobalAgentsDir: () => globalCantDir,
    };
  });

  // Reset any cached signaldock singleton from a prior test, then migrate
  // both the global signaldock.db and the per-project conduit.db so
  // `--attach` has a real `project_agent_refs` table to write into.
  const { ensureGlobalSignaldockDb, _resetGlobalSignaldockDb_TESTING_ONLY, ensureConduitDb } =
    await import('@cleocode/core/internal');
  _resetGlobalSignaldockDb_TESTING_ONLY();
  await ensureGlobalSignaldockDb();
  ensureConduitDb(projectRoot);

  const dbPath = join(cleoHome, 'signaldock.db');

  // Seed the two skills the .cant fixtures reference so junction-insert
  // has something to match. The historian fixture also references more,
  // but extras are expected to soft-warn — not fail.
  const seedDb = new DatabaseSync(dbPath);
  seedDb.exec('PRAGMA foreign_keys = ON');
  const nowTs = Math.floor(Date.now() / 1000);
  for (const [id, slug, name] of [
    ['skill-ct-cleo', 'ct-cleo', 'CT CLEO'],
    ['skill-ct-validator', 'ct-validator', 'CT Validator'],
    ['skill-ct-documentor', 'ct-documentor', 'CT Documentor'],
    ['skill-ct-docs-review', 'ct-docs-review', 'CT Docs Review'],
  ] as const) {
    seedDb
      .prepare(
        `INSERT OR IGNORE INTO skills (id, slug, name, description, category, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(id, slug, name, `${name} fixture`, 'core', nowTs);
  }
  seedDb.close();

  const cleanup = (): void => {
    _resetGlobalSignaldockDb_TESTING_ONLY();
    rmSync(base, { recursive: true, force: true });
  };

  return { base, cleoHome, projectRoot, sourcesDir, globalCantDir, dbPath, cleanup };
}

/** Write a source `.cant` inside the tmp sources dir and return its path. */
function writeSourceCant(dir: string, filename: string, body: string): string {
  mkdirSync(dir, { recursive: true });
  const p = join(dir, filename);
  writeFileSync(p, body, 'utf8');
  return p;
}

/**
 * Open a direct handle to the tmp signaldock.db so tests can assert on rows
 * without interfering with the handler's own handle (which is closed inside
 * the `finally` block of `installCommand.run`).
 */
function openDb(dbPath: string): DatabaseSync {
  const d = new DatabaseSync(dbPath);
  d.exec('PRAGMA foreign_keys = ON');
  return d;
}

// ---------------------------------------------------------------------------
// Handler-extraction helpers
// ---------------------------------------------------------------------------

type RunContext = { args: Record<string, unknown>; rawArgs: string[] };
type RunFn = (ctx: RunContext) => Promise<void>;

/**
 * Resolve the `install` subcommand's `.run` function from the freshly
 * re-imported `agent.ts` module. Must be invoked AFTER `vi.doMock` is set up
 * so the handler's dynamic `@cleocode/core/internal` import picks up the
 * path override.
 */
async function getInstallRun(): Promise<RunFn> {
  const mod = await import('../agent.js');
  const cmd = mod.agentCommand as { subCommands?: Record<string, { run?: RunFn }> };
  const sub = cmd.subCommands?.install;
  if (!sub?.run) throw new Error('install subcommand has no run function');
  return sub.run;
}

// ---------------------------------------------------------------------------
// Envelope capture — wrap `cliOutput` via real module replacement
// ---------------------------------------------------------------------------

/**
 * Captured `{envelope, meta}` pairs the CLI handler emitted. We intercept
 * `cliOutput` at the module level (not via `vi.mock` against
 * `@cleocode/*`) by redirecting the renderers module to a thin spy wrapper
 * that delegates to the real implementation after recording the call.
 */
interface Captured {
  envelope: Record<string, unknown>;
  meta: Record<string, unknown>;
}
const captured: Captured[] = [];

vi.mock('../../renderers/index.js', async () => {
  const actual = await vi.importActual<typeof import('../../renderers/index.js')>(
    '../../renderers/index.js',
  );
  return {
    ...actual,
    cliOutput: (envelope: unknown, meta: unknown) => {
      captured.push({
        envelope: envelope as Record<string, unknown>,
        meta: (meta ?? {}) as Record<string, unknown>,
      });
      // Do not forward to the real renderer — it writes to stdout/stderr and
      // would pollute vitest's output. Recording the call is all we need.
    },
    cliError: () => {
      // no-op in tests
    },
  };
});

/** Read the single envelope the handler emitted; fail loudly otherwise. */
function latestEnvelope(): Captured {
  if (captured.length === 0) throw new Error('handler did not emit a cliOutput envelope');
  return captured[captured.length - 1] as Captured;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('T889 cleo agent install — real sqlite + real fs', () => {
  let env: TmpEnv;
  let origCwd: string;

  beforeEach(async () => {
    vi.resetModules();
    captured.length = 0;
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

  it('installs a real .cant to project tier by default and emits a LAFS envelope', async () => {
    const cantPath = writeSourceCant(
      env.sourcesDir,
      'fixture-cli-agent.cant',
      FIXTURE_MINIMAL_CANT,
    );
    const run = await getInstallRun();
    await run({ args: { path: cantPath }, rawArgs: [] });

    const { envelope, meta } = latestEnvelope();
    expect(envelope.success).toBe(true);
    const data = envelope.data as {
      agentId: string;
      tier: string;
      cantPath: string;
      cantSha256: string;
      inserted: boolean;
      attached: boolean;
    };
    expect(data.agentId).toBe('fixture-cli-agent');
    expect(data.tier).toBe('project');
    expect(data.inserted).toBe(true);
    expect(data.attached).toBe(false);
    expect(data.cantSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(meta).toMatchObject({ command: 'agent install' });
    expect(process.exitCode).toBeUndefined();

    // Row is on disk — open a fresh DB handle and assert.
    const db = openDb(env.dbPath);
    try {
      const row = db
        .prepare('SELECT tier, cant_path, installed_from FROM agents WHERE agent_id = ?')
        .get('fixture-cli-agent') as
        | { tier: string; cant_path: string; installed_from: string }
        | undefined;
      expect(row).toBeDefined();
      expect(row?.tier).toBe('project');
      expect(row?.installed_from).toBe('user');
      expect(row?.cant_path).toBe(
        join(env.projectRoot, '.cleo', 'cant', 'agents', 'fixture-cli-agent.cant'),
      );
      // Real file was copied to the project-tier destination.
      expect(existsSync(row?.cant_path ?? '')).toBe(true);
      const bytes = readFileSync(row?.cant_path ?? '', 'utf8');
      expect(bytes).toContain('agent fixture-cli-agent');
    } finally {
      db.close();
    }
  });

  it('--global installs under the tmp CLEO_HOME and records tier=global', async () => {
    const run = await getInstallRun();
    await run({ args: { path: SEED_HISTORIAN_SOURCE, global: true }, rawArgs: [] });

    const { envelope } = latestEnvelope();
    expect(envelope.success).toBe(true);
    const data = envelope.data as { agentId: string; tier: string; cantPath: string };
    expect(data.agentId).toBe('cleo-historian');
    expect(data.tier).toBe('global');
    expect(data.cantPath).toBe(join(env.globalCantDir, 'cleo-historian.cant'));

    const db = openDb(env.dbPath);
    try {
      const row = db.prepare('SELECT tier FROM agents WHERE agent_id = ?').get('cleo-historian') as
        | { tier: string }
        | undefined;
      expect(row?.tier).toBe('global');
    } finally {
      db.close();
    }
  });

  it('--force allows overwriting an existing install (inserted=false)', async () => {
    const cantPath = writeSourceCant(
      env.sourcesDir,
      'fixture-cli-agent.cant',
      FIXTURE_MINIMAL_CANT,
    );

    const run = await getInstallRun();
    await run({ args: { path: cantPath, global: true }, rawArgs: [] });
    expect(latestEnvelope().envelope.success).toBe(true);
    captured.length = 0;
    process.exitCode = undefined;

    await run({ args: { path: cantPath, global: true, force: true }, rawArgs: [] });
    const { envelope } = latestEnvelope();
    expect(envelope.success).toBe(true);
    const data = envelope.data as { inserted: boolean };
    expect(data.inserted).toBe(false);
  });

  it('surfaces E_AGENT_ALREADY_INSTALLED when installing twice without --force', async () => {
    const cantPath = writeSourceCant(
      env.sourcesDir,
      'fixture-cli-agent.cant',
      FIXTURE_MINIMAL_CANT,
    );

    const run = await getInstallRun();
    await run({ args: { path: cantPath, global: true }, rawArgs: [] });
    expect(latestEnvelope().envelope.success).toBe(true);
    captured.length = 0;
    process.exitCode = undefined;

    await run({ args: { path: cantPath, global: true }, rawArgs: [] });
    const { envelope } = latestEnvelope();
    expect(envelope.success).toBe(false);
    const err = envelope.error as { code: string };
    expect(err.code).toBe('E_AGENT_ALREADY_INSTALLED');
    expect(process.exitCode).toBe(1);
  });

  it('--strict converts pipeline warnings into E_VALIDATION (exit 6)', async () => {
    const cantPath = writeSourceCant(
      env.sourcesDir,
      'fixture-strict-agent.cant',
      FIXTURE_UNKNOWN_SKILL_CANT,
    );

    const run = await getInstallRun();
    await run({ args: { path: cantPath, global: true, strict: true }, rawArgs: [] });

    const { envelope } = latestEnvelope();
    expect(envelope.success).toBe(false);
    const err = envelope.error as { code: string };
    expect(err.code).toBe('E_VALIDATION');
    expect(process.exitCode).toBe(6);
  });

  it('--attach + --global writes a project_agent_refs row via real conduit.db', async () => {
    const run = await getInstallRun();
    await run({ args: { path: SEED_HISTORIAN_SOURCE, global: true, attach: true }, rawArgs: [] });

    const { envelope } = latestEnvelope();
    expect(envelope.success).toBe(true);
    const data = envelope.data as { attached: boolean; agentId: string };
    expect(data.attached).toBe(true);
    expect(data.agentId).toBe('cleo-historian');

    // Verify the real conduit.db row was written.
    const conduitPath = join(env.projectRoot, '.cleo', 'conduit.db');
    expect(existsSync(conduitPath)).toBe(true);
    const conduitDb = openDb(conduitPath);
    try {
      const refRow = conduitDb
        .prepare('SELECT agent_id, enabled FROM project_agent_refs WHERE agent_id = ?')
        .get('cleo-historian') as { agent_id: string; enabled: number } | undefined;
      expect(refRow?.agent_id).toBe('cleo-historian');
      expect(refRow?.enabled).toBe(1);
    } finally {
      conduitDb.close();
    }
  });

  it('emits E_NOT_FOUND (exit 4) when the source path does not exist', async () => {
    const run = await getInstallRun();
    await run({ args: { path: join(env.base, 'no-such-file.cant') }, rawArgs: [] });

    const { envelope } = latestEnvelope();
    expect(envelope.success).toBe(false);
    const err = envelope.error as { code: string };
    expect(err.code).toBe('E_NOT_FOUND');
    expect(process.exitCode).toBe(4);
  });

  it('rejects a file that is neither .cant, .cantz, nor a directory (E_VALIDATION, exit 6)', async () => {
    const txtPath = join(env.sourcesDir, 'not-a-cant.txt');
    mkdirSync(env.sourcesDir, { recursive: true });
    writeFileSync(txtPath, 'definitely not a manifest', 'utf8');

    const run = await getInstallRun();
    await run({ args: { path: txtPath }, rawArgs: [] });

    const { envelope } = latestEnvelope();
    expect(envelope.success).toBe(false);
    const err = envelope.error as { code: string };
    expect(err.code).toBe('E_VALIDATION');
    expect(process.exitCode).toBe(6);
  });
});
