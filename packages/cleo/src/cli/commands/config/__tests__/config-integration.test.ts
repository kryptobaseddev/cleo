/**
 * Integration tests for the `cleo config` CLI namespace (T9889 — closes
 * Epic T9859 / Saga T9855 / E4-DOCS-SDK-BOUNDARY · ADR-076).
 *
 * Unlike the unit tests in `config.test.ts` (which mock the renderer and
 * `getProjectRoot` so `cliOutput` / `cliError` calls are observable as
 * spies), these tests drive the citty commands' real `run()` against a
 * fresh tmpdir project root with the renderer LIVE — capturing the LAFS
 * envelope from `process.stdout` and asserting both shape and operation
 * identity.
 *
 * Isolation strategy mirrors `e3-integration.test.ts`:
 *  - `CLEO_PROJECT_ROOT` is redirected at a fresh tmpdir per test.
 *  - `XDG_DATA_HOME` / `XDG_CONFIG_HOME` / `HOME` likewise isolated so the
 *    user's real config can never leak into the run.
 *  - Format context is reset to `json` so `cliOutput` writes the canonical
 *    LAFS envelope to stdout (the default for agent-first invocations).
 *
 * The `set` flow round-trips through `show` / `get` to prove the writer
 * actually mutated the on-disk `.cleo/config.json` (rather than merely
 * returning the post-write payload).
 *
 * @task T9889
 * @saga T9855
 * @epic T9859
 * @adr 076
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CommandDef } from 'citty';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setFormatContext } from '../../../format-context.js';
import { configGetCommand } from '../get.js';
import { configSetCommand } from '../set.js';
import { configShowCommand } from '../show.js';
import { configValidateCommand } from '../validate.js';

// ---------------------------------------------------------------------------
// Environment isolation — mirrors e3-integration.test.ts
// ---------------------------------------------------------------------------

const SAVED_ENV: Record<string, string | undefined> = {};
const ENV_KEYS = [
  'XDG_DATA_HOME',
  'XDG_CONFIG_HOME',
  'CLEO_HOME',
  'CLEO_CONFIG_HOME',
  'CLEO_DIR',
  'CLEO_FORMAT',
  'CLEO_HARNESS',
  'CLEO_ROOT',
  'CLEO_PROJECT_ROOT',
  'HOME',
];

/** Snapshot every env key we plan to mutate so afterEach can restore. */
function saveEnv(): void {
  for (const k of ENV_KEYS) SAVED_ENV[k] = process.env[k];
}

/** Restore the original env snapshot taken by `saveEnv`. */
function restoreEnv(): void {
  for (const k of ENV_KEYS) {
    if (SAVED_ENV[k] === undefined) delete process.env[k];
    else process.env[k] = SAVED_ENV[k];
  }
}

/** Drop every env key we know about so isolation is total. */
function clearEnv(): void {
  for (const k of ENV_KEYS) delete process.env[k];
}

/**
 * Point CLEO_PROJECT_ROOT and the XDG/HOME triplet at fresh tmpdirs so
 * neither the host repo's `.cleo/config.json` nor the user's config can
 * leak in. Pre-creates `<projectRoot>/.cleo/` so the `set` writer doesn't
 * need to materialise its parent directory.
 *
 * @returns The isolated project root path.
 */
function isolateHomes(): string {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const projectRoot = mkdtempSync(join(tmpdir(), `cleo-config-int-${stamp}-`));
  mkdirSync(join(projectRoot, '.cleo'), { recursive: true });
  const xdgRoot = join(tmpdir(), `cleo-config-int-xdg-${stamp}`);
  const xdgConfig = join(tmpdir(), `cleo-config-int-xdgcfg-${stamp}`);
  const home = join(tmpdir(), `cleo-config-int-home-${stamp}`);
  mkdirSync(xdgRoot, { recursive: true });
  mkdirSync(xdgConfig, { recursive: true });
  mkdirSync(home, { recursive: true });
  process.env['XDG_DATA_HOME'] = xdgRoot;
  process.env['XDG_CONFIG_HOME'] = xdgConfig;
  process.env['HOME'] = home;
  process.env['CLEO_PROJECT_ROOT'] = projectRoot;
  return projectRoot;
}

// ---------------------------------------------------------------------------
// Stdout capture + citty invoker
// ---------------------------------------------------------------------------

interface CapturedOut {
  readonly lines: string[];
  readonly restore: () => void;
}

/**
 * Capture every `process.stdout.write` call until `restore()` is invoked.
 * Mirrors the helper used by `e3-integration.test.ts` so envelope parsing
 * stays consistent across integration suites.
 */
function captureStdout(): CapturedOut {
  const orig = process.stdout.write.bind(process.stdout);
  const lines: string[] = [];
  process.stdout.write = ((s: unknown) => {
    lines.push(String(s));
    return true;
  }) as typeof process.stdout.write;
  return {
    lines,
    restore: () => {
      process.stdout.write = orig;
    },
  };
}

type RunArgs = Record<string, unknown>;

/**
 * Invoke a citty `CommandDef.run` directly with the given args and capture
 * the LAFS envelope written to stdout. The last stdout line is parsed as
 * JSON and returned alongside the raw line buffer.
 *
 * `process.exit` is stubbed so non-zero exit paths surface as a thrown
 * `__EXIT__:<code>` error instead of terminating the test worker.
 */
async function invokeCli(
  cmd: CommandDef,
  args: RunArgs,
): Promise<{ envelope: Record<string, unknown>; lines: string[]; exitCode: number | null }> {
  const runFn = (cmd as { run?: (ctx: { args: RunArgs; rawArgs: string[] }) => Promise<void> }).run;
  if (!runFn) throw new Error('command has no run function');
  let exitCode: number | null = null;
  const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number | string | null) => {
    exitCode = typeof code === 'number' ? code : code == null ? 0 : Number(code);
    throw new Error(`__EXIT__:${exitCode}`);
  }) as never);
  const stdout = captureStdout();
  try {
    try {
      await runFn({ args, rawArgs: [] });
    } catch (err) {
      if (!(err instanceof Error) || !err.message.startsWith('__EXIT__:')) throw err;
    }
  } finally {
    stdout.restore();
    exitSpy.mockRestore();
  }
  const lastLine = stdout.lines[stdout.lines.length - 1];
  if (lastLine === undefined) {
    throw new Error('no stdout output captured from CLI run');
  }
  return {
    envelope: JSON.parse(lastLine.trim()) as Record<string, unknown>,
    lines: stdout.lines,
    exitCode,
  };
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

let projectRoot = '';

beforeEach(() => {
  saveEnv();
  clearEnv();
  projectRoot = isolateHomes();
  setFormatContext({ format: 'json', source: 'default', quiet: false });
});

afterEach(() => {
  restoreEnv();
  if (projectRoot && existsSync(projectRoot)) {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// cleo config show
// ---------------------------------------------------------------------------

describe('cleo config show — integration', () => {
  it('emits a LAFS envelope with operation=config.show for scope=project', async () => {
    const { envelope, exitCode } = await invokeCli(configShowCommand as CommandDef, {
      scope: 'project',
    });

    expect(exitCode).toBeNull();
    expect(envelope['success']).toBe(true);
    const meta = envelope['meta'] as { operation?: string } | undefined;
    expect(meta?.operation).toBe('config.show');

    const data = envelope['data'] as { scope: string; config: Record<string, unknown> };
    expect(data.scope).toBe('project');
    // Fresh tmpdir has no .cleo/config.json — registry returns `{}`.
    expect(data.config).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// cleo config get
// ---------------------------------------------------------------------------

describe('cleo config get — integration', () => {
  it('returns E_NOT_FOUND inside a LAFS envelope when the key is absent', async () => {
    const { envelope, exitCode } = await invokeCli(configGetCommand as CommandDef, {
      key: 'definitely.not.a.key',
      scope: 'merged',
    });

    expect(exitCode).toBe(4);
    expect(envelope['success']).toBe(false);
    const error = envelope['error'] as { codeName?: string; message?: string };
    expect(error.codeName).toBe('E_NOT_FOUND');
    expect(error.message).toMatch(/not found/);
  });
});

// ---------------------------------------------------------------------------
// cleo config set — round-trip through get / show
// ---------------------------------------------------------------------------

describe('cleo config set — integration', () => {
  it('writes a number to project config and the value round-trips through get', async () => {
    const setRes = await invokeCli(configSetCommand as CommandDef, {
      key: 'test.intKey',
      value: '42',
      scope: 'project',
      type: 'number',
    });

    expect(setRes.envelope['success']).toBe(true);
    const setMeta = setRes.envelope['meta'] as { operation?: string } | undefined;
    expect(setMeta?.operation).toBe('config.set');

    const setData = setRes.envelope['data'] as {
      scope: string;
      key: string;
      value: unknown;
      validate: { ok: boolean };
    };
    expect(setData.scope).toBe('project');
    expect(setData.key).toBe('test.intKey');
    expect(setData.value).toBe(42);
    expect(setData.validate.ok).toBe(true);

    // The writer MUST have created the on-disk file under the isolated root.
    const configPath = join(projectRoot, '.cleo', 'config.json');
    expect(existsSync(configPath)).toBe(true);
    const onDisk = JSON.parse(readFileSync(configPath, 'utf8')) as {
      test?: { intKey?: unknown };
    };
    expect(onDisk.test?.intKey).toBe(42);

    // And `cleo config get` reads the same value back.
    const getRes = await invokeCli(configGetCommand as CommandDef, {
      key: 'test.intKey',
      scope: 'project',
    });
    expect(getRes.exitCode).toBeNull();
    expect(getRes.envelope['success']).toBe(true);
    const getData = getRes.envelope['data'] as { key: string; value: unknown };
    expect(getData.key).toBe('test.intKey');
    expect(getData.value).toBe(42);
  });
});

// ---------------------------------------------------------------------------
// cleo config validate
// ---------------------------------------------------------------------------

describe('cleo config validate — integration', () => {
  it('exits 0 with ok=true for an empty (no-schema-bound) project config', async () => {
    const { envelope, exitCode } = await invokeCli(configValidateCommand as CommandDef, {
      scope: 'project',
    });

    expect(exitCode).toBeNull();
    expect(envelope['success']).toBe(true);
    const meta = envelope['meta'] as { operation?: string } | undefined;
    expect(meta?.operation).toBe('config.validate');

    const data = envelope['data'] as { scope: string; ok: boolean; issues: string[] };
    expect(data.scope).toBe('project');
    expect(data.ok).toBe(true);
    expect(data.issues).toEqual([]);
  });
});
