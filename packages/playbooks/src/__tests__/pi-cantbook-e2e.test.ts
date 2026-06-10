/**
 * T11945 (M4) — deterministic in-process e2e: a skill-only `.cantbook` executes
 * THROUGH the PiAgentAdapter when the Pi runner is wired into the production
 * dispatcher.
 *
 * ## What this proves (the M4 keystone)
 *
 * The two production cantbook dispatchers (`buildDefaultDispatcher` in
 * `packages/cleo/src/dispatch/domains/playbook.ts` and `buildGoDispatcher` in
 * `packages/cleo/src/cli/commands/go-ivtr-runner.ts`) now pass
 * `runner: await maybeCreatePiRunner({ system, projectRoot })` into
 * {@link runSkillNodeOrSpawn}. This test reconstructs that EXACT production
 * dispatcher shape (`createToolGuard` + `runSkillNodeOrSpawn` + the
 * `maybeCreatePiRunner` wiring helper) and drives a single skill-only node
 * through the real {@link executePlaybook} runtime state machine.
 *
 * With `CLEO_PI_RUNNER_ENABLED=1` the in-process skill node routes THROUGH the
 * PiAgentAdapter. There is no working LLM backend on this box, so we do NOT
 * assert a live round-trip — we assert the DISPATCH PATH reached the Pi adapter,
 * proven by the **cleo-owned no-credential failure string**
 * (`no credential resolved for system "task-executor"`) emitted by the Cleo
 * streamFn (`createPiStreamFn`, the E9 chokepoint). A pi-ai-internal failure
 * shape would not carry that exact cleo string. The Pi adapter NEVER throws —
 * it returns a contained `{ status: 'failure' }` (pi-agent-adapter.test.ts:197
 * precedent), so the run terminates cleanly.
 *
 * ## Determinism + isolation contract (AC3 · AC4)
 *
 *  - IN-PROCESS only — vitest source, NO subprocess (tsx unresolvable in CI).
 *  - daemon-OFF — the runtime is the in-memory `node:sqlite` DB, no daemon.
 *  - `CLEO_SESSION_ID` is stamped so the Pi runner's ZERO-authority guard passes
 *    (production relies on the daemon stamping it; here the test stamps it).
 *  - A real `ct-*` skill is materialised under a temp project root's
 *    `.agents/skills/` dir so `findSkill` resolves it and the in-process skill
 *    path (not subprocess spawn) is taken. `CLEO_PROJECT_ROOT` pins resolution
 *    to that temp dir.
 *  - `maxIterationsDefault: 1` so the failing node runs exactly once → the run
 *    terminates as `exceeded_iteration_cap` with the Pi error in `errorContext`.
 *
 * @epic T10403
 * @task T11761
 * @task T11945
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import type { DatabaseSync as _DatabaseSyncType } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import {
  type AgentDispatcher,
  type AgentDispatchInput,
  type AgentDispatchResult,
  createToolGuard,
  maybeCreatePiRunner,
  runSkillNodeOrSpawn,
} from '@cleocode/core/internal';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parsePlaybook } from '../parser.js';
import { executePlaybook } from '../runtime.js';
import { getPlaybookRun } from '../state.js';

const _require = createRequire(import.meta.url);
type DatabaseSync = _DatabaseSyncType;
const { DatabaseSync } = _require('node:sqlite') as {
  DatabaseSync: new (...args: ConstructorParameters<typeof _DatabaseSyncType>) => DatabaseSync;
};

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Absolute path to the T889 playbook-tables migration SQL. */
const MIGRATION_SQL_PATH = resolve(
  __dirname,
  '../../../core/migrations/drizzle-tasks/20260417220000_t889-playbook-tables/migration.sql',
);

/** The skill-only fixture cantbook materialised for this suite. */
const FIXTURE_PATH = resolve(__dirname, 'fixtures/pi-skill-only.cantbook');

/**
 * Cleo-owned Pi failure markers that ONLY appear when a dispatch reached the
 * PiAgentAdapter → Cleo streamFn (E9 chokepoint). A `defaultSkillRunner` would
 * have SUCCEEDED (it does no LLM work), so seeing any of these proves the Pi
 * route was taken:
 *  - `no credential resolved for system` — the Cleo streamFn's no-credential
 *    terminal error (`createPiStreamFn`), when NO key is reachable.
 *  - `Pi loop failed:` — the Cleo `wrapPiCall` containment prefix
 *    (`pi-errors.ts`), when a credential DID resolve and the real LLM transport
 *    failed (e.g. an expired `sk-ant-oat` token → 401). Either way the call went
 *    through the Pi adapter, never `defaultSkillRunner`.
 *
 * Mirrors the `pi-agent-adapter.test.ts:197` precedent
 * (`/no credential resolved for system|pi loop error|error/i`).
 */
const PI_DISPATCH_MARKERS = /no credential resolved for system|Pi loop failed:/i;

/**
 * Apply a multi-statement Drizzle migration file (split on the
 * `--> statement-breakpoint` token). Mirrors starter.e2e.test.ts.
 */
function applyMigration(db: DatabaseSync, sql: string): void {
  const statements = sql
    .split(/--> statement-breakpoint/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  for (const stmt of statements) {
    const lines = stmt.split('\n');
    const hasSql = lines.some((l) => l.trim().length > 0 && !l.trim().startsWith('--'));
    if (hasSql) db.exec(stmt);
  }
}

/**
 * Materialise a real `ct-task-executor` skill under `<projectRoot>/.agents/skills/`
 * so {@link runSkillNodeOrSpawn}'s `findSkill(agentId, projectRoot)` resolves it
 * via the `project-custom` search scope, taking the in-process skill path.
 */
function writeFixtureSkill(projectRoot: string): void {
  const skillDir = join(projectRoot, '.agents', 'skills', 'ct-task-executor');
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(
    join(skillDir, 'SKILL.md'),
    [
      '---',
      'name: ct-task-executor',
      'description: T11945 e2e fixture skill — drives the in-process Pi dispatch path.',
      '---',
      '',
      'Execute the assigned task.',
      '',
    ].join('\n'),
    'utf8',
  );
}

/**
 * Build the EXACT production dispatcher shape from `buildDefaultDispatcher`:
 * in-process `ct-*` skill nodes run over a deny-first guarded tool surface via
 * {@link runSkillNodeOrSpawn} with the Pi runner injected; isolation/agent nodes
 * fall back to the (here-unused) subprocess spawn. The `runner` is obtained from
 * the M4 wiring helper {@link maybeCreatePiRunner}, exactly as production does.
 */
async function buildProductionShapedDispatcher(projectRoot: string): Promise<AgentDispatcher> {
  const tools = createToolGuard({ allowedRoots: [projectRoot] });
  // The M4 keystone wiring under test — with CLEO_PI_RUNNER_ENABLED=1 this is
  // the Pi `SkillRunner`; with the flag unset it is `undefined`.
  const runner = await maybeCreatePiRunner({ system: 'task-executor', projectRoot });

  /** Subprocess fallback — never exercised by the skill-only fixture. */
  const spawn = async (input: AgentDispatchInput): Promise<AgentDispatchResult> => ({
    status: 'failure',
    output: {},
    error: `unexpected subprocess spawn for ${input.agentId}`,
  });

  return {
    async dispatch(input: AgentDispatchInput): Promise<AgentDispatchResult> {
      return runSkillNodeOrSpawn(
        { nodeId: input.nodeId, agentId: input.agentId, context: input.context },
        {
          tools,
          cwd: projectRoot,
          subprocessSpawn: () => spawn(input),
          ...(runner !== undefined ? { runner } : {}),
        },
      );
    },
  };
}

// ---------------------------------------------------------------------------

describe('T11945 (M4): skill-only .cantbook routes through the PiAgentAdapter', () => {
  let db: DatabaseSync;
  let projectRoot: string;

  const SAVED = {
    session: process.env['CLEO_SESSION_ID'],
    flag: process.env['CLEO_PI_RUNNER_ENABLED'],
    projectRoot: process.env['CLEO_PROJECT_ROOT'],
    cleoRoot: process.env['CLEO_ROOT'],
    anthropic: process.env['ANTHROPIC_API_KEY'],
    anthropicOauth: process.env['ANTHROPIC_OAUTH_TOKEN'],
  };

  beforeEach(() => {
    db = new DatabaseSync(':memory:');
    db.exec('PRAGMA foreign_keys=ON');
    applyMigration(db, readFileSync(MIGRATION_SQL_PATH, 'utf8'));

    projectRoot = mkdtempSync(join(tmpdir(), 't11945-pi-e2e-'));
    writeFixtureSkill(projectRoot);

    // Pin skill + project resolution to the temp root (getProjectRoot honours
    // CLEO_ROOT / CLEO_PROJECT_ROOT before any walk).
    process.env['CLEO_PROJECT_ROOT'] = projectRoot;
    process.env['CLEO_ROOT'] = projectRoot;
    // Daemon-stamped identity — the Pi runner fails closed without it (ZERO authority).
    process.env['CLEO_SESSION_ID'] = 'sess-t11945-e2e';
    // No credential reachable → deterministic cleo-owned no-credential failure.
    delete process.env['ANTHROPIC_API_KEY'];
    delete process.env['ANTHROPIC_OAUTH_TOKEN'];
  });

  afterEach(() => {
    db.close();
    rmSync(projectRoot, { recursive: true, force: true });
    restoreEnv('CLEO_SESSION_ID', SAVED.session);
    restoreEnv('CLEO_PI_RUNNER_ENABLED', SAVED.flag);
    restoreEnv('CLEO_PROJECT_ROOT', SAVED.projectRoot);
    restoreEnv('CLEO_ROOT', SAVED.cleoRoot);
    restoreEnv('ANTHROPIC_API_KEY', SAVED.anthropic);
    restoreEnv('ANTHROPIC_OAUTH_TOKEN', SAVED.anthropicOauth);
  });

  it('routes the in-process skill node THROUGH the Pi adapter (proven by the cleo no-credential failure)', async () => {
    process.env['CLEO_PI_RUNNER_ENABLED'] = '1';

    const { definition, sourceHash } = parsePlaybook(readFileSync(FIXTURE_PATH, 'utf8'));
    expect(definition.name).toBe('pi-skill-only');
    expect(definition.nodes).toHaveLength(1);

    const dispatcher = await buildProductionShapedDispatcher(projectRoot);

    const result = await executePlaybook({
      db,
      playbook: definition,
      playbookHash: sourceHash,
      initialContext: { taskId: 'T11945' },
      dispatcher,
      projectRoot,
      // One attempt → the node fails once (no credential) and terminates.
      maxIterationsDefault: 1,
    });

    // The Pi loop never throws — the run reaches a clean terminal state with the
    // node failure recorded (not an uncaught exception).
    expect(result.terminalStatus).toBe('exceeded_iteration_cap');
    expect(result.exceededNodeId).toBe('execute');

    // THE PROOF: the failure carries a cleo-owned Pi marker (streamFn
    // no-credential error OR the wrapPiCall containment prefix). These ONLY
    // appear when the dispatch reached the PiAgentAdapter → Cleo streamFn (the
    // E9 chokepoint). A `defaultSkillRunner` would have SUCCEEDED (it does no LLM
    // work, terminalStatus 'completed'), so an `exceeded_iteration_cap` carrying
    // this marker is dispositive that the Pi route ran.
    const errorContext = result.errorContext ?? '';
    expect(errorContext).toMatch(PI_DISPATCH_MARKERS);

    const run = getPlaybookRun(db, result.runId);
    expect(run?.status).toBe('failed');
  });

  it('with CLEO_PI_RUNNER_ENABLED unset the node stays on defaultSkillRunner (zero behaviour change)', async () => {
    // Flag deliberately NOT set → maybeCreatePiRunner returns undefined →
    // runSkillNodeOrSpawn uses defaultSkillRunner, which resolves the skill and
    // returns success WITHOUT any LLM work. The run completes; no Pi string.
    delete process.env['CLEO_PI_RUNNER_ENABLED'];

    const { definition, sourceHash } = parsePlaybook(readFileSync(FIXTURE_PATH, 'utf8'));
    const dispatcher = await buildProductionShapedDispatcher(projectRoot);

    const result = await executePlaybook({
      db,
      playbook: definition,
      playbookHash: sourceHash,
      initialContext: { taskId: 'T11945' },
      dispatcher,
      projectRoot,
      maxIterationsDefault: 1,
    });

    expect(result.terminalStatus).toBe('completed');
    // defaultSkillRunner echoes resolution metadata — never a Pi failure marker.
    expect(result.errorContext ?? '').not.toMatch(PI_DISPATCH_MARKERS);
    expect(result.finalContext).toMatchObject({ skillId: 'ct-task-executor', resolved: true });
  });

  it('maybeCreatePiRunner is default-OFF: undefined unless CLEO_PI_RUNNER_ENABLED=1', async () => {
    delete process.env['CLEO_PI_RUNNER_ENABLED'];
    expect(await maybeCreatePiRunner({ system: 'task-executor', projectRoot })).toBeUndefined();

    process.env['CLEO_PI_RUNNER_ENABLED'] = '1';
    const runner = await maybeCreatePiRunner({ system: 'task-executor', projectRoot });
    expect(typeof runner).toBe('function');
  });
});

/** Restore an env var to its saved value (delete when it was unset). */
function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}
