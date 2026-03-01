/**
 * Tests for shared injection functions in src/core/injection.ts.
 *
 * Covers:
 *   - getInjectionTemplateContent(): template lookup from package root
 *   - ensureInjection(): full injection refresh with CAAMP mocking
 *   - checkInjection(): injection health checks (markers, refs, etc.)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import { existsSync } from 'node:fs';

// Mock scaffold.ts to control getPackageRoot and stripCLEOBlocks
vi.mock('../scaffold.js', () => ({
  getPackageRoot: vi.fn(() => '/mock-package-root'),
  stripCLEOBlocks: vi.fn(async () => {}),
}));

// Mock paths.js for getCleoHome
vi.mock('../paths.js', () => ({
  getCleoHome: vi.fn(() => '/mock-cleo-home'),
}));

import { getInjectionTemplateContent, checkInjection, ensureInjection } from '../injection.js';
import { getPackageRoot } from '../scaffold.js';

// ── getInjectionTemplateContent ──────────────────────────────────────

describe('getInjectionTemplateContent', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'cleo-inj-template-'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('returns content string when template exists in package', async () => {
    // Point getPackageRoot to our temp dir and create the template
    vi.mocked(getPackageRoot).mockReturnValue(tempDir);
    const templatesDir = join(tempDir, 'templates');
    await mkdir(templatesDir, { recursive: true });
    await writeFile(join(templatesDir, 'CLEO-INJECTION.md'), '# CLEO Protocol\nTest content');

    const result = getInjectionTemplateContent();
    expect(result).toBe('# CLEO Protocol\nTest content');
  });

  it('returns null when template not found', () => {
    // Point getPackageRoot to a directory without the template
    vi.mocked(getPackageRoot).mockReturnValue('/nonexistent-path');

    const result = getInjectionTemplateContent();
    expect(result).toBeNull();
  });
});

// ── checkInjection ──────────────────────────────────────────────────

describe('checkInjection', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'cleo-inj-check-'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('returns warning when AGENTS.md is missing', () => {
    const result = checkInjection(tempDir);
    expect(result.status).toBe('warning');
    expect(result.message).toContain('AGENTS.md not found');
  });

  it('returns warning when AGENTS.md has no CAAMP markers', async () => {
    await writeFile(join(tempDir, 'AGENTS.md'), '# Just a plain file\nNo markers here.');

    const result = checkInjection(tempDir);
    expect(result.status).toBe('warning');
    expect(result.message).toContain('no CAAMP markers');
  });

  it('returns warning when CAAMP markers are unbalanced', async () => {
    // One START, no END
    await writeFile(
      join(tempDir, 'AGENTS.md'),
      '<!-- CAAMP:START -->\n@some-ref\n',
    );

    const result = checkInjection(tempDir);
    expect(result.status).toBe('warning');
    expect(result.message).toContain('unbalanced');
    expect(result.details).toHaveProperty('startCount', 1);
    expect(result.details).toHaveProperty('endCount', 0);
  });

  it('returns warning when @ reference targets do not exist', async () => {
    await writeFile(
      join(tempDir, 'AGENTS.md'),
      '<!-- CAAMP:START -->\n@nonexistent-file.md\n<!-- CAAMP:END -->\n',
    );

    const result = checkInjection(tempDir);
    expect(result.status).toBe('warning');
    expect(result.message).toContain('Missing @ reference targets');
    expect(result.details).toHaveProperty('missing');
    expect(result.details['missing']).toContain('nonexistent-file.md');
  });

  it('returns passed when AGENTS.md has balanced markers and refs resolve', async () => {
    // Create the referenced file
    const refFile = join(tempDir, 'local-ref.md');
    await writeFile(refFile, '# Referenced content');

    await writeFile(
      join(tempDir, 'AGENTS.md'),
      '<!-- CAAMP:START -->\n@local-ref.md\n<!-- CAAMP:END -->\n',
    );

    const result = checkInjection(tempDir);
    expect(result.status).toBe('passed');
    expect(result.message).toContain('healthy');
    expect(result.fix).toBeNull();
  });

  it('returns passed with tilde refs that resolve', async () => {
    // Use a ~ ref that points to a real file (homedir-relative)
    const cleoTemplatesDir = join(homedir(), '.cleo', 'templates');
    const templateExists = existsSync(join(cleoTemplatesDir, 'CLEO-INJECTION.md'));

    if (templateExists) {
      await writeFile(
        join(tempDir, 'AGENTS.md'),
        '<!-- CAAMP:START -->\n@~/.cleo/templates/CLEO-INJECTION.md\n<!-- CAAMP:END -->\n',
      );

      const result = checkInjection(tempDir);
      expect(result.status).toBe('passed');
    }
    // If the file doesn't exist on the test machine, skip gracefully
  });

  it('returns warning when CLAUDE.md has unbalanced CAAMP markers', async () => {
    // Valid AGENTS.md
    const refFile = join(tempDir, 'ref.md');
    await writeFile(refFile, 'content');
    await writeFile(
      join(tempDir, 'AGENTS.md'),
      '<!-- CAAMP:START -->\n@ref.md\n<!-- CAAMP:END -->\n',
    );

    // CLAUDE.md with unbalanced markers
    await writeFile(
      join(tempDir, 'CLAUDE.md'),
      '<!-- CAAMP:START -->\n@AGENTS.md\n',
    );

    const result = checkInjection(tempDir);
    expect(result.status).toBe('warning');
    expect(result.message).toContain('CLAUDE.md CAAMP markers unbalanced');
  });

  it('returns warning when CLAUDE.md has no CAAMP markers', async () => {
    const refFile = join(tempDir, 'ref.md');
    await writeFile(refFile, 'content');
    await writeFile(
      join(tempDir, 'AGENTS.md'),
      '<!-- CAAMP:START -->\n@ref.md\n<!-- CAAMP:END -->\n',
    );

    await writeFile(join(tempDir, 'CLAUDE.md'), '# No markers here');

    const result = checkInjection(tempDir);
    expect(result.status).toBe('warning');
    expect(result.message).toContain('CLAUDE.md has no CAAMP markers');
  });
});

// ── ensureInjection ─────────────────────────────────────────────────

describe('ensureInjection', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'cleo-inj-ensure-'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('returns skipped when @cleocode/caamp is not installed', async () => {
    // By default, the dynamic import of @cleocode/caamp will fail
    // since we haven't mocked it at the module level for ensureInjection.
    // We need to make the dynamic import throw.
    vi.mock('@cleocode/caamp', () => {
      throw new Error('Cannot find module @cleocode/caamp');
    });

    // Re-import to pick up the mock — but since ensureInjection uses
    // dynamic import(), we need to handle this differently.
    // The vi.mock above will make `import('@cleocode/caamp')` throw.
    const result = await ensureInjection(tempDir);
    expect(result.action).toBe('skipped');
    expect(result.details).toContain('not installed');
    expect(result.path).toBe(join(tempDir, 'AGENTS.md'));
  });

  it('returns skipped when no providers are detected', async () => {
    // Mock CAAMP with no providers
    vi.doMock('@cleocode/caamp', () => ({
      getInstalledProviders: vi.fn(() => []),
      inject: vi.fn(),
      injectAll: vi.fn(),
      buildInjectionContent: vi.fn(),
    }));

    // Re-import to pick up the doMock
    const { ensureInjection: freshEnsure } = await import('../injection.js');
    const result = await freshEnsure(tempDir);
    expect(result.action).toBe('skipped');
    expect(result.details).toContain('No AI agent providers detected');
  });

  it('returns result with action when providers exist', async () => {
    const providers = [
      { id: 'claude', name: 'Claude Code', instructionFile: 'CLAUDE.md', pathProject: '', instructFile: 'CLAUDE.md' },
    ];

    vi.doMock('@cleocode/caamp', () => ({
      getInstalledProviders: vi.fn(() => providers),
      injectAll: vi.fn(async () => new Map([[join(tempDir, 'CLAUDE.md'), 'injected']])),
      inject: vi.fn(async () => 'injected'),
      buildInjectionContent: vi.fn(({ references }: { references: string[] }) => references.join('\n')),
    }));

    // Create the CLAUDE.md so stripCLEOBlocks has a file to work with
    await writeFile(join(tempDir, 'CLAUDE.md'), '# Claude');

    const { ensureInjection: freshEnsure } = await import('../injection.js');
    const result = await freshEnsure(tempDir);
    expect(result.action).toBe('repaired');
    expect(result.path).toBe(join(tempDir, 'AGENTS.md'));
    expect(result.details).toBeDefined();
  });
});
