/**
 * `--no-<flag>` regression tests for the commands that call core directly
 * rather than through dispatch (T12528).
 *
 * citty parses `--no-<name>` as `{ <name>: false }` and never sets
 * `'no-<name>'`, so each of these handlers — which read `args['no-<name>']` —
 * silently ignored its opt-out. Every case parses REAL argv with citty's own
 * `parseArgs` against the command's real `args` definition, runs the real
 * handler, and asserts on what reached the (mocked) core boundary.
 *
 * @task T12528
 */

import { type ArgsDef, type CommandDef, parseArgs } from 'citty';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Core boundary mocks
// ---------------------------------------------------------------------------

const mockRunPrGate = vi.fn();
const mockCheckAllRegisteredProjects = vi.fn();
const mockRunUpgrade = vi.fn();
const mockCheckStorageMigration = vi.fn();
const mockSurveyDbSubstrate = vi.fn();
const mockCreateDocsViewerSubsystem = vi.fn();
const mockGetViewerStatus = vi.fn();
const mockSpawn = vi.fn();

vi.mock('@cleocode/core/internal', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@cleocode/core/internal')>()),
  runPrGate: (...a: unknown[]) => mockRunPrGate(...a),
  formatPrGateSummary: () => '',
  checkAllRegisteredProjects: (...a: unknown[]) => mockCheckAllRegisteredProjects(...a),
  nexusList: async () => [],
  runUpgrade: (...a: unknown[]) => mockRunUpgrade(...a),
  checkStorageMigration: (...a: unknown[]) => mockCheckStorageMigration(...a),
}));

vi.mock('@cleocode/core/doctor/db-substrate.js', () => ({
  surveyDbSubstrate: (...a: unknown[]) => mockSurveyDbSubstrate(...a),
  surveyFleetDbSubstrate: (...a: unknown[]) => mockSurveyDbSubstrate(...a),
}));

vi.mock('../../docs-viewer-subsystem.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../docs-viewer-subsystem.js')>()),
  createDocsViewerSubsystem: (...a: unknown[]) => mockCreateDocsViewerSubsystem(...a),
  getViewerStatus: (...a: unknown[]) => mockGetViewerStatus(...a),
  getViewerPaths: () => ({ pidFile: '/tmp/viewer.pid' }),
}));

vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  spawn: (...a: unknown[]) => mockSpawn(...a),
}));

vi.mock('../../../dispatch/adapters/cli.js', () => ({
  dispatchFromCli: vi.fn(),
  dispatchRaw: vi.fn(),
  handleRawError: vi.fn(),
  maybeEmitDescribe: () => false,
}));

vi.mock('../../renderers/index.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../renderers/index.js')>()),
  cliOutput: vi.fn(),
  cliError: vi.fn(),
  humanLine: vi.fn(),
  humanInfo: vi.fn(),
  humanWarn: vi.fn(),
}));

import { checkCommand } from '../check.js';
import { docsViewerSubcommands } from '../docs-viewer.js';
import { doctorDbSubstrateCommand } from '../doctor-db-substrate.js';
import { doctorProjectsCommand } from '../doctor-projects.js';
import { selfUpdateCommand } from '../self-update.js';
import { upgradeCommand } from '../upgrade.js';

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

/** Minimal runnable command shape. */
interface RunnableCommand {
  args?: ArgsDef;
  run?: (ctx: { args: unknown; rawArgs: string[]; cmd: unknown }) => Promise<void> | void;
  subCommands?: Record<string, RunnableCommand>;
}

/** Parse argv with citty against the command's real args and run its handler. */
async function runParsed(root: CommandDef | RunnableCommand, argv: string[], path: string[] = []) {
  let cmd = root as RunnableCommand;
  for (const name of path) {
    const next = cmd.subCommands?.[name];
    if (!next) throw new Error(`subcommand ${path.join(' ')} missing`);
    cmd = next;
  }
  if (!cmd.args || !cmd.run) throw new Error('command has no args/run');
  const args = parseArgs(argv, cmd.args);
  await cmd.run({ args, rawArgs: argv, cmd });
}

/** First argument of the first call to a mock. */
function firstArg(mock: ReturnType<typeof vi.fn>, index = 0): Record<string, unknown> {
  const call = mock.mock.calls[0];
  if (!call) throw new Error('mock was not called');
  return call[index] as Record<string, unknown>;
}

const EMPTY_HEALTH = { projects: [], global: undefined, summary: {} };
const UPGRADE_OK = {
  success: true,
  upToDate: true,
  dryRun: false,
  actions: [],
  applied: 0,
  errors: [],
  summary: {},
};

let stdoutSpy: ReturnType<typeof vi.spyOn>;
let stderrSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.clearAllMocks();
  stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  mockRunPrGate.mockReturnValue({ passed: true, summary: '', gates: [], repoRoot: '/r' });
  mockCheckAllRegisteredProjects.mockResolvedValue(EMPTY_HEALTH);
  mockRunUpgrade.mockResolvedValue(UPGRADE_OK);
  mockCheckStorageMigration.mockReturnValue({ migrationNeeded: false, summary: 'ok', fix: '' });
  mockSurveyDbSubstrate.mockImplementation(() => {
    throw new Error('STOP_AFTER_CAPTURE');
  });
  mockCreateDocsViewerSubsystem.mockReturnValue({
    start: async () => ({ pid: 1, port: 4000, host: '127.0.0.1' }),
  });
  mockGetViewerStatus.mockResolvedValue({
    running: true,
    pid: 1,
    port: 4000,
    host: '127.0.0.1',
  });
  mockSpawn.mockReturnValue({ unref: () => undefined });
});

afterEach(() => {
  stdoutSpy.mockRestore();
  stderrSpy.mockRestore();
  process.exitCode = undefined;
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('cleo check pr --no-keep-going', () => {
  it('passes keepGoing: false to the PR gate', async () => {
    await runParsed(checkCommand, ['--no-keep-going'], ['pr']);
    expect(firstArg(mockRunPrGate)['keepGoing']).toBe(false);
  });

  it('passes keepGoing: true without the flag', async () => {
    await runParsed(checkCommand, [], ['pr']);
    expect(firstArg(mockRunPrGate)['keepGoing']).toBe(true);
  });
});

describe('cleo doctor-projects --no-update-registry', () => {
  it('asks core not to write the registry', async () => {
    await runParsed(doctorProjectsCommand, ['--no-update-registry', '--json']);
    expect(firstArg(mockCheckAllRegisteredProjects)['updateRegistry']).toBe(false);
  });

  it('writes the registry without the flag', async () => {
    await runParsed(doctorProjectsCommand, ['--json']);
    expect(firstArg(mockCheckAllRegisteredProjects)['updateRegistry']).toBe(true);
  });
});

describe('cleo doctor db-substrate --no-quarantine', () => {
  it('disables auto-quarantine', async () => {
    await expect(runParsed(doctorDbSubstrateCommand, ['--no-quarantine'])).rejects.toThrow(
      'STOP_AFTER_CAPTURE',
    );
    expect(firstArg(mockSurveyDbSubstrate, 1)['autoQuarantine']).toBe(false);
  });

  it('auto-quarantines without the flag', async () => {
    await expect(runParsed(doctorDbSubstrateCommand, [])).rejects.toThrow('STOP_AFTER_CAPTURE');
    expect(firstArg(mockSurveyDbSubstrate, 1)['autoQuarantine']).toBe(true);
  });
});

describe('cleo upgrade --no-auto-migrate', () => {
  it('passes autoMigrate: false to core', async () => {
    await runParsed(upgradeCommand, ['--no-auto-migrate', '--json']);
    expect(firstArg(mockRunUpgrade)['autoMigrate']).toBe(false);
  });

  it('passes autoMigrate: true without the flag', async () => {
    await runParsed(upgradeCommand, ['--json']);
    expect(firstArg(mockRunUpgrade)['autoMigrate']).toBe(true);
  });
});

describe('cleo self-update --post-update --no-auto-upgrade', () => {
  it('skips the post-update structural upgrade', async () => {
    await runParsed(selfUpdateCommand, [
      '--post-update',
      '--no-auto-upgrade',
      '--no-check-projects',
      '--json',
    ]);
    expect(mockRunUpgrade).not.toHaveBeenCalled();
  });

  it('runs the post-update structural upgrade without the flag', async () => {
    await runParsed(selfUpdateCommand, ['--post-update', '--no-check-projects', '--json']);
    expect(mockRunUpgrade).toHaveBeenCalledTimes(1);
  });
});

describe('cleo docs serve --no-auto-port', () => {
  it('passes noAutoPort: true to the viewer subsystem', async () => {
    await runParsed(
      { subCommands: docsViewerSubcommands } as RunnableCommand,
      ['--no-auto-port'],
      ['serve'],
    );
    expect(firstArg(mockCreateDocsViewerSubsystem)['noAutoPort']).toBe(true);
  });

  it('passes noAutoPort: false without the flag', async () => {
    await runParsed({ subCommands: docsViewerSubcommands } as RunnableCommand, [], ['serve']);
    expect(firstArg(mockCreateDocsViewerSubsystem)['noAutoPort']).toBe(false);
  });
});

describe('cleo docs open --no-launch', () => {
  it('does not launch a browser', async () => {
    await runParsed(
      { subCommands: docsViewerSubcommands } as RunnableCommand,
      ['--no-launch'],
      ['open'],
    );
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it('launches a browser without the flag', async () => {
    await runParsed({ subCommands: docsViewerSubcommands } as RunnableCommand, [], ['open']);
    expect(mockSpawn).toHaveBeenCalledTimes(1);
  });
});
