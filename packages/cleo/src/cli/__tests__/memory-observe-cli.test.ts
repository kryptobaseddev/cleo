/**
 * `cleo memory observe` emits one LAFS envelope and stores the row — with no
 * session bound, with and without `--agent` (T12817).
 *
 * Before the fix, `--agent` with a mental-model type (discovery, the default)
 * routed the write through a queue whose only drain a one-shot process could
 * reach was an unref'd 5 s timer: the CLI exited 0 with ZERO bytes on stdout
 * and nothing stored. `memory recent` also selected a `text` column that
 * `brain_observations` never had and swallowed the error, so it always
 * reported `count: 0`.
 *
 * Runs the BUILT CLI (`packages/cleo/dist/cli/index.js`) in a sandbox project
 * with scratch `HOME`/`CLEO_HOME` and no session binding in the environment.
 * Skipped, with the reason below, when the CLI has not been built.
 *
 * @task T12817
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = resolve(__dirname, '..', '..', '..');
const CLI_DIST = resolve(PKG_ROOT, 'dist', 'cli', 'index.js');
const CLI_DIST_AVAILABLE = existsSync(CLI_DIST);
if (!CLI_DIST_AVAILABLE) {
  process.stderr.write(
    'memory-observe-cli: SKIPPED — packages/cleo/dist is not built (run `pnpm run build`).\n',
  );
}

/** Environment variables that bind a session to the caller (T12499 · T12500). */
const SESSION_BINDING_VARS = ['CLAUDE_CODE_SESSION_ID', 'TMUX_PANE', 'CLAUDECODE'];

let sandbox: string;
let project: string;
let env: NodeJS.ProcessEnv;

/** The caller's environment without any CLEO or session binding, homed in the sandbox. */
function sandboxEnv(home: string): NodeJS.ProcessEnv {
  const clean: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (k.startsWith('CLEO_') || k === 'VITEST' || k.startsWith('VITEST_')) continue;
    if (SESSION_BINDING_VARS.includes(k)) continue;
    clean[k] = v;
  }
  return {
    ...clean,
    HOME: home,
    CLEO_HOME: join(home, '.cleo'),
    XDG_DATA_HOME: join(home, '.local', 'share'),
    XDG_CONFIG_HOME: join(home, '.config'),
    // A fresh sandbox store: migrating it from a local (worktree) build is safe (T12687).
    CLEO_ALLOW_WORKTREE_BUILD_MIGRATIONS: '1',
  };
}

/** Minimal LAFS envelope shape read by this test. */
interface CliEnvelope {
  success: boolean;
  data?: {
    id?: string;
    count?: number;
    observations?: Array<{ id: string; text: string }>;
    results?: Array<{ id: string; data?: { narrative?: string; agent?: string | null } }>;
  };
  error?: { code?: string | number; message?: string };
}

/** Result of one CLI run: exit status plus the raw stdout lines. */
interface CliRun {
  status: number | null;
  lines: string[];
  stderr: string;
}

/** Run the built CLI synchronously in the sandbox project. */
function run(args: string[]): CliRun {
  const r = spawnSync(process.execPath, [CLI_DIST, ...args], {
    cwd: project,
    env,
    encoding: 'utf-8',
    timeout: 60_000,
  });
  const lines = (r.stdout ?? '').split('\n').filter((l) => l.trim().length > 0);
  return { status: r.status, lines, stderr: r.stderr ?? '' };
}

/** Run the CLI and parse its single stdout envelope (ADR-086). */
function envelope(args: string[]): { status: number | null; json: CliEnvelope } {
  const r = run(args);
  expect(r.lines, `cleo ${args.join(' ')} stdout (stderr: ${r.stderr})`).toHaveLength(1);
  return { status: r.status, json: JSON.parse(r.lines[0] ?? '') as CliEnvelope };
}

describe.skipIf(!CLI_DIST_AVAILABLE)('cleo memory observe — no bound session (T12817)', () => {
  beforeAll(() => {
    sandbox = mkdtempSync(join(tmpdir(), 'cleo-t12817-cli-'));
    project = join(sandbox, 'project');
    mkdirSync(project, { recursive: true });
    mkdirSync(join(sandbox, 'home'), { recursive: true });
    env = sandboxEnv(join(sandbox, 'home'));
    spawnSync('git', ['init', '-q', '.'], { cwd: project });
    const init = envelope(['init', '--quiet']);
    if (!init.json.success) throw new Error(`init failed: ${JSON.stringify(init.json)}`);
  }, 120_000);

  afterAll(() => {
    if (sandbox) rmSync(sandbox, { recursive: true, force: true });
  });

  it.each([
    ['with --agent (mental-model queue path)', ['--agent', 'tester']],
    ['without --agent (direct path)', []],
  ])(
    '%s: one envelope on stdout and the row is stored',
    (_label, extra) => {
      const text = `t12817 observation ${extra.length > 0 ? 'agent' : 'plain'}`;
      const observe = envelope([
        'memory',
        'observe',
        text,
        '--title',
        't12817 title',
        '--type',
        'discovery',
        '--source-type',
        'manual',
        ...extra,
      ]);
      expect(observe.status).toBe(0);
      expect(observe.json.success).toBe(true);
      const id = observe.json.data?.id;
      expect(id).toMatch(/^O-/);

      const fetched = envelope(['memory', 'fetch', String(id)]);
      expect(fetched.json.success).toBe(true);
      const row = fetched.json.data?.results?.find((r) => r.id === id);
      expect(row?.data?.narrative).toBe(text);
      if (extra.length > 0) expect(row?.data?.agent).toBe('tester');

      const recent = envelope(['memory', 'recent', '--since', '2h']);
      expect(recent.json.success).toBe(true);
      const listed = recent.json.data?.observations?.find((o) => o.id === id);
      expect(listed?.text).toBe(text);
    },
    120_000,
  );
});
