/**
 * Integration tests for the `cleo templates` CLI namespace (T9889 — closes
 * Epic T9859 / Saga T9855 / E4-DOCS-SDK-BOUNDARY · ADR-076).
 *
 * Unlike the unit tests in `templates.test.ts` (which mock the renderer to
 * observe `cliOutput` / `cliError` calls), these tests drive the citty
 * commands' real `run()` against a fresh tmpdir project root with the
 * renderer LIVE — capturing the LAFS envelope from `process.stdout` and
 * asserting both shape and operation identity.
 *
 * Isolation strategy mirrors `e3-integration.test.ts`:
 *  - `CLEO_PROJECT_ROOT` is redirected at a fresh tmpdir per test.
 *  - `XDG_DATA_HOME` / `XDG_CONFIG_HOME` / `HOME` likewise isolated so the
 *    user's real config can never leak into the run.
 *  - Format context is reset to `json` so `cliOutput` writes the canonical
 *    LAFS envelope to stdout (the default for agent-first invocations).
 *
 * Why in-process and not a subprocess: the existing repo convention for
 * "integration" coverage (e3-integration, docs-integration, etc.) is to
 * exercise the real citty command and real disk through env redirection.
 * A subprocess spawn would require building the CLI artifact first and
 * doubles the runtime cost without testing any new wiring.
 *
 * @task T9889
 * @saga T9855
 * @epic T9859
 * @adr 076
 */

import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getTemplateManifest } from '@cleocode/core/templates/registry';
import type { CommandDef } from 'citty';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { setFormatContext } from '../../../format-context.js';
import { templatesInstallCommand } from '../install.js';
import { templatesListCommand } from '../list.js';
import { templatesShowCommand } from '../show.js';

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
 * neither the host repo's `.cleo/` nor the user's config can leak in.
 *
 * @returns The isolated project root path.
 */
function isolateHomes(): string {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const projectRoot = mkdtempSync(join(tmpdir(), `cleo-templates-int-${stamp}-`));
  const xdgRoot = join(tmpdir(), `cleo-templates-int-xdg-${stamp}`);
  const xdgConfig = join(tmpdir(), `cleo-templates-int-xdgcfg-${stamp}`);
  const home = join(tmpdir(), `cleo-templates-int-home-${stamp}`);
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
 */
async function invokeCli(
  cmd: CommandDef,
  args: RunArgs,
): Promise<{ envelope: Record<string, unknown>; lines: string[] }> {
  const runFn = (cmd as { run?: (ctx: { args: RunArgs; rawArgs: string[] }) => Promise<void> }).run;
  if (!runFn) throw new Error('command has no run function');
  const stdout = captureStdout();
  try {
    await runFn({ args, rawArgs: [] });
  } finally {
    stdout.restore();
  }
  const lastLine = stdout.lines[stdout.lines.length - 1];
  if (lastLine === undefined) {
    throw new Error('no stdout output captured from CLI run');
  }
  return { envelope: JSON.parse(lastLine.trim()) as Record<string, unknown>, lines: stdout.lines };
}

/**
 * Resolve a stable template id we can exercise across the install flow.
 * Picks the first workflow template so the install path always lands under
 * `.github/workflows/`.
 */
function firstWorkflowId(): string {
  const wf = getTemplateManifest().find((e) => e.kind === 'workflow');
  if (!wf) throw new Error('no workflow templates registered — registry shape changed');
  return wf.id;
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
// cleo templates list
// ---------------------------------------------------------------------------

describe('cleo templates list — integration', () => {
  it('emits a LAFS envelope with operation=templates.list and non-empty entries', async () => {
    const { envelope } = await invokeCli(templatesListCommand as CommandDef, {});

    expect(envelope['success']).toBe(true);
    const meta = envelope['meta'] as { operation?: string } | undefined;
    expect(meta?.operation).toBe('templates.list');

    const data = envelope['data'] as { kind: unknown; entries: unknown[] };
    expect(data.kind).toBeNull();
    expect(Array.isArray(data.entries)).toBe(true);
    expect(data.entries.length).toBeGreaterThan(0);
  });

  it('filters the registry when --kind=workflow is passed', async () => {
    const { envelope } = await invokeCli(templatesListCommand as CommandDef, { kind: 'workflow' });

    expect(envelope['success']).toBe(true);
    const data = envelope['data'] as {
      kind: string;
      entries: Array<{ kind: string }>;
    };
    expect(data.kind).toBe('workflow');
    expect(data.entries.length).toBeGreaterThan(0);
    for (const entry of data.entries) {
      expect(entry.kind).toBe('workflow');
    }
  });
});

// ---------------------------------------------------------------------------
// cleo templates show
// ---------------------------------------------------------------------------

describe('cleo templates show — integration', () => {
  it('returns the matching entry inside a LAFS envelope for a known id', async () => {
    const id = firstWorkflowId();
    const { envelope } = await invokeCli(templatesShowCommand as CommandDef, { id });

    expect(envelope['success']).toBe(true);
    const meta = envelope['meta'] as { operation?: string } | undefined;
    expect(meta?.operation).toBe('templates.show');

    const data = envelope['data'] as { id: string; entry: { id: string; kind: string } };
    expect(data.id).toBe(id);
    expect(data.entry.id).toBe(id);
  });
});

// ---------------------------------------------------------------------------
// cleo templates install
// ---------------------------------------------------------------------------

describe('cleo templates install — integration', () => {
  it('writes the template into the isolated project root and returns installed=true', async () => {
    const id = firstWorkflowId();
    const { envelope } = await invokeCli(templatesInstallCommand as CommandDef, {
      id,
      project: projectRoot,
    });

    expect(envelope['success']).toBe(true);
    const meta = envelope['meta'] as { operation?: string } | undefined;
    expect(meta?.operation).toBe('templates.install');

    const data = envelope['data'] as {
      id: string;
      installPath: string;
      installed: boolean;
      noop: boolean;
    };
    expect(data.id).toBe(id);
    expect(data.installed).toBe(true);
    expect(data.noop).toBe(false);
    expect(existsSync(data.installPath)).toBe(true);
    // The install path MUST land under our isolated project root — proves
    // no leakage into the host repo's `.github/workflows/` directory.
    expect(data.installPath.startsWith(projectRoot)).toBe(true);
  });
});
