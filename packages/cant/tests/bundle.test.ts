/**
 * Unit tests for {@link compileBundle} — the CANT bundle compiler.
 *
 * @remarks
 * These tests exercise the full pipeline: parse → validate → extract → render.
 * They use the canonical `.cant` fixtures from `crates/cant-core/tests/fixtures/`
 * as well as inline temporary files to test edge cases.
 *
 * Vitest with describe/it blocks per project conventions.
 */

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { compileBundle } from '../src/bundle';

/** Temporary directory for test fixtures created at runtime. */
let testDir: string;

/** Resolve paths relative to this test file, not cwd. */
const THIS_DIR = typeof __dirname !== 'undefined' ? __dirname : dirname(fileURLToPath(import.meta.url));

/** Path to the cant-core fixtures directory (works regardless of cwd). */
const FIXTURES_DIR = resolve(THIS_DIR, '..', '..', '..', 'crates', 'cant-core', 'tests', 'fixtures');

/**
 * Create a temporary `.cant` file with the given content.
 *
 * @param name - File name (e.g., `"test-agent.cant"`).
 * @param content - Raw CANT file content.
 * @returns Absolute path to the created file.
 */
function createFixture(name: string, content: string): string {
  const filePath = join(testDir, name);
  writeFileSync(filePath, content, 'utf-8');
  return filePath;
}

beforeAll(() => {
  testDir = join(tmpdir(), `cant-bundle-test-${Date.now()}`);
  mkdirSync(testDir, { recursive: true });
});

afterAll(() => {
  try {
    rmSync(testDir, { recursive: true, force: true });
  } catch {
    // Best effort cleanup
  }
});

describe('compileBundle', () => {
  it('returns a valid empty bundle when given an empty file list', async () => {
    const bundle = await compileBundle([]);

    expect(bundle.documents.size).toBe(0);
    expect(bundle.agents).toEqual([]);
    expect(bundle.teams).toEqual([]);
    expect(bundle.tools).toEqual([]);
    expect(bundle.diagnostics).toEqual([]);
    expect(bundle.valid).toBe(true);
  });

  it('extracts agent entry from a single agent .cant file', async () => {
    const agentFile = join(FIXTURES_DIR, 'jit-backend-dev.cant');
    const bundle = await compileBundle([agentFile]);

    expect(bundle.documents.size).toBe(1);
    expect(bundle.agents.length).toBe(1);

    const agent = bundle.agents[0];
    expect(agent).toBeDefined();
    expect(agent!.name).toBe('backend-dev');
    expect(agent!.sourcePath).toBe(agentFile);
    expect(agent!.properties['role']).toBe('worker');
    expect(agent!.properties['tier']).toBe('mid');
  });

  it('collects diagnostics for files that fail to parse', async () => {
    const badFile = createFixture('bad-syntax.cant', `---
kind: agent
version: 1
---

this is not valid cant syntax {{{ }}}`);

    const bundle = await compileBundle([badFile]);

    expect(bundle.documents.size).toBe(1);
    expect(bundle.valid).toBe(false);
    expect(bundle.diagnostics.length).toBeGreaterThan(0);

    const errorDiags = bundle.diagnostics.filter(d => d.severity === 'error');
    expect(errorDiags.length).toBeGreaterThan(0);
    expect(errorDiags[0]!.sourcePath).toBe(badFile);
  });

  it('preserves line and column for parse errors', async () => {
    // A file with a clearly malformed body so the parser emits a positioned error.
    const badFile = createFixture('bad-position.cant', `---
kind: agent
version: 1
---

this is not valid cant syntax {{{ }}}`);

    const bundle = await compileBundle([badFile]);
    const parseDiags = bundle.diagnostics.filter(d => d.ruleId === 'parse');
    expect(parseDiags.length).toBeGreaterThan(0);

    // At least one parse diagnostic must carry a usable 1-based position.
    // Line/col are optional (file-read failures have none), but for a successfully
    // read-but-unparseable file the native binding always emits coordinates.
    const positioned = parseDiags.find(d => typeof d.line === 'number' && typeof d.col === 'number');
    expect(positioned).toBeDefined();
    expect(positioned!.line).toBeGreaterThanOrEqual(1);
    expect(positioned!.col).toBeGreaterThanOrEqual(1);
  });

  it('collects diagnostics for files that fail validation', async () => {
    // jit-backend-dev.cant has 3 validation errors (S13, T01)
    const agentFile = join(FIXTURES_DIR, 'jit-backend-dev.cant');
    const bundle = await compileBundle([agentFile]);

    expect(bundle.documents.size).toBe(1);
    // The file parses successfully but has validation errors
    expect(bundle.valid).toBe(false);
    expect(bundle.diagnostics.length).toBeGreaterThan(0);

    // Check that validation diagnostics have proper rule IDs
    const validationDiags = bundle.diagnostics.filter(d => d.ruleId !== 'parse');
    expect(validationDiags.length).toBeGreaterThan(0);
  });

  it('preserves line and column for validation diagnostics', async () => {
    const agentFile = join(FIXTURES_DIR, 'jit-backend-dev.cant');
    const bundle = await compileBundle([agentFile]);

    const validationDiags = bundle.diagnostics.filter(d => d.ruleId !== 'parse');
    expect(validationDiags.length).toBeGreaterThan(0);

    // Every validation diagnostic from the 42-rule engine must carry 1-based line/col.
    for (const diag of validationDiags) {
      expect(typeof diag.line).toBe('number');
      expect(typeof diag.col).toBe('number');
      expect(diag.line!).toBeGreaterThanOrEqual(1);
      expect(diag.col!).toBeGreaterThanOrEqual(1);
    }
  });

  it('omits line and column for file-level read failures', async () => {
    // Non-existent files produce a file-read diagnostic with no source position.
    const nonexistentFile = join(testDir, 'truly-missing.cant');
    const bundle = await compileBundle([nonexistentFile]);
    const parseDiags = bundle.diagnostics.filter(d => d.ruleId === 'parse');
    expect(parseDiags.length).toBeGreaterThan(0);
    // The file-read failure diagnostic has no line/col
    const readFailure = parseDiags.find(d => d.message.includes('Failed to read'));
    expect(readFailure).toBeDefined();
    expect(readFailure!.line).toBeUndefined();
    expect(readFailure!.col).toBeUndefined();
  });

  it('handles a non-existent file gracefully', async () => {
    const nonexistentFile = join(testDir, 'does-not-exist.cant');
    const bundle = await compileBundle([nonexistentFile]);

    expect(bundle.documents.size).toBe(1);
    expect(bundle.valid).toBe(false);
    expect(bundle.diagnostics.length).toBeGreaterThan(0);
    expect(bundle.diagnostics[0]!.severity).toBe('error');
    expect(bundle.agents).toEqual([]);
  });

  it('compiles multiple files and aggregates agents', async () => {
    const agent1 = createFixture('agent-one.cant', `---
kind: agent
version: 1
---

agent test-agent-one:
  role: worker
  tier: mid
`);

    const agent2 = createFixture('agent-two.cant', `---
kind: agent
version: 1
---

agent test-agent-two:
  role: lead
  tier: senior
`);

    const bundle = await compileBundle([agent1, agent2]);

    expect(bundle.documents.size).toBe(2);
    expect(bundle.agents.length).toBe(2);

    const names = bundle.agents.map(a => a.name).sort();
    expect(names).toEqual(['test-agent-one', 'test-agent-two']);
  });

  it('extracts parent property from agent declarations', async () => {
    const agentFile = join(FIXTURES_DIR, 'jit-backend-dev.cant');
    const bundle = await compileBundle([agentFile]);

    const agent = bundle.agents[0];
    expect(agent).toBeDefined();
    expect(agent!.properties['parent']).toBe('engineering-lead');
  });

  it('sets document kind from the parsed AST', async () => {
    const agentFile = join(FIXTURES_DIR, 'jit-backend-dev.cant');
    const bundle = await compileBundle([agentFile]);

    const doc = bundle.documents.get(agentFile);
    expect(doc).toBeDefined();
    expect(doc!.kind).toBe('Agent');
  });
});

describe('compileBundle renderSystemPrompt', () => {
  it('returns an empty string for an empty bundle', async () => {
    const bundle = await compileBundle([]);
    const prompt = bundle.renderSystemPrompt();

    expect(prompt).toBe('');
  });

  it('produces markdown containing agent names', async () => {
    const agentFile = join(FIXTURES_DIR, 'jit-backend-dev.cant');
    const bundle = await compileBundle([agentFile]);
    const prompt = bundle.renderSystemPrompt();

    expect(prompt).toContain('backend-dev');
    expect(prompt).toContain('## CANT Bundle');
    expect(prompt).toContain('### Agents');
    expect(prompt).toContain('worker');
    expect(prompt).toContain('mid');
  });

  it('includes a validation warning when bundle is invalid', async () => {
    const agentFile = join(FIXTURES_DIR, 'jit-backend-dev.cant');
    const bundle = await compileBundle([agentFile]);

    // jit-backend-dev.cant has validation errors
    expect(bundle.valid).toBe(false);
    const prompt = bundle.renderSystemPrompt();
    expect(prompt).toContain('Warning');
    expect(prompt).toContain('validation error');
  });

  it('renders multiple agents from a multi-file bundle', async () => {
    const agent1 = createFixture('render-agent-a.cant', `---
kind: agent
version: 1
---

agent render-alpha:
  role: worker
  tier: junior
`);

    const agent2 = createFixture('render-agent-b.cant', `---
kind: agent
version: 1
---

agent render-beta:
  role: lead
  tier: senior
`);

    const bundle = await compileBundle([agent1, agent2]);
    const prompt = bundle.renderSystemPrompt();

    expect(prompt).toContain('render-alpha');
    expect(prompt).toContain('render-beta');
    expect(prompt).toContain('worker');
    expect(prompt).toContain('lead');
  });
});
