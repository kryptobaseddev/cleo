/**
 * E2E test: injection chain validation after init.
 *
 * Verifies the new AGENTS.md hub injection architecture:
 * 1. Provider files (CLAUDE.md, GEMINI.md) reference @AGENTS.md
 * 2. AGENTS.md references @~/.cleo/templates/CLEO-INJECTION.md
 * 3. No references to @.cleo/templates/AGENT-INJECTION.md anywhere
 * 4. No CLEO:START markers anywhere (CAAMP uses CAAMP:START/END)
 *
 * Since CAAMP functions depend on actual provider installations,
 * they are mocked via vi.mock to isolate the init logic.
 *
 * @task T4694
 * @epic T4663
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { existsSync } from 'node:fs';

// Mock @cleocode/caamp to avoid requiring actual provider installations
vi.mock('@cleocode/caamp', () => {
  const providers = [
    { id: 'claude', name: 'Claude Code', instructionFile: 'CLAUDE.md', pathProject: '', instructFile: 'CLAUDE.md' },
    { id: 'gemini', name: 'Gemini CLI', instructionFile: 'GEMINI.md', pathProject: '', instructFile: 'GEMINI.md' },
  ];

  return {
    getInstalledProviders: vi.fn(() => providers),
    // injectAll writes @AGENTS.md into provider instruction files
    injectAll: vi.fn(async (_providers: unknown[], projectRoot: string, _scope: string, content: string) => {
      const { writeFile: wf } = await import('node:fs/promises');
      const { join: pjoin } = await import('node:path');
      const { existsSync: exists, readFileSync } = await import('node:fs');
      const results = new Map<string, string>();

      for (const p of providers) {
        const filePath = pjoin(projectRoot, p.instructionFile);
        let existing = '';
        if (exists(filePath)) {
          existing = readFileSync(filePath, 'utf-8');
        }
        // Write CAAMP marker block with the content
        const newContent = `<!-- CAAMP:START -->\n${content}\n<!-- CAAMP:END -->\n${existing}`;
        await wf(filePath, newContent);
        results.set(filePath, 'injected');
      }
      return results;
    }),
    // inject writes CLEO content into a specific file (AGENTS.md)
    inject: vi.fn(async (filePath: string, content: string) => {
      const { writeFile: wf } = await import('node:fs/promises');
      const { existsSync: exists, readFileSync } = await import('node:fs');
      let existing = '';
      if (exists(filePath)) {
        existing = readFileSync(filePath, 'utf-8');
      }
      const newContent = `<!-- CAAMP:START -->\n${content}\n<!-- CAAMP:END -->\n${existing}`;
      await wf(filePath, newContent);
      return 'injected';
    }),
    // buildInjectionContent returns the content string passed to injectAll
    buildInjectionContent: vi.fn(({ references }: { references: string[] }) => references.join('\n')),
    installMcpServerToAll: vi.fn(async () => []),
    installSkill: vi.fn(async () => ({ success: true })),
    getCanonicalSkillsDir: vi.fn(() => '/mock/.agents/skills'),
    parseSkillFile: vi.fn(async () => null),
    discoverSkill: vi.fn(async () => null),
    discoverSkills: vi.fn(async () => []),
    installBatchWithRollback: vi.fn(async () => ({ success: true, results: [], rolledBack: false })),
    configureProviderGlobalAndProject: vi.fn(async () => ({ global: { success: true }, project: { success: true } })),
  };
});

// Mock nexus to avoid side effects
vi.mock('../nexus/registry.js', () => ({
  nexusInit: vi.fn(async () => {}),
  nexusRegister: vi.fn(async () => {}),
}));

import { initProject } from '../init.js';

describe('E2E: injection chain validation (T4694)', () => {
  let testDir: string;
  let origCwd: string;
  let origCleoDir: string | undefined;
  let origCleoHome: string | undefined;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), 'cleo-injection-chain-'));
    origCwd = process.cwd();
    origCleoDir = process.env['CLEO_DIR'];
    origCleoHome = process.env['CLEO_HOME'];
    process.chdir(testDir);
    process.env['CLEO_DIR'] = join(testDir, '.cleo');
    // Use a temp CLEO_HOME so we don't write to real ~/.cleo
    process.env['CLEO_HOME'] = join(testDir, '.cleo-home');
  });

  afterEach(async () => {
    process.chdir(origCwd);
    if (origCleoDir !== undefined) {
      process.env['CLEO_DIR'] = origCleoDir;
    } else {
      delete process.env['CLEO_DIR'];
    }
    if (origCleoHome !== undefined) {
      process.env['CLEO_HOME'] = origCleoHome;
    } else {
      delete process.env['CLEO_HOME'];
    }
    await rm(testDir, { recursive: true, force: true });
  });

  it('initProject creates provider files referencing @AGENTS.md', async () => {
    await initProject({ name: 'chain-test' });

    // CLAUDE.md should exist and reference @AGENTS.md
    const claudePath = join(testDir, 'CLAUDE.md');
    expect(existsSync(claudePath)).toBe(true);
    const claudeContent = await readFile(claudePath, 'utf-8');
    expect(claudeContent).toContain('@AGENTS.md');

    // GEMINI.md should exist and reference @AGENTS.md
    const geminiPath = join(testDir, 'GEMINI.md');
    expect(existsSync(geminiPath)).toBe(true);
    const geminiContent = await readFile(geminiPath, 'utf-8');
    expect(geminiContent).toContain('@AGENTS.md');
  });

  it('AGENTS.md references @~/.cleo/templates/CLEO-INJECTION.md', async () => {
    await initProject({ name: 'chain-test' });

    const agentsPath = join(testDir, 'AGENTS.md');
    expect(existsSync(agentsPath)).toBe(true);
    const agentsContent = await readFile(agentsPath, 'utf-8');
    expect(agentsContent).toContain('@~/.cleo/templates/CLEO-INJECTION.md');
  });

  it('no references to @.cleo/templates/AGENT-INJECTION.md in generated files', async () => {
    await initProject({ name: 'chain-test' });

    const filesToCheck = ['CLAUDE.md', 'GEMINI.md', 'AGENTS.md'];
    for (const file of filesToCheck) {
      const filePath = join(testDir, file);
      if (existsSync(filePath)) {
        const content = await readFile(filePath, 'utf-8');
        expect(content).not.toContain('@.cleo/templates/AGENT-INJECTION.md');
      }
    }
  });

  it('no CLEO:START markers in generated files', async () => {
    await initProject({ name: 'chain-test' });

    const filesToCheck = ['CLAUDE.md', 'GEMINI.md', 'AGENTS.md'];
    for (const file of filesToCheck) {
      const filePath = join(testDir, file);
      if (existsSync(filePath)) {
        const content = await readFile(filePath, 'utf-8');
        expect(content).not.toContain('CLEO:START');
      }
    }
  });

  it('CAAMP:START markers are used for injection blocks', async () => {
    await initProject({ name: 'chain-test' });

    // Provider files should use CAAMP markers (via CAAMP library)
    const claudePath = join(testDir, 'CLAUDE.md');
    if (existsSync(claudePath)) {
      const content = await readFile(claudePath, 'utf-8');
      expect(content).toContain('CAAMP:START');
      expect(content).toContain('CAAMP:END');
    }
  });

  it('initProject returns injection entries in created list', async () => {
    const result = await initProject({ name: 'chain-test' });
    expect(result.initialized).toBe(true);

    // Check that injection-related entries appear in created
    const createdStr = result.created.join(', ');
    expect(createdStr).toContain('injection');
    expect(createdStr).toContain('AGENTS.md');
  });

  it('injection chain: provider -> AGENTS.md -> CLEO-INJECTION.md', async () => {
    await initProject({ name: 'chain-test' });

    // Verify the full chain:
    // CLAUDE.md -> @AGENTS.md (via injectAll)
    const claudeContent = await readFile(join(testDir, 'CLAUDE.md'), 'utf-8');
    expect(claudeContent).toContain('@AGENTS.md');

    // AGENTS.md -> @~/.cleo/templates/CLEO-INJECTION.md (via inject)
    const agentsContent = await readFile(join(testDir, 'AGENTS.md'), 'utf-8');
    expect(agentsContent).toContain('@~/.cleo/templates/CLEO-INJECTION.md');

    // Neither should reference the old AGENT-INJECTION.md pattern
    expect(claudeContent).not.toContain('AGENT-INJECTION.md');
    expect(agentsContent).not.toContain('AGENT-INJECTION.md');
  });

  it('updateDocs refreshes injection without full reinit', async () => {
    // First init
    await initProject({ name: 'chain-test' });

    // Verify files exist after init
    expect(existsSync(join(testDir, 'CLAUDE.md'))).toBe(true);
    expect(existsSync(join(testDir, 'AGENTS.md'))).toBe(true);

    // Run updateDocs mode
    const result = await initProject({ updateDocs: true });
    expect(result.updateDocsOnly).toBe(true);
    expect(result.initialized).toBe(true);
  });
});
