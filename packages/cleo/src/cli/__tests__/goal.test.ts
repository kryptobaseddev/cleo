/**
 * End-to-end CLI integration tests for `cleo goal` (T11381).
 *
 * Spawns the compiled `cleo` CLI as a subprocess against an isolated tmp
 * project per test so the LAFS envelope, per-agent scoping, and on-disk
 * persistence are validated against the same surface external agents see.
 *
 * Coverage:
 *  - Subcommand registration: `cleo goal` exposes set/status/subgoal/append.
 *  - set → append → status round-trip (append persists; status reflects it).
 *  - subgoal links parentGoalId to the active goal.
 *  - status empty-state envelope ({ active: null }) when no goal exists.
 *  - per-agent isolation: two CLEO_SESSION_ID/CLEO_AGENT_ID identities never
 *    see each other's goal.
 *
 * @epic T11290
 * @task T11381
 * @saga T11283
 */

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { goalCommand } from '../commands/goal.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/** Absolute path to `packages/cleo/` root. */
const PKG_ROOT = resolve(__dirname, '..', '..', '..');

/** Path to the compiled CLI entry point. */
const CLI_DIST = resolve(PKG_ROOT, 'dist', 'cli', 'index.js');

/** True when the compiled CLI dist bundle exists and can be spawned. */
const CLI_DIST_AVAILABLE = existsSync(CLI_DIST);

interface CliResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly status: number | null;
}

/**
 * Run `node dist/cli/index.js <args>` against an isolated tmp project root,
 * with an injectable per-agent identity (CLEO_SESSION_ID / CLEO_AGENT_ID).
 */
function runCli(
  args: readonly string[],
  projectRoot: string,
  identity?: { sessionId: string; agentId: string },
): CliResult {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    CLEO_PROJECT_ROOT: projectRoot,
    CLEO_ROOT: projectRoot,
    CLEO_DIR: join(projectRoot, '.cleo'),
    CLEO_OUTPUT_FORMAT: 'json',
  };
  if (identity) {
    env.CLEO_SESSION_ID = identity.sessionId;
    env.CLEO_AGENT_ID = identity.agentId;
  }
  const result = spawnSync('node', [CLI_DIST, ...args], {
    stdio: ['pipe', 'pipe', 'pipe'],
    encoding: 'utf-8',
    timeout: 90_000,
    cwd: projectRoot,
    env,
  });
  return {
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    status: result.status,
  };
}

interface LafsEnvelope<TData = unknown> {
  readonly success: boolean;
  readonly data?: TData;
  readonly error?: { readonly codeName?: string; readonly message?: string };
}

/** Extract the JSON LAFS envelope from a CLI invocation's stdout. */
function parseEnvelope<T = unknown>(stdout: string): LafsEnvelope<T> {
  const lines = stdout.split('\n').filter((l) => l.trim().length > 0);
  for (const line of lines) {
    if (!line.trim().startsWith('{')) continue;
    try {
      return JSON.parse(line) as LafsEnvelope<T>;
    } catch {
      /* keep scanning */
    }
  }
  throw new Error(`parseEnvelope: no JSON envelope on stdout. Got:\n${stdout.slice(0, 2000)}`);
}

interface GoalData {
  readonly id: string;
  readonly intent: string;
  readonly criteria: string[];
  readonly status: string;
  readonly parentGoalId: string | null;
  readonly goalKind: { kind: string; targetTaskId?: string };
}

const AGENT_A = { sessionId: 'ses_20260530000000_aaa111', agentId: 'agent-A' };
const AGENT_B = { sessionId: 'ses_20260530000000_bbb222', agentId: 'agent-B' };

let projectRoot: string;

beforeEach(async () => {
  projectRoot = await mkdtemp(join(tmpdir(), 'cleo-T11381-cli-'));
  // Initialize the project so tasks.db exists and migrations run.
  if (CLI_DIST_AVAILABLE) runCli(['init'], projectRoot);
});

afterEach(async () => {
  await rm(projectRoot, { recursive: true, force: true }).catch(() => {
    /* never fail teardown */
  });
});

// ─── Subcommand registration (no spawn) ──────────────────────────────────────

interface CittyCommand {
  meta?: unknown;
  subCommands?: Record<string, CittyCommand>;
}

describe('cleo goal — subcommand registration', () => {
  it('exposes set, status, subgoal, and append', () => {
    const cmd = goalCommand as unknown as CittyCommand;
    expect(cmd.subCommands).toBeDefined();
    expect(Object.keys(cmd.subCommands ?? {}).sort()).toEqual([
      'append',
      'set',
      'status',
      'subgoal',
    ]);
  });
});

// ─── End-to-end (requires compiled dist) ─────────────────────────────────────

describe.runIf(CLI_DIST_AVAILABLE)('cleo goal — end-to-end', () => {
  it('status returns a clean empty-state envelope when no goal exists', () => {
    const res = runCli(['goal', 'status'], projectRoot, AGENT_A);
    const env = parseEnvelope<{ active: null }>(res.stdout);
    expect(env.success).toBe(true);
    expect(env.data).toEqual({ active: null });
  });

  it('set → append → status round-trip', () => {
    const setRes = runCli(['goal', 'set', 'explore auth', '--turns', '5'], projectRoot, AGENT_A);
    const setEnv = parseEnvelope<GoalData>(setRes.stdout);
    expect(setEnv.success).toBe(true);
    expect(setEnv.data?.intent).toBe('explore auth');
    expect(setEnv.data?.status).toBe('active');

    const appendRes = runCli(['goal', 'append', 'list the risks'], projectRoot, AGENT_A);
    const appendEnv = parseEnvelope<GoalData>(appendRes.stdout);
    expect(appendEnv.success).toBe(true);
    expect(appendEnv.data?.criteria).toEqual(['list the risks']);

    const statusRes = runCli(['goal', 'status'], projectRoot, AGENT_A);
    const statusEnv = parseEnvelope<GoalData>(statusRes.stdout);
    expect(statusEnv.data?.intent).toBe('explore auth');
    expect(statusEnv.data?.criteria).toEqual(['list the risks']);
  });

  it('subgoal links parentGoalId to the active goal', () => {
    const parentRes = runCli(['goal', 'set', 'parent goal'], projectRoot, AGENT_A);
    const parentEnv = parseEnvelope<GoalData>(parentRes.stdout);
    const parentId = parentEnv.data?.id;
    expect(parentId).toBeTruthy();

    const subRes = runCli(
      ['goal', 'subgoal', 'child goal', '--task', 'T123'],
      projectRoot,
      AGENT_A,
    );
    const subEnv = parseEnvelope<GoalData>(subRes.stdout);
    expect(subEnv.success).toBe(true);
    expect(subEnv.data?.parentGoalId).toBe(parentId);
    // --task makes it an evidence-judged task-completion goal.
    expect(subEnv.data?.goalKind.kind).toBe('task-completion');
    expect(subEnv.data?.goalKind.targetTaskId).toBe('T123');
  });

  it('set with an invalid --task is rejected', () => {
    const res = runCli(['goal', 'set', 'g', '--task', 'not-a-task'], projectRoot, AGENT_A);
    const env = parseEnvelope(res.stdout);
    expect(env.success).toBe(false);
    expect(env.error?.codeName).toBe('E_VALIDATION');
  });

  it("two agents never see each other's goal (per-agent isolation)", () => {
    runCli(['goal', 'set', 'goal-A'], projectRoot, AGENT_A);
    runCli(['goal', 'set', 'goal-B'], projectRoot, AGENT_B);

    const aStatus = parseEnvelope<GoalData>(
      runCli(['goal', 'status'], projectRoot, AGENT_A).stdout,
    );
    const bStatus = parseEnvelope<GoalData>(
      runCli(['goal', 'status'], projectRoot, AGENT_B).stdout,
    );

    expect(aStatus.data?.intent).toBe('goal-A');
    expect(bStatus.data?.intent).toBe('goal-B');
  });
});
