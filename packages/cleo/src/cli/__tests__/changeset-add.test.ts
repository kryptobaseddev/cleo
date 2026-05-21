/**
 * End-to-end CLI integration tests for `cleo changeset add` (T9793).
 *
 * Spawns the compiled `cleo` CLI as a subprocess against an isolated tmp
 * `CLEO_PROJECT_ROOT` per test so the LAFS envelope, exit codes, and on-disk
 * side effects are validated against the same surface external operators
 * see — never the in-process function.
 *
 * Coverage:
 *  - Happy path: success envelope + .changeset/<slug>.md on disk + SSoT blob.
 *  - Invalid slug: E_SLUG_PATTERN_MISMATCH envelope, nothing on disk.
 *  - Invalid kind: E_VALIDATION envelope at the CLI flag layer.
 *  - Breaking entry: --breaking flag persists the migration note.
 *  - Multi-task entry: --tasks accepts comma-separated input.
 *  - Subcommand registration: `cleo changeset` exposes `add`.
 *
 * @epic T9793 (E-DOCS-CHANGESET-INTEGRATION)
 * @task T9793
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { changesetCommand } from '../commands/changeset.js';

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
 * Run `node dist/cli/index.js <args>` against an isolated tmp project root.
 *
 * `CLEO_PROJECT_ROOT` pins `getProjectRoot()` so the subprocess never walks
 * out of the tmp dir and the worktree's own `.cleo/` is never touched.
 */
function runCli(args: readonly string[], projectRoot: string): CliResult {
  const env = {
    ...process.env,
    CLEO_PROJECT_ROOT: projectRoot,
    CLEO_ROOT: projectRoot,
    CLEO_DIR: join(projectRoot, '.cleo'),
    CLEO_OUTPUT_FORMAT: 'json',
  };
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
  readonly error?: {
    readonly code?: number | string;
    readonly codeName?: string;
    readonly message?: string;
  };
}

/**
 * Extract the JSON LAFS envelope from a CLI invocation's stdout.
 *
 * Scans line-by-line because some commands emit pager / log footer lines
 * around the JSON payload.
 */
function parseEnvelope<T = unknown>(stdout: string): LafsEnvelope<T> {
  const lines = stdout.split('\n').filter((l) => l.trim().length > 0);
  for (const line of lines) {
    if (!line.trim().startsWith('{')) continue;
    try {
      return JSON.parse(line) as LafsEnvelope<T>;
    } catch {
      /* Not a JSON line — keep scanning. */
    }
  }
  throw new Error(`parseEnvelope: no JSON envelope on stdout. Got:\n${stdout.slice(0, 2000)}`);
}

interface ChangesetAddData {
  readonly filePath: string;
  readonly slug: string;
  readonly attachmentId: string;
  readonly sha256: string;
  readonly ownerId: string;
}

// ─── Fixtures ────────────────────────────────────────────────────────────────

let projectRoot: string;

beforeEach(async () => {
  projectRoot = await mkdtemp(join(tmpdir(), 'cleo-T9793-cli-'));
  // The attachment store stats `<projectRoot>/.cleo/` to derive its data
  // dir; create it so the subprocess does not have to walk back.
  mkdirSync(join(projectRoot, '.cleo'), { recursive: true });
});

afterEach(async () => {
  await rm(projectRoot, { recursive: true, force: true }).catch(() => {
    /* never fail teardown */
  });
});

// ─── Subcommand registration (no CLI spawn required) ─────────────────────────

interface CittyCommand {
  meta?: unknown;
  args?: Record<string, { type?: string; required?: boolean; description?: string }>;
  subCommands?: Record<string, CittyCommand>;
}

function getMeta(cmd: CittyCommand): { name: string; description: string } {
  const meta = typeof cmd.meta === 'function' ? (cmd.meta as () => unknown)() : cmd.meta;
  return meta as { name: string; description: string };
}

describe('cleo changeset — CLI registration', () => {
  it('exposes the `add` subcommand', () => {
    const subs = (changesetCommand as unknown as CittyCommand).subCommands ?? {};
    expect(subs.add).toBeDefined();
  });

  it('declares the spec-defined required flags on `add`', () => {
    const subs = (changesetCommand as unknown as CittyCommand).subCommands ?? {};
    const addCmd = subs.add as CittyCommand;
    const args = addCmd.args ?? {};
    expect(args.slug?.type).toBe('string');
    expect(args.slug?.required).toBe(true);
    expect(args.tasks?.type).toBe('string');
    expect(args.tasks?.required).toBe(true);
    expect(args.kind?.type).toBe('string');
    expect(args.kind?.required).toBe(true);
    expect(args.summary?.type).toBe('string');
    expect(args.summary?.required).toBe(true);
    // Optional surfaces still present.
    expect(args.prs?.type).toBe('string');
    expect(args.notes?.type).toBe('string');
    expect(args.breaking?.type).toBe('string');
    expect(args['attached-by']?.type).toBe('string');
  });

  it('declares meta.name === "changeset" on the root command', () => {
    const meta = getMeta(changesetCommand as unknown as CittyCommand);
    expect(meta.name).toBe('changeset');
    expect(meta.description).toMatch(/changeset/i);
  });
});

// ─── End-to-end CLI subprocess tests ─────────────────────────────────────────

describe.skipIf(!CLI_DIST_AVAILABLE)('cleo changeset add — subprocess', () => {
  it('happy path: writes BOTH file and SSoT then emits success envelope', () => {
    const res = runCli(
      [
        'changeset',
        'add',
        '--slug',
        't9793-cli-happy',
        '--tasks',
        'T9793',
        '--kind',
        'feat',
        '--summary',
        'Dual-write via the CLI.',
      ],
      projectRoot,
    );

    expect(res.status).toBe(0);
    const env = parseEnvelope<ChangesetAddData>(res.stdout);
    expect(env.success).toBe(true);
    if (!env.success || !env.data) return;

    expect(env.data.slug).toBe('t9793-cli-happy');
    expect(env.data.ownerId).toBe('T9793');
    expect(env.data.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(env.data.attachmentId.length).toBeGreaterThan(0);

    // File side-effect must exist on disk.
    const filePath = join(projectRoot, '.changeset', 't9793-cli-happy.md');
    expect(existsSync(filePath)).toBe(true);

    // Bytes must round-trip frontmatter fields.
    const md = readFileSync(filePath, 'utf-8');
    expect(md).toContain('id: t9793-cli-happy');
    expect(md).toContain('tasks: [T9793]');
    expect(md).toContain('kind: feat');
    expect(md).toContain('summary: Dual-write via the CLI.');
  });

  it('rejects a slug missing the t#### prefix with E_SLUG_PATTERN_MISMATCH', () => {
    const res = runCli(
      [
        'changeset',
        'add',
        '--slug',
        'feature-no-prefix',
        '--tasks',
        'T9793',
        '--kind',
        'feat',
        '--summary',
        'Should be rejected.',
      ],
      projectRoot,
    );

    expect(res.status).not.toBe(0);
    const env = parseEnvelope(res.stdout);
    expect(env.success).toBe(false);
    expect(env.error?.codeName ?? env.error?.code).toBe('E_SLUG_PATTERN_MISMATCH');
    // Nothing should be on disk.
    expect(existsSync(join(projectRoot, '.changeset', 'feature-no-prefix.md'))).toBe(false);
  });

  it('rejects an unknown kind with E_VALIDATION at the CLI flag layer', () => {
    const res = runCli(
      [
        'changeset',
        'add',
        '--slug',
        't9793-bad-kind',
        '--tasks',
        'T9793',
        '--kind',
        'nonsense',
        '--summary',
        'Bad kind.',
      ],
      projectRoot,
    );

    expect(res.status).not.toBe(0);
    const env = parseEnvelope(res.stdout);
    expect(env.success).toBe(false);
    expect(env.error?.codeName ?? env.error?.code).toBe('E_VALIDATION');
  });

  it('persists --breaking migration note as a YAML block scalar', () => {
    const res = runCli(
      [
        'changeset',
        'add',
        '--slug',
        't9793-cli-breaking',
        '--tasks',
        'T9793',
        '--kind',
        'breaking',
        '--summary',
        'API rename.',
        '--breaking',
        'Old API removed — switch to the new one.',
      ],
      projectRoot,
    );

    expect(res.status).toBe(0);
    const env = parseEnvelope<ChangesetAddData>(res.stdout);
    expect(env.success).toBe(true);
    if (!env.success || !env.data) return;

    const md = readFileSync(env.data.filePath, 'utf-8');
    expect(md).toContain('kind: breaking');
    // YAML block scalar — `|-` strips the trailing newline that `|` would add
    // (keeps the breaking field round-trippable without parser-injected \n).
    expect(md).toContain('breaking: |-');
    expect(md).toContain('Old API removed');
  });

  it('accepts comma-separated --tasks values', () => {
    const res = runCli(
      [
        'changeset',
        'add',
        '--slug',
        't9793-cli-multi-task',
        '--tasks',
        'T9793,T9788',
        '--kind',
        'feat',
        '--summary',
        'Multi-task entry.',
      ],
      projectRoot,
    );

    expect(res.status).toBe(0);
    const env = parseEnvelope<ChangesetAddData>(res.stdout);
    expect(env.success).toBe(true);
    if (!env.success || !env.data) return;

    const md = readFileSync(env.data.filePath, 'utf-8');
    expect(md).toContain('tasks: [T9793, T9788]');
    // Owner is the FIRST task.
    expect(env.data.ownerId).toBe('T9793');
  });

  it('accepts --prs as a comma-separated list of PR numbers', () => {
    const res = runCli(
      [
        'changeset',
        'add',
        '--slug',
        't9793-cli-prs',
        '--tasks',
        'T9793',
        '--kind',
        'feat',
        '--summary',
        'PR-anchored.',
        '--prs',
        '349,357',
      ],
      projectRoot,
    );

    expect(res.status).toBe(0);
    const env = parseEnvelope<ChangesetAddData>(res.stdout);
    expect(env.success).toBe(true);
    if (!env.success || !env.data) return;

    const md = readFileSync(env.data.filePath, 'utf-8');
    expect(md).toContain('prs: [349, 357]');
  });
});

// ─── cleo changeset list — registration + E2E subprocess ────────────────────

describe('cleo changeset — list registration', () => {
  it('exposes the `list` subcommand alongside `add`', () => {
    const subs = (changesetCommand as unknown as CittyCommand).subCommands ?? {};
    expect(subs.list).toBeDefined();
    expect(subs.add).toBeDefined();
  });

  it('list takes no positional/required args — pure read', () => {
    const subs = (changesetCommand as unknown as CittyCommand).subCommands ?? {};
    const listCmd = subs.list as CittyCommand;
    const args = listCmd.args ?? {};
    // No required flags — list is project-rooted and parameter-free.
    for (const [, def] of Object.entries(args)) {
      expect(def.required).not.toBe(true);
    }
  });
});

interface ChangesetListData {
  readonly entries: ReadonlyArray<{
    readonly id: string;
    readonly tasks: readonly string[];
    readonly kind: string;
    readonly summary: string;
    readonly prs?: readonly number[];
  }>;
  readonly count: number;
  readonly dir: string;
  readonly note?: string;
}

describe.skipIf(!CLI_DIST_AVAILABLE)('cleo changeset list — subprocess', () => {
  it('returns empty entries envelope when .changeset/ does not exist', () => {
    // Fresh project root from the beforeEach — no .changeset/ subdir yet.
    const res = runCli(['changeset', 'list'], projectRoot);
    expect(res.status).toBe(0);
    const env = parseEnvelope<ChangesetListData>(res.stdout);
    expect(env.success).toBe(true);
    if (!env.success || !env.data) return;
    expect(env.data.count).toBe(0);
    expect(env.data.entries).toEqual([]);
    expect(env.data.note).toBeDefined();
  });

  it('lists entries after a successful add — same parser as the aggregator', () => {
    // Seed two entries via the canonical writer so we exercise the dual-write
    // path AND the read path in one E2E shot.
    const addOne = runCli(
      [
        'changeset',
        'add',
        '--slug',
        't9785-listed-alpha',
        '--tasks',
        'T9785',
        '--kind',
        'chore',
        '--summary',
        'Alpha entry for list E2E.',
      ],
      projectRoot,
    );
    expect(addOne.status).toBe(0);

    const addTwo = runCli(
      [
        'changeset',
        'add',
        '--slug',
        't9785-listed-beta',
        '--tasks',
        'T9785,T9786',
        '--kind',
        'feat',
        '--summary',
        'Beta entry — multi-task.',
        '--prs',
        '999',
      ],
      projectRoot,
    );
    expect(addTwo.status).toBe(0);

    const list = runCli(['changeset', 'list'], projectRoot);
    expect(list.status).toBe(0);
    const env = parseEnvelope<ChangesetListData>(list.stdout);
    expect(env.success).toBe(true);
    if (!env.success || !env.data) return;

    expect(env.data.count).toBe(2);
    const slugs = env.data.entries.map((e) => e.id).sort();
    expect(slugs).toEqual(['t9785-listed-alpha', 't9785-listed-beta']);

    const beta = env.data.entries.find((e) => e.id === 't9785-listed-beta');
    expect(beta?.kind).toBe('feat');
    expect(beta?.tasks).toEqual(['T9785', 'T9786']);
    expect(beta?.prs).toEqual([999]);
  });

  it('--human renders an aligned SLUG/KIND/TASKS/PR/SUMMARY table', () => {
    runCli(
      [
        'changeset',
        'add',
        '--slug',
        't9785-human-row',
        '--tasks',
        'T9785',
        '--kind',
        'docs',
        '--summary',
        'Human row.',
      ],
      projectRoot,
    );

    const env = {
      ...process.env,
      CLEO_PROJECT_ROOT: projectRoot,
      CLEO_ROOT: projectRoot,
      CLEO_DIR: join(projectRoot, '.cleo'),
      CLEO_OUTPUT_FORMAT: 'human',
    };
    const res = spawnSync('node', [CLI_DIST, 'changeset', 'list', '--human'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      encoding: 'utf-8',
      timeout: 90_000,
      cwd: projectRoot,
      env,
    });
    expect(res.status).toBe(0);
    // dataTable writes to stdout via humanLine; header row + the slug row
    // both have to land somewhere on stdout.
    const out = (res.stdout ?? '') + (res.stderr ?? '');
    expect(out).toContain('SLUG');
    expect(out).toContain('SUMMARY');
    expect(out).toContain('t9785-human-row');
    expect(out).toContain('docs');
  });
});
