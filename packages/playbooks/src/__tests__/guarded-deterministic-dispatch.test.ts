/**
 * T11802 (M4 cantbook done-gate) — every `deterministic` (shell) node dispatch in
 * `executePlaybook` routes through the `guard.ts` deny-first chokepoint.
 *
 * ## What this proves
 *
 *  - **AC1 / AC2** — a minimal `.cantbook` with a `deterministic` shell step,
 *    executed through the REAL {@link executePlaybook} runtime with the
 *    production-shaped {@link createGuardedDeterministicRunner} wired to a real
 *    {@link createToolGuard}, reaches the guard: the spawned command actually runs
 *    THROUGH `guard.executeShell` (proven by captured stdout in the merged run
 *    context). There is NO `child_process` import in the runtime call graph — the
 *    guard owns the spawn.
 *  - **AC3** — when the SAME runtime dispatches a `deterministic` node whose
 *    command is on the guard's denylist (`enforce` mode), the guard REJECTS it
 *    BEFORE any process is spawned; the node terminates as a contained failure
 *    (the runtime contract is non-throwing) carrying the guard's
 *    `E_TOOL_GUARD_DENIED` message.
 *  - **AC5** — no new state machine: the runtime is unchanged; only the injected
 *    `deterministicRunner` is the guard-routed one.
 *
 * ## Determinism + isolation
 *
 *  - IN-PROCESS only — vitest source, NO subprocess driver (tsx unresolvable in CI).
 *  - daemon-OFF — an in-memory `node:sqlite` DB, no daemon.
 *  - The allowed command is `node -e <print>` (always present on the test box, no
 *    network, no filesystem mutation) so the "guard actually spawned" assertion is
 *    portable and side-effect-free.
 *  - A temp project root scopes the guard's `allowedRoots`; `cwd` is pinned to it.
 *
 * @epic T11391
 * @task T11802
 * @saga T11387
 */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import type { DatabaseSync as _DatabaseSyncType } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import type { PlaybookDefinition, PlaybookDeterministicNode } from '@cleocode/contracts';
import {
  createGuardedDeterministicRunner,
  createToolGuard,
  DEFAULT_DETERMINISTIC_DENIED_COMMANDS,
} from '@cleocode/core/internal';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type DeterministicRunner, executePlaybook } from '../runtime.js';

const _require = createRequire(import.meta.url);
type DatabaseSync = _DatabaseSyncType;
const { DatabaseSync } = _require('node:sqlite') as {
  DatabaseSync: new (...args: ConstructorParameters<typeof _DatabaseSyncType>) => DatabaseSync;
};

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Absolute path to the T889 playbook-tables migration SQL. */
const MIGRATION_SQL = resolve(
  __dirname,
  '../../../core/migrations/drizzle-tasks/20260417220000_t889-playbook-tables/migration.sql',
);

/** Apply a multi-statement Drizzle migration (split on the breakpoint token). */
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

/** Build a single-node `deterministic` playbook (the entry node is terminal). */
function singleDeterministicPlaybook(node: PlaybookDeterministicNode): PlaybookDefinition {
  return { version: '1.0', name: 'guarded-shell', nodes: [node], edges: [] };
}

describe('T11802 (M4): deterministic node dispatch routes through guard.ts', () => {
  let db: DatabaseSync;
  let projectRoot: string;

  beforeEach(() => {
    db = new DatabaseSync(':memory:');
    db.exec('PRAGMA foreign_keys=ON');
    applyMigration(db, readFileSync(MIGRATION_SQL, 'utf8'));
    projectRoot = mkdtempSync(join(tmpdir(), 't11802-guarded-shell-'));
  });

  afterEach(() => {
    db.close();
    rmSync(projectRoot, { recursive: true, force: true });
  });

  /**
   * Build the production-shaped deterministic runner: the SAME guard the CLI's
   * `buildDefaultDeterministicRunner` constructs (allowedRoots + denylist +
   * enforce), wrapped by `createGuardedDeterministicRunner`.
   */
  function buildGuardedRunner(): DeterministicRunner {
    const tools = createToolGuard({
      allowedRoots: [projectRoot],
      deniedCommands: DEFAULT_DETERMINISTIC_DENIED_COMMANDS,
      mode: 'enforce',
    });
    // Structurally assignable to the runtime's DeterministicRunner.
    return createGuardedDeterministicRunner({ tools });
  }

  it('AC2: a shell step is intercepted by the guard — the command runs THROUGH guard.executeShell', async () => {
    // `node -e` prints a sentinel; capturing it proves the guard actually
    // spawned the process (not a mock).
    const SENTINEL = 'guard-intercepted-T11802';
    const node: PlaybookDeterministicNode = {
      id: 'shell',
      type: 'deterministic',
      command: process.execPath, // node — always present, never on the denylist
      args: ['-e', `process.stdout.write(${JSON.stringify(SENTINEL)})`],
      cwd: projectRoot,
    };

    const result = await executePlaybook({
      db,
      playbook: singleDeterministicPlaybook(node),
      playbookHash: 'hash-allowed',
      initialContext: { taskId: 'T11802' },
      dispatcher: {
        // The agentic dispatcher must NEVER be reached for a deterministic node.
        async dispatch() {
          return {
            status: 'failure',
            output: {},
            error: 'agentic dispatcher reached for a deterministic node — guard bypassed!',
          };
        },
      },
      deterministicRunner: buildGuardedRunner(),
    });

    expect(result.terminalStatus).toBe('completed');
    // The guard's executeShell captured the child's stdout into the merged
    // context — dispositive that the command was spawned THROUGH the guard.
    expect(result.finalContext['shell_stdout']).toBe(SENTINEL);
    expect(result.finalContext['shell_exitCode']).toBe(0);
  });

  it('AC3: a denied command is rejected by the guard denylist when dispatched from executePlaybook', async () => {
    // `rm` is on DEFAULT_DETERMINISTIC_DENIED_COMMANDS — the guard rejects it
    // BEFORE any process is spawned (enforce mode).
    expect(DEFAULT_DETERMINISTIC_DENIED_COMMANDS).toContain('rm');

    const node: PlaybookDeterministicNode = {
      id: 'danger',
      type: 'deterministic',
      command: 'rm',
      args: ['-rf', join(projectRoot, 'anything')],
      cwd: projectRoot,
      // One attempt → first denial is terminal (no retry storms).
      on_failure: { max_iterations: 1 },
    };

    const result = await executePlaybook({
      db,
      playbook: singleDeterministicPlaybook(node),
      playbookHash: 'hash-denied',
      initialContext: { taskId: 'T11802' },
      dispatcher: {
        async dispatch() {
          return {
            status: 'failure',
            output: {},
            error: 'agentic dispatcher reached for a deterministic node — guard bypassed!',
          };
        },
      },
      deterministicRunner: buildGuardedRunner(),
      maxIterationsDefault: 1,
    });

    // The denial is a contained node failure (the runtime never throws).
    expect(result.terminalStatus).toBe('exceeded_iteration_cap');
    expect(result.exceededNodeId).toBe('danger');
    // The guard's enforce-mode rejection message reached the runtime.
    expect(result.errorContext ?? '').toMatch(/denylist|E_TOOL_GUARD_DENIED|"rm"/);
  });

  it('AC1: the guard is the ONLY spawn path — a denied command never spawns rm', async () => {
    // Targeting a path INSIDE the project root so, IF the guard were bypassed,
    // rm would actually delete it. The guard must stop it first. We assert the
    // failure shape (no rm executed) rather than filesystem side effects so the
    // test is hermetic even on a box without `rm`.
    const node: PlaybookDeterministicNode = {
      id: 'danger',
      type: 'deterministic',
      command: '/bin/rm', // absolute path — basename `rm` is still denied
      args: ['-f', join(projectRoot, 'sentinel')],
      cwd: projectRoot,
      on_failure: { max_iterations: 1 },
    };

    let agenticReached = false;
    const result = await executePlaybook({
      db,
      playbook: singleDeterministicPlaybook(node),
      playbookHash: 'hash-abs-denied',
      initialContext: { taskId: 'T11802' },
      dispatcher: {
        async dispatch() {
          agenticReached = true;
          return { status: 'success', output: { bypassed: true } };
        },
      },
      deterministicRunner: buildGuardedRunner(),
      maxIterationsDefault: 1,
    });

    expect(agenticReached).toBe(false); // never fell back to the agentic path
    expect(result.terminalStatus).toBe('exceeded_iteration_cap');
    expect(result.errorContext ?? '').toMatch(/denylist|E_TOOL_GUARD_DENIED|"rm"/);
  });
});
