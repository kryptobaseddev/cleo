/**
 * Tests for the T9888 `cleo init --workflows` deprecation alias.
 *
 * Verifies that:
 *   1. The handler writes the deprecation warning to stderr pointing at the
 *      canonical `cleo templates install --kind workflow` surface (T9886).
 *   2. The handler still installs workflows into `<projectRoot>/.github/workflows/`
 *      (behaviour preserved through the deprecation window).
 *   3. The handler resolves its workflow set through the SSoT template
 *      registry (`getTemplatesByKind('workflow')`).
 *
 * @task T9888
 * @saga T9855
 * @adr 076
 */

import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock the renderer so cliOutput / cliError do not actually print and become
// observable spies (matches the pattern used by the templates suite).
const mockCliOutput = vi.fn();
const mockCliError = vi.fn();
vi.mock('../../renderers/index.js', () => ({
  cliOutput: (...args: unknown[]) => mockCliOutput(...args),
  cliError: (...args: unknown[]) => mockCliError(...args),
}));

// Spy on the registry surface so the test can assert the handler walked the
// SSoT — the mock must wrap (not replace) the real impl so substitution
// continues to render real workflow templates underneath.
const registryActual = await vi.importActual<typeof import('@cleocode/core/templates/registry')>(
  '@cleocode/core/templates/registry',
);
const mockGetTemplatesByKind = vi.fn(registryActual.getTemplatesByKind);
vi.mock('@cleocode/core/templates/registry', async () => {
  const actual = await vi.importActual<typeof import('@cleocode/core/templates/registry')>(
    '@cleocode/core/templates/registry',
  );
  return {
    ...actual,
    getTemplatesByKind: (...args: Parameters<typeof actual.getTemplatesByKind>) =>
      mockGetTemplatesByKind(...args),
  };
});

// Import AFTER the mocks so the handler closes over the spies.
import { initCommand } from '../init.js';

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
let cwdSpy: ReturnType<typeof vi.spyOn>;
let stderrSpy: ReturnType<typeof vi.spyOn>;
const stderrWrites: string[] = [];

beforeEach(() => {
  tempRoot = mkdtempSync(join(tmpdir(), 'cleo-init-workflows-test-'));
  vi.clearAllMocks();
  stderrWrites.length = 0;
  cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(tempRoot);
  stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(((
    chunk: string | Uint8Array,
  ) => {
    stderrWrites.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf-8'));
    return true;
  }) as never);
});

afterEach(() => {
  cwdSpy.mockRestore();
  stderrSpy.mockRestore();
  if (tempRoot) rmSync(tempRoot, { recursive: true, force: true });
});

describe('cleo init --workflows (T9888 deprecation alias)', () => {
  it('writes the deprecation warning to stderr', async () => {
    await invoke(initCommand, { workflows: true, 'dry-run': true });

    const joined = stderrWrites.join('');
    expect(joined).toMatch(/\[deprecated\]/);
    expect(joined).toMatch(/cleo init --workflows/);
    expect(joined).toMatch(/cleo templates install --kind workflow/);
    expect(joined).toMatch(/v2026\.7\.0/);
  });

  it('still installs workflows into .github/workflows/', async () => {
    await invoke(initCommand, { workflows: true });

    // Behaviour preserved — the four canonical release workflows land on disk
    // under the temp project root.
    const workflowsDir = join(tempRoot, '.github', 'workflows');
    expect(existsSync(join(workflowsDir, 'release-prepare.yml'))).toBe(true);
    expect(existsSync(join(workflowsDir, 'release-publish.yml'))).toBe(true);
    expect(existsSync(join(workflowsDir, 'release-fanout.yml'))).toBe(true);
    expect(existsSync(join(workflowsDir, 'release-rollback.yml'))).toBe(true);
    expect(mockCliOutput).toHaveBeenCalled();
    expect(mockCliError).not.toHaveBeenCalled();
  });

  it("resolves the workflow set through getTemplatesByKind('workflow')", async () => {
    await invoke(initCommand, { workflows: true, 'dry-run': true });

    expect(mockGetTemplatesByKind).toHaveBeenCalled();
    const calledWithWorkflow = mockGetTemplatesByKind.mock.calls.some(
      (call) => call[0] === 'workflow',
    );
    expect(calledWithWorkflow).toBe(true);
  });
});
