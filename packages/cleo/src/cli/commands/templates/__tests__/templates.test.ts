/**
 * Tests for `cleo templates {list, show, install, upgrade, diff, validate}` —
 * verifies the CLI namespace wires into the CORE registry (T9877) end-to-end.
 *
 * Each test uses an isolated `os.tmpdir()` project root so the host repo's
 * `.cleo/` and `.github/workflows/` are never touched. The renderer layer is
 * mocked so `cliOutput`/`cliError` calls are observable.
 *
 * @task T9886
 * @saga T9855
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock the renderer so cliOutput/cliError become observable spies.
const mockCliOutput = vi.fn();
const mockCliError = vi.fn();
vi.mock('../../../renderers/index.js', () => ({
  cliOutput: (...args: unknown[]) => mockCliOutput(...args),
  cliError: (...args: unknown[]) => mockCliError(...args),
}));

// Imports AFTER the renderer mock so commands close over the spies.
import { getTemplateManifest, resolveSourcePathAbsolute } from '@cleocode/core/templates/registry';
import { templatesDiffCommand } from '../diff.js';
import { templatesInstallCommand } from '../install.js';
import { templatesListCommand } from '../list.js';
import { templatesShowCommand } from '../show.js';
import { templatesUpgradeCommand } from '../upgrade.js';
import { templatesValidateCommand } from '../validate.js';

type RunArgs = Record<string, unknown>;
type CittyCommand = {
  run?: (ctx: { args: RunArgs; rawArgs: string[] }) => Promise<void> | void;
};

async function invoke(cmd: CittyCommand, args: RunArgs): Promise<void> {
  const run = cmd.run;
  if (!run) throw new Error('command has no run()');
  await run({ args, rawArgs: [] });
}

let tempRoot = '';
let exitSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  tempRoot = mkdtempSync(join(tmpdir(), 'cleo-templates-test-'));
  vi.clearAllMocks();
  exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number | string | null) => {
    throw new Error(`__EXIT__:${code ?? 0}`);
  }) as never);
});

afterEach(() => {
  exitSpy.mockRestore();
  if (tempRoot) {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

/** First entry of `kind === 'workflow'` — used as a canonical fixture target. */
function firstWorkflowId(): string {
  const wf = getTemplateManifest().find((e) => e.kind === 'workflow');
  if (!wf) throw new Error('no workflow templates registered — registry shape changed');
  return wf.id;
}

// ---------------------------------------------------------------------------
// cleo templates list
// ---------------------------------------------------------------------------

describe('cleo templates list', () => {
  it('returns every registered entry when no --kind is given', async () => {
    await invoke(templatesListCommand, {});

    expect(mockCliOutput).toHaveBeenCalledOnce();
    const [data, opts] = mockCliOutput.mock.calls[0]!;
    const payload = data as { kind: unknown; entries: unknown[] };
    expect(payload.kind).toBeNull();
    expect(Array.isArray(payload.entries)).toBe(true);
    expect(payload.entries.length).toBeGreaterThan(0);
    expect(opts).toMatchObject({ command: 'templates-list', operation: 'templates.list' });
    expect(mockCliError).not.toHaveBeenCalled();
  });

  it('filters entries when --kind=workflow is given', async () => {
    await invoke(templatesListCommand, { kind: 'workflow' });

    expect(mockCliOutput).toHaveBeenCalledOnce();
    const [data] = mockCliOutput.mock.calls[0]!;
    const payload = data as { kind: string; entries: Array<{ kind: string }> };
    expect(payload.kind).toBe('workflow');
    expect(payload.entries.length).toBeGreaterThan(0);
    for (const entry of payload.entries) {
      expect(entry.kind).toBe('workflow');
    }
  });

  it('rejects an unknown --kind with a typed error envelope', async () => {
    await expect(invoke(templatesListCommand, { kind: 'bogus' })).rejects.toThrow(/__EXIT__:2/);

    expect(mockCliError).toHaveBeenCalledOnce();
    const [message, code, details] = mockCliError.mock.calls[0]!;
    expect(message).toMatch(/invalid --kind/);
    expect(code).toBe(2);
    expect(details).toMatchObject({ name: 'E_TEMPLATES_LIST_FAILED' });
  });
});

// ---------------------------------------------------------------------------
// cleo templates show
// ---------------------------------------------------------------------------

describe('cleo templates show', () => {
  it('returns the matching entry for a known id', async () => {
    const id = firstWorkflowId();
    await invoke(templatesShowCommand, { id });

    expect(mockCliOutput).toHaveBeenCalledOnce();
    const [data] = mockCliOutput.mock.calls[0]!;
    const payload = data as { id: string; entry: { id: string; kind: string } };
    expect(payload.id).toBe(id);
    expect(payload.entry.id).toBe(id);
  });

  it('returns E_NOT_FOUND for an unknown id', async () => {
    await expect(invoke(templatesShowCommand, { id: 'definitely-not-a-template' })).rejects.toThrow(
      /__EXIT__:4/,
    );

    expect(mockCliError).toHaveBeenCalledOnce();
    const [message, code, details] = mockCliError.mock.calls[0]!;
    expect(message).toMatch(/not found/);
    expect(code).toBe(4);
    expect(details).toMatchObject({ name: 'E_NOT_FOUND' });
  });
});

// ---------------------------------------------------------------------------
// cleo templates install
// ---------------------------------------------------------------------------

describe('cleo templates install', () => {
  it('writes the rendered file to the install path', async () => {
    const id = firstWorkflowId();
    await invoke(templatesInstallCommand, { id, project: tempRoot });

    expect(mockCliOutput).toHaveBeenCalledOnce();
    const [data] = mockCliOutput.mock.calls[0]!;
    const payload = data as { id: string; installPath: string; installed: boolean; noop: boolean };
    expect(payload.id).toBe(id);
    expect(payload.installed).toBe(true);
    expect(payload.noop).toBe(false);
    expect(existsSync(payload.installPath)).toBe(true);
  });

  it('is idempotent — second install on identical content is a noop', async () => {
    const id = firstWorkflowId();
    await invoke(templatesInstallCommand, { id, project: tempRoot });
    mockCliOutput.mockClear();

    await invoke(templatesInstallCommand, { id, project: tempRoot });

    expect(mockCliOutput).toHaveBeenCalledOnce();
    const [data] = mockCliOutput.mock.calls[0]!;
    const payload = data as { installed: boolean; noop: boolean };
    expect(payload.installed).toBe(false);
    expect(payload.noop).toBe(true);
  });

  it('writes the same bytes as the rendered source', async () => {
    const id = firstWorkflowId();
    const entry = getTemplateManifest().find((e) => e.id === id)!;
    const source = readFileSync(resolveSourcePathAbsolute(entry), 'utf8');

    await invoke(templatesInstallCommand, { id, project: tempRoot });

    const installed = readFileSync(join(tempRoot, entry.installPath), 'utf8');
    expect(installed).toBe(source);
  });

  it('returns E_NOT_FOUND for an unknown id', async () => {
    await expect(
      invoke(templatesInstallCommand, { id: 'definitely-not-a-template', project: tempRoot }),
    ).rejects.toThrow(/__EXIT__:4/);

    expect(mockCliError).toHaveBeenCalledOnce();
    const [, , details] = mockCliError.mock.calls[0]!;
    expect(details).toMatchObject({ name: 'E_NOT_FOUND' });
  });
});

// ---------------------------------------------------------------------------
// cleo templates diff
// ---------------------------------------------------------------------------

describe('cleo templates diff', () => {
  it('returns same=true after a fresh install (exit 0)', async () => {
    const id = firstWorkflowId();
    await invoke(templatesInstallCommand, { id, project: tempRoot });
    mockCliOutput.mockClear();

    await invoke(templatesDiffCommand, { id, project: tempRoot });

    expect(mockCliOutput).toHaveBeenCalledOnce();
    const [data] = mockCliOutput.mock.calls[0]!;
    const payload = data as { same: boolean; missing: boolean; diff: string };
    expect(payload.same).toBe(true);
    expect(payload.missing).toBe(false);
    expect(payload.diff).toBe('');
  });

  it('returns missing=true (exit 1) when nothing is installed', async () => {
    const id = firstWorkflowId();

    await expect(invoke(templatesDiffCommand, { id, project: tempRoot })).rejects.toThrow(
      /__EXIT__:1/,
    );

    expect(mockCliOutput).toHaveBeenCalledOnce();
    const [data] = mockCliOutput.mock.calls[0]!;
    const payload = data as { same: boolean; missing: boolean; diff: string };
    expect(payload.same).toBe(false);
    expect(payload.missing).toBe(true);
    expect(payload.diff.length).toBeGreaterThan(0);
  });

  it('returns same=false (exit 1) when the deployed file drifted', async () => {
    const id = firstWorkflowId();
    const entry = getTemplateManifest().find((e) => e.id === id)!;
    const installPath = join(tempRoot, entry.installPath);
    mkdirSync(dirname(installPath), { recursive: true });
    writeFileSync(installPath, 'totally different content\n', 'utf8');

    await expect(invoke(templatesDiffCommand, { id, project: tempRoot })).rejects.toThrow(
      /__EXIT__:1/,
    );

    expect(mockCliOutput).toHaveBeenCalledOnce();
    const [data] = mockCliOutput.mock.calls[0]!;
    const payload = data as { same: boolean; missing: boolean; diff: string };
    expect(payload.same).toBe(false);
    expect(payload.missing).toBe(false);
    expect(payload.diff.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// cleo templates upgrade
// ---------------------------------------------------------------------------

describe('cleo templates upgrade', () => {
  it('overwrites a drifted file for overwrite-on-bump strategy', async () => {
    const entry = getTemplateManifest().find((e) => e.updateStrategy === 'overwrite-on-bump');
    if (!entry) throw new Error('no overwrite-on-bump entries registered — registry shape changed');
    const installPath = join(tempRoot, entry.installPath);
    mkdirSync(dirname(installPath), { recursive: true });
    writeFileSync(installPath, 'drifted content\n', 'utf8');

    await invoke(templatesUpgradeCommand, { id: entry.id, project: tempRoot });

    expect(mockCliOutput).toHaveBeenCalledOnce();
    const [data] = mockCliOutput.mock.calls[0]!;
    const payload = data as { outcome: string };
    expect(payload.outcome).toBe('overwritten');

    const renderedSource = readFileSync(resolveSourcePathAbsolute(entry), 'utf8');
    expect(readFileSync(installPath, 'utf8')).toBe(renderedSource);
  });

  it('returns noop when the deployed file already matches', async () => {
    const entry = getTemplateManifest().find((e) => e.updateStrategy === 'overwrite-on-bump');
    if (!entry) throw new Error('no overwrite-on-bump entries registered');
    await invoke(templatesInstallCommand, { id: entry.id, project: tempRoot });
    mockCliOutput.mockClear();

    await invoke(templatesUpgradeCommand, { id: entry.id, project: tempRoot });

    expect(mockCliOutput).toHaveBeenCalledOnce();
    const [data] = mockCliOutput.mock.calls[0]!;
    const payload = data as { outcome: string };
    expect(payload.outcome).toBe('noop');
  });

  it('skips an immutable strategy entry even when drift exists', async () => {
    const entry = getTemplateManifest().find((e) => e.updateStrategy === 'immutable');
    if (!entry) {
      return; // No immutable entries registered — skip rather than fail.
    }
    const installPath = join(tempRoot, entry.installPath);
    mkdirSync(dirname(installPath), { recursive: true });
    writeFileSync(installPath, 'user-customised content\n', 'utf8');

    await invoke(templatesUpgradeCommand, { id: entry.id, project: tempRoot });

    expect(mockCliOutput).toHaveBeenCalledOnce();
    const [data] = mockCliOutput.mock.calls[0]!;
    const payload = data as { outcome: string };
    expect(payload.outcome).toBe('skipped');
    expect(readFileSync(installPath, 'utf8')).toBe('user-customised content\n');
  });

  it('respects --diff as preview-only (no write)', async () => {
    const entry = getTemplateManifest().find((e) => e.updateStrategy === 'overwrite-on-bump');
    if (!entry) throw new Error('no overwrite-on-bump entries registered');
    const installPath = join(tempRoot, entry.installPath);
    mkdirSync(dirname(installPath), { recursive: true });
    writeFileSync(installPath, 'drifted content\n', 'utf8');

    await invoke(templatesUpgradeCommand, { id: entry.id, project: tempRoot, diff: true });

    expect(mockCliOutput).toHaveBeenCalledOnce();
    const [data] = mockCliOutput.mock.calls[0]!;
    const payload = data as { outcome: string; diff: string };
    expect(payload.outcome).toBe('skipped');
    expect(payload.diff.length).toBeGreaterThan(0);
    expect(readFileSync(installPath, 'utf8')).toBe('drifted content\n');
  });
});

// ---------------------------------------------------------------------------
// cleo templates validate
// ---------------------------------------------------------------------------

describe('cleo templates validate', () => {
  it('returns ok=true when every source path resolves', async () => {
    await invoke(templatesValidateCommand, { project: tempRoot });

    expect(mockCliOutput).toHaveBeenCalledOnce();
    const [data] = mockCliOutput.mock.calls[0]!;
    const payload = data as { ok: boolean; count: number; entries: unknown[] };
    expect(payload.ok).toBe(true);
    expect(payload.count).toBeGreaterThan(0);
    expect(payload.entries.length).toBe(payload.count);
  });

  it('reports installed=false for a fresh project root', async () => {
    const id = firstWorkflowId();
    await invoke(templatesValidateCommand, { id, project: tempRoot });

    expect(mockCliOutput).toHaveBeenCalledOnce();
    const [data] = mockCliOutput.mock.calls[0]!;
    const payload = data as {
      ok: boolean;
      entries: Array<{ id: string; installed: boolean; sourceExists: boolean }>;
    };
    expect(payload.ok).toBe(true);
    expect(payload.entries).toHaveLength(1);
    expect(payload.entries[0]?.id).toBe(id);
    expect(payload.entries[0]?.sourceExists).toBe(true);
    expect(payload.entries[0]?.installed).toBe(false);
  });

  it('returns E_NOT_FOUND when --id is unknown', async () => {
    await expect(
      invoke(templatesValidateCommand, { id: 'definitely-not-a-template', project: tempRoot }),
    ).rejects.toThrow(/__EXIT__:4/);

    expect(mockCliError).toHaveBeenCalledOnce();
    const [, , details] = mockCliError.mock.calls[0]!;
    expect(details).toMatchObject({ name: 'E_NOT_FOUND' });
  });
});
