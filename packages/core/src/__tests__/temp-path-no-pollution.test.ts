/**
 * T9020 regression tests: CAAMP writer must NOT inject temp-path blocks
 * into the real ~/.agents/AGENTS.md when CLEO_HOME is a temp directory.
 *
 * Root cause (T9020 / T1929):
 *   `ensureInjection()` called `getCleoTemplatesTildePath()` which reads
 *   `CLEO_HOME`. Tests set `CLEO_HOME` to a temp dir. `getAgentsHome()`
 *   is NOT overridden by tests, so the real `~/.agents/AGENTS.md` was
 *   written with the temp-path reference on every test run. Since T1939's
 *   dedup-by-path only deduplicates blocks with IDENTICAL content, each
 *   unique temp path produced a new block — 37 stale blocks observed in
 *   production.
 *
 * Fix (T9020):
 *   The global hub write in `ensureInjection()` and `injectAgentsHub()`
 *   now uses `getCanonicalTemplatesTildePath()` which always returns
 *   `"~/.cleo/templates"` — the stable symlink path that is immune to
 *   `CLEO_HOME` overrides.
 *
 * @task T9020
 * @epic T1929
 */

import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ── Top-level mocks (hoisted by Vitest) ──────────────────────────────────────

vi.mock('@cleocode/caamp', () => {
  const fakeInject = vi.fn(async (filePath: string, content: string) => {
    const { mkdir: mk } = await import('node:fs/promises');
    const { dirname } = await import('node:path');
    const { existsSync: exists } = await import('node:fs');
    const { readFile: rf, writeFile: wf } = await import('node:fs/promises');

    await mk(dirname(filePath), { recursive: true });

    if (!exists(filePath)) {
      await wf(filePath, `<!-- CAAMP:START -->\n${content}\n<!-- CAAMP:END -->\n`);
      return 'created';
    }

    const existing = await rf(filePath, 'utf-8');
    const MARKER_PATTERN = /<!-- CAAMP:START -->[\s\S]*?<!-- CAAMP:END -->/g;
    const matches = existing.match(MARKER_PATTERN);
    if (matches && matches.length > 0) {
      const existingBlock = existing
        .match(/<!-- CAAMP:START -->([\s\S]*?)<!-- CAAMP:END -->/)?.[1]
        ?.trim();
      if (existingBlock === content.trim()) return 'intact';
      const updated = existing.replace(
        /<!-- CAAMP:START -->[\s\S]*?<!-- CAAMP:END -->/,
        `<!-- CAAMP:START -->\n${content}\n<!-- CAAMP:END -->`,
      );
      await wf(filePath, updated);
      return 'updated';
    }

    await wf(filePath, `<!-- CAAMP:START -->\n${content}\n<!-- CAAMP:END -->\n${existing}`);
    return 'added';
  });

  return {
    getInstalledProviders: vi.fn(() => []),
    inject: fakeInject,
    injectAll: vi.fn(async () => new Map()),
    buildInjectionContent: vi.fn(({ references }: { references: string[] }) =>
      references.join('\n'),
    ),
  };
});

vi.mock('../scaffold.js', () => ({
  getPackageRoot: vi.fn(() => '/mock-package-root'),
  stripCLEOBlocks: vi.fn(async () => {}),
  ensureGlobalHome: vi.fn(async () => {}),
}));

vi.mock('../nexus/registry.js', () => ({
  nexusInit: vi.fn(async () => {}),
  nexusRegister: vi.fn(async () => {}),
}));

// ── Imports (after mocks) ─────────────────────────────────────────────────────

import { getCanonicalTemplatesTildePath } from '../paths.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

function caampBlock(content: string): string {
  return `<!-- CAAMP:START -->\n${content}\n<!-- CAAMP:END -->`;
}

function countCaampBlocks(text: string): number {
  return (text.match(/<!-- CAAMP:START -->/g) ?? []).length;
}

function isTempPath(ref: string): boolean {
  return /\/\.temp\//.test(ref) || /cleo-injection-chain-/.test(ref);
}

// ── getCanonicalTemplatesTildePath (pure unit) ────────────────────────────────

describe('getCanonicalTemplatesTildePath() — immune to CLEO_HOME (T9020)', () => {
  let originalCleoHome: string | undefined;

  beforeEach(() => {
    originalCleoHome = process.env['CLEO_HOME'];
  });

  afterEach(() => {
    if (originalCleoHome === undefined) {
      delete process.env['CLEO_HOME'];
    } else {
      process.env['CLEO_HOME'] = originalCleoHome;
    }
  });

  it('returns the stable ~/.cleo/templates path when CLEO_HOME is unset', () => {
    delete process.env['CLEO_HOME'];
    expect(getCanonicalTemplatesTildePath()).toBe('~/.cleo/templates');
  });

  it('returns the stable ~/.cleo/templates path even when CLEO_HOME is a temp dir', () => {
    process.env['CLEO_HOME'] = join(
      homedir(),
      '.temp',
      'cleo-injection-chain-XXXXXX',
      '.cleo-home',
    );
    expect(getCanonicalTemplatesTildePath()).toBe('~/.cleo/templates');
  });

  it('returns the stable ~/.cleo/templates path even when CLEO_HOME is a custom path', () => {
    process.env['CLEO_HOME'] = '/opt/custom-cleo-home';
    expect(getCanonicalTemplatesTildePath()).toBe('~/.cleo/templates');
  });

  it('produces the canonical @-reference for CLEO-INJECTION.md', () => {
    process.env['CLEO_HOME'] = join(tmpdir(), 'some-random-temp');
    const ref = `@${getCanonicalTemplatesTildePath()}/CLEO-INJECTION.md`;
    expect(ref).toBe('@~/.cleo/templates/CLEO-INJECTION.md');
    expect(isTempPath(ref)).toBe(false);
  });
});

// ── ensureInjection(): temp-path non-pollution (T9020) ────────────────────────

describe('ensureInjection() — hub write uses canonical path, not CLEO_HOME (T9020)', () => {
  let testDir: string;
  let fakeAgentsDir: string;
  let origCleoHome: string | undefined;
  let origAgentsHome: string | undefined;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), 'cleo-t9020-'));
    fakeAgentsDir = join(testDir, 'fake-agents');
    await mkdir(fakeAgentsDir, { recursive: true });

    origCleoHome = process.env['CLEO_HOME'];
    origAgentsHome = process.env['AGENTS_HOME'];

    // Isolate the AGENTS.md write to our temp dir
    process.env['AGENTS_HOME'] = fakeAgentsDir;
  });

  afterEach(async () => {
    if (origCleoHome === undefined) {
      delete process.env['CLEO_HOME'];
    } else {
      process.env['CLEO_HOME'] = origCleoHome;
    }
    if (origAgentsHome === undefined) {
      delete process.env['AGENTS_HOME'];
    } else {
      process.env['AGENTS_HOME'] = origAgentsHome;
    }
    await rm(testDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('writes the canonical @~/.cleo/templates/CLEO-INJECTION.md reference — not a CLEO_HOME-derived temp path', async () => {
    // Simulate a test environment with CLEO_HOME pointing to a temp dir
    const tempCleoHome = join(testDir, '.temp', 'cleo-injection-chain-ABC123', '.cleo-home');
    process.env['CLEO_HOME'] = tempCleoHome;

    const { ensureInjection } = await import('../injection.js');
    await ensureInjection(testDir);

    const agentsMd = join(fakeAgentsDir, 'AGENTS.md');
    expect(existsSync(agentsMd)).toBe(true);

    const content = await readFile(agentsMd, 'utf-8');
    // Must contain the canonical reference
    expect(content).toContain('@~/.cleo/templates/CLEO-INJECTION.md');
    // Must NOT contain any temp-path reference
    expect(content).not.toMatch(/cleo-injection-chain-/);
    expect(content).not.toMatch(/\.temp\//);
  });

  it('5 sequential calls with different CLEO_HOME temp dirs — AGENTS.md ends with exactly 1 block', async () => {
    const tempPaths = [
      join(testDir, '.temp', 'cleo-injection-chain-AAA', '.cleo-home'),
      join(testDir, '.temp', 'cleo-injection-chain-BBB', '.cleo-home'),
      join(testDir, '.temp', 'cleo-injection-chain-CCC', '.cleo-home'),
      join(testDir, '.temp', 'cleo-injection-chain-DDD', '.cleo-home'),
      join(testDir, '.temp', 'cleo-injection-chain-EEE', '.cleo-home'),
    ];

    for (const tempPath of tempPaths) {
      process.env['CLEO_HOME'] = tempPath;
      const { ensureInjection } = await import('../injection.js');
      await ensureInjection(testDir);
    }

    const agentsMd = join(fakeAgentsDir, 'AGENTS.md');
    expect(existsSync(agentsMd)).toBe(true);

    const content = await readFile(agentsMd, 'utf-8');

    // Must have exactly 1 CAAMP block (idempotent)
    expect(countCaampBlocks(content)).toBe(1);

    // Must contain the canonical reference
    expect(content).toContain('@~/.cleo/templates/CLEO-INJECTION.md');

    // Must NOT contain any of the 5 temp-path references
    for (const tempPath of tempPaths) {
      const tildeRef = `@${tempPath.replace(homedir(), '~')}/templates/CLEO-INJECTION.md`;
      expect(content).not.toContain(tildeRef);
    }
    expect(content).not.toMatch(/cleo-injection-chain-/);
  });

  it('pre-existing stale temp-path block is replaced with canonical on next call', async () => {
    const agentsMd = join(fakeAgentsDir, 'AGENTS.md');

    // Simulate what the old (broken) behaviour produced: a stale temp-path block
    const staleTempRef =
      '@~/.temp/cleo-injection-chain-STALE/.cleo-home/templates/CLEO-INJECTION.md';
    await writeFile(agentsMd, caampBlock(staleTempRef) + '\n');

    // Now simulate a new session with the fix in place
    process.env['CLEO_HOME'] = join(testDir, '.temp', 'cleo-injection-chain-NEWTEMP', '.cleo-home');

    const { ensureInjection } = await import('../injection.js');
    await ensureInjection(testDir);

    const content = await readFile(agentsMd, 'utf-8');

    // The canonical block must now be present
    expect(content).toContain('@~/.cleo/templates/CLEO-INJECTION.md');

    // The stale temp-path block content must be gone (replaced, not appended)
    // There should be exactly 1 CAAMP block now
    expect(countCaampBlocks(content)).toBe(1);
  });
});
