/**
 * Unit tests for T365: cleo restore finalize subcommand.
 *
 * All tests operate on a temporary directory — no real CLEO project,
 * tasks.db, brain.db, or conduit.db is ever touched.
 *
 * Test matrix (parser unit tests):
 *   - Parses a manual-review field with Resolution: manual-review
 *   - Parses a manual field resolved to B
 *   - Parses a manual field resolved to A
 *   - Parses nested dot-path field (brain.embeddingProvider)
 *   - Parses auto-section fields as section: auto
 *
 * Test matrix (integration — finalize action):
 *   - No restore-conflicts.md → logs advisory, exits 0
 *   - Unresolved manual-review fields only → prints instruction, does not archive
 *   - Manual field resolved to B → applies imported value, archives report
 *   - Manual field resolved to A → applies local value, archives report
 *   - Archives report with *.md.finalized name after applying
 *   - Sets nested field path brain.embeddingProvider correctly
 *   - Skips still-unresolved fields when others are resolved
 *
 * @task T365
 * @epic T311
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Top-level module mock — must be at top level so Vitest hoists it correctly.
// We use importOriginal to preserve all other exports.
// ---------------------------------------------------------------------------

vi.mock('@cleocode/core/internal', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@cleocode/core/internal')>();
  return {
    ...actual,
    // getProjectRoot will be set per-test via the mockGetProjectRoot reference
    getProjectRoot: () => mockGetProjectRoot(),
  };
});

// Mutable reference that individual tests override
let mockGetProjectRoot: () => string = () => os.tmpdir();

// ---------------------------------------------------------------------------
// Console capture
// ---------------------------------------------------------------------------

let consoleOutput: string[] = [];
let consoleErrors: string[] = [];

beforeEach(() => {
  consoleOutput = [];
  consoleErrors = [];
  vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    consoleOutput.push(args.map(String).join(' '));
  });
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    consoleErrors.push(args.map(String).join(' '));
  });
  process.exitCode = undefined;
});

afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = undefined;
});

// ---------------------------------------------------------------------------
// Imports of the modules under test (after mocks are established)
// ---------------------------------------------------------------------------

import { ShimCommand as Command } from '../../commander-shim.js';
import { parseConflictReport, registerRestoreCommand } from '../restore.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a temp directory and point the mock getProjectRoot there. */
function makeTmpProject(): { root: string; cleoDir: string; cleanup: () => void } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cleo-t365-'));
  const cleoDir = path.join(root, '.cleo');
  fs.mkdirSync(cleoDir, { recursive: true });
  mockGetProjectRoot = () => root;

  function cleanup(): void {
    fs.rmSync(root, { recursive: true, force: true });
    mockGetProjectRoot = () => os.tmpdir();
  }

  return { root, cleoDir, cleanup };
}

/**
 * Extract the `restore finalize` action from a freshly-registered command tree
 * and invoke it directly.  This mirrors the approach used in backup-inspect.test.ts
 * to avoid relying on parseAsync (which ShimCommand does not implement).
 */
function getFinalizeAction(): () => Promise<void> {
  const program = new Command();
  registerRestoreCommand(program);

  const restoreCmd = program._subcommands.find((c) => c._name === 'restore');
  if (!restoreCmd) throw new Error('restore command not registered');

  const finalizeCmd = restoreCmd._subcommands.find((c) => c._name === 'finalize');
  if (!finalizeCmd) throw new Error('restore finalize subcommand not registered');

  if (!finalizeCmd._action) throw new Error('restore finalize has no action registered');

  return finalizeCmd._action as () => Promise<void>;
}

async function runFinalizeAction(): Promise<void> {
  await getFinalizeAction()();
}

// ---------------------------------------------------------------------------
// Conflict report fixture builders
// ---------------------------------------------------------------------------

/** Report with one UNRESOLVED manual-review field. */
function makeReportUnresolved(): string {
  return [
    '## config.json',
    '',
    '### Resolved (auto-applied)',
    '',
    '### Manual review needed',
    '',
    '- `hooks.customPreCommit`',
    '  - Local (A): _(not present)_',
    '  - Imported (B): `"./scripts/pre-commit.sh"`',
    '  - Resolution: **manual-review**',
    '  - Rationale: unclassified field — needs human review',
    '',
  ].join('\n');
}

/** Report with one manual field resolved to B. */
function makeReportResolvedToB(): string {
  return [
    '## config.json',
    '',
    '### Resolved (auto-applied)',
    '',
    '### Manual review needed',
    '',
    '- `hooks.customPreCommit`',
    '  - Local (A): _(not present)_',
    '  - Imported (B): `"./scripts/pre-commit.sh"`',
    '  - Resolution: **B**',
    '  - Rationale: unclassified field — needs human review',
    '',
  ].join('\n');
}

/** Report with one manual field resolved to A. */
function makeReportResolvedToA(): string {
  return [
    '## config.json',
    '',
    '### Manual review needed',
    '',
    '- `hooks.customPreCommit`',
    '  - Local (A): `"./scripts/local.sh"`',
    '  - Imported (B): `"./scripts/pre-commit.sh"`',
    '  - Resolution: **A**',
    '  - Rationale: keep local script',
    '',
  ].join('\n');
}

/** Report with nested field resolved to B. */
function makeReportNestedField(): string {
  return [
    '## config.json',
    '',
    '### Manual review needed',
    '',
    '- `brain.embeddingProvider`',
    '  - Local (A): `"local"`',
    '  - Imported (B): `"openai"`',
    '  - Resolution: **B**',
    '  - Rationale: user intent — preserve from source',
    '',
  ].join('\n');
}

/** Report with zero manual-review fields (only auto section). */
function makeReportNoManual(): string {
  return [
    '## config.json',
    '',
    '### Resolved (auto-applied)',
    '',
    '- `logLevel`',
    '  - Local (A): `"info"`',
    '  - Imported (B): `"debug"`',
    '  - Resolution: **A**',
    '  - Rationale: auto-resolved',
    '',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// parseConflictReport unit tests
// ---------------------------------------------------------------------------

describe('parseConflictReport', () => {
  it('parses a manual-review field with Resolution: manual-review', () => {
    const result = parseConflictReport(makeReportUnresolved());
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      section: 'manual',
      filename: 'config.json',
      fieldPath: 'hooks.customPreCommit',
      resolution: 'manual-review',
    });
  });

  it('parses a manual field resolved to B', () => {
    const result = parseConflictReport(makeReportResolvedToB());
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      section: 'manual',
      filename: 'config.json',
      fieldPath: 'hooks.customPreCommit',
      resolution: 'B',
      importedValue: './scripts/pre-commit.sh',
    });
  });

  it('parses a manual field resolved to A', () => {
    const result = parseConflictReport(makeReportResolvedToA());
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      section: 'manual',
      filename: 'config.json',
      fieldPath: 'hooks.customPreCommit',
      resolution: 'A',
      localValue: './scripts/local.sh',
    });
  });

  it('parses nested field path brain.embeddingProvider', () => {
    const result = parseConflictReport(makeReportNestedField());
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      fieldPath: 'brain.embeddingProvider',
      localValue: 'local',
      importedValue: 'openai',
      resolution: 'B',
    });
  });

  it('parses auto-section fields as section: auto', () => {
    const result = parseConflictReport(makeReportNoManual());
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      section: 'auto',
      fieldPath: 'logLevel',
      resolution: 'A',
    });
  });
});

// ---------------------------------------------------------------------------
// Integration tests: restore finalize action
// ---------------------------------------------------------------------------

describe('restore finalize', () => {
  it('logs advisory and exits 0 when no restore-conflicts.md exists', async () => {
    const { cleanup } = makeTmpProject();
    try {
      await runFinalizeAction();
      expect(consoleOutput.join('\n')).toContain('No pending restore conflicts');
      expect(process.exitCode).toBeFalsy();
    } finally {
      cleanup();
    }
  });

  it('prints instruction and does NOT archive when manual field is still unresolved', async () => {
    const { cleoDir, cleanup } = makeTmpProject();
    try {
      const reportPath = path.join(cleoDir, 'restore-conflicts.md');
      fs.writeFileSync(reportPath, makeReportUnresolved());

      await runFinalizeAction();

      // Report should still exist (not archived)
      expect(fs.existsSync(reportPath)).toBe(true);
      const finalizedFiles = fs.readdirSync(cleoDir).filter((f) => f.endsWith('.finalized'));
      expect(finalizedFiles).toHaveLength(0);

      const out = consoleOutput.join('\n');
      expect(out).toContain('No manual resolutions found');
      expect(out).toContain('cleo restore finalize');
    } finally {
      cleanup();
    }
  });

  it('applies a manual field resolved to B and archives the report', async () => {
    const { cleoDir, cleanup } = makeTmpProject();
    try {
      const reportPath = path.join(cleoDir, 'restore-conflicts.md');
      fs.writeFileSync(reportPath, makeReportResolvedToB());

      const configPath = path.join(cleoDir, 'config.json');
      fs.writeFileSync(configPath, JSON.stringify({ logLevel: 'info' }, null, 2));

      await runFinalizeAction();

      // Report should be gone
      expect(fs.existsSync(reportPath)).toBe(false);

      // An archived file should exist
      const finalizedFiles = fs.readdirSync(cleoDir).filter((f) => f.endsWith('.finalized'));
      expect(finalizedFiles.length).toBeGreaterThanOrEqual(1);

      // config.json should have the imported B value applied
      const config = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as Record<string, unknown>;
      const hooks = config['hooks'] as Record<string, unknown> | undefined;
      expect(hooks?.['customPreCommit']).toBe('./scripts/pre-commit.sh');

      // Output should mention finalized count
      const out = consoleOutput.join('\n');
      expect(out).toContain('Finalized 1 conflict resolutions');
    } finally {
      cleanup();
    }
  });

  it('applies a manual field resolved to A (keeps local value)', async () => {
    const { cleoDir, cleanup } = makeTmpProject();
    try {
      const reportPath = path.join(cleoDir, 'restore-conflicts.md');
      fs.writeFileSync(reportPath, makeReportResolvedToA());

      const configPath = path.join(cleoDir, 'config.json');
      fs.writeFileSync(
        configPath,
        JSON.stringify({ hooks: { customPreCommit: './local.sh' } }, null, 2),
      );

      await runFinalizeAction();

      expect(fs.existsSync(reportPath)).toBe(false);
      const config = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as Record<string, unknown>;
      const hooks = config['hooks'] as Record<string, unknown> | undefined;
      expect(hooks?.['customPreCommit']).toBe('./scripts/local.sh');
    } finally {
      cleanup();
    }
  });

  it('archives the report to *.md.finalized after applying resolutions', async () => {
    const { cleoDir, cleanup } = makeTmpProject();
    try {
      const reportPath = path.join(cleoDir, 'restore-conflicts.md');
      fs.writeFileSync(reportPath, makeReportResolvedToB());

      const configPath = path.join(cleoDir, 'config.json');
      fs.writeFileSync(configPath, JSON.stringify({}, null, 2));

      await runFinalizeAction();

      expect(fs.existsSync(reportPath)).toBe(false);
      const archived = fs.readdirSync(cleoDir).filter((f) => f.endsWith('.finalized'));
      expect(archived.length).toBe(1);
      expect(archived[0]).toMatch(/^restore-conflicts-.+\.md\.finalized$/);
    } finally {
      cleanup();
    }
  });

  it('sets nested field path brain.embeddingProvider correctly', async () => {
    const { cleoDir, cleanup } = makeTmpProject();
    try {
      const reportPath = path.join(cleoDir, 'restore-conflicts.md');
      fs.writeFileSync(reportPath, makeReportNestedField());

      const configPath = path.join(cleoDir, 'config.json');
      fs.writeFileSync(
        configPath,
        JSON.stringify({ brain: { embeddingProvider: 'local' } }, null, 2),
      );

      await runFinalizeAction();

      expect(fs.existsSync(reportPath)).toBe(false);
      const config = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as Record<string, unknown>;
      const brain = config['brain'] as Record<string, unknown> | undefined;
      expect(brain?.['embeddingProvider']).toBe('openai');
    } finally {
      cleanup();
    }
  });

  it('applies only resolved fields and archives when mixed resolved/unresolved', async () => {
    const { cleoDir, cleanup } = makeTmpProject();
    try {
      const mixed = [
        '## config.json',
        '',
        '### Manual review needed',
        '',
        '- `hooks.customPreCommit`',
        '  - Local (A): _(not present)_',
        '  - Imported (B): `"./scripts/pre-commit.sh"`',
        '  - Resolution: **B**',
        '  - Rationale: resolved',
        '',
        '- `hooks.postCommit`',
        '  - Local (A): _(not present)_',
        '  - Imported (B): `"./scripts/post-commit.sh"`',
        '  - Resolution: **manual-review**',
        '  - Rationale: still undecided',
        '',
      ].join('\n');

      const reportPath = path.join(cleoDir, 'restore-conflicts.md');
      fs.writeFileSync(reportPath, mixed);

      const configPath = path.join(cleoDir, 'config.json');
      fs.writeFileSync(configPath, JSON.stringify({}, null, 2));

      await runFinalizeAction();

      // Report should be archived (we applied what was resolved)
      expect(fs.existsSync(reportPath)).toBe(false);
      const config = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as Record<string, unknown>;
      const hooks = config['hooks'] as Record<string, unknown> | undefined;
      // Resolved field applied
      expect(hooks?.['customPreCommit']).toBe('./scripts/pre-commit.sh');
      // Still-pending field NOT applied
      expect(hooks?.['postCommit']).toBeUndefined();

      const out = consoleOutput.join('\n');
      expect(out).toContain('Finalized 1 conflict resolutions');
    } finally {
      cleanup();
    }
  });
});
