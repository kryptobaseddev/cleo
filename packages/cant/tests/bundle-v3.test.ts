/**
 * Integration tests for T889 Wave 1:
 * - W1-2: `toCantAgentV3` typed-agent projection + `TypedAgentEntry.typed`
 *   population inside {@link compileBundle}.
 * - W1-4: `S-TODO-001` linter — rejects agents whose `prompt`, `tone`, or
 *   `enforcement` fields contain literal `TODO` stubs and flips
 *   `CompiledBundle.valid` to `false`.
 *
 * @remarks
 * Tests drive `compileBundle` over real `.cant` files on disk — no mocks.
 * Long-lived seed fixtures under `packages/agents/seed-agents/` and the
 * canonical `jit-backend-dev.cant` provide the positive baseline; synthetic
 * fixtures written to `tmpdir()` provide the S-TODO-001 negative case
 * because seed files are curated and must not ship with TODO placeholders.
 */

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  type AgentEntry,
  compileBundle,
  toCantAgentV3,
} from '../src/bundle.js';

/** Resolve paths relative to this test file, not cwd. */
const THIS_DIR =
  typeof __dirname !== 'undefined' ? __dirname : dirname(fileURLToPath(import.meta.url));

/**
 * Canonical CLEO-persona directory (SSoT for v1/v2 agent definitions).
 *
 * Post-T1237: the cleo-historian/dev/prime personas are project-specific
 * and live under `.cleo/cant/agents/` (project tier per T889). The v1/v2
 * fixture coverage is driven from there because the generic templates in
 * `packages/agents/seed-agents/` carry `{{placeholder}}` variables that
 * would fail type checks before substitution.
 */
const SEED_DIR = resolve(THIS_DIR, '..', '..', '..', '.cleo', 'cant', 'agents');

/** `cant-core` fixture directory — contains the v3 exemplar `jit-backend-dev.cant`. */
const FIXTURES_DIR = resolve(
  THIS_DIR,
  '..',
  '..',
  '..',
  'crates',
  'cant-core',
  'tests',
  'fixtures',
);

/** Scratch directory for tests that synthesize throwaway `.cant` files. */
let testDir: string;

beforeAll(() => {
  testDir = join(tmpdir(), `cant-bundle-v3-test-${Date.now()}`);
  mkdirSync(testDir, { recursive: true });
});

afterAll(() => {
  try {
    rmSync(testDir, { recursive: true, force: true });
  } catch {
    // Best effort cleanup.
  }
});

/**
 * Create a temporary `.cant` file with the given content and return its
 * absolute path.
 */
function createFixture(name: string, content: string): string {
  const filePath = join(testDir, name);
  writeFileSync(filePath, content, 'utf-8');
  return filePath;
}

describe('W1-2 toCantAgentV3 + W1-4 TODO-stub linter', () => {
  it('populates .typed on a v1/v2 seed agent with backward-compat defaults', async () => {
    const bundle = await compileBundle([resolve(SEED_DIR, 'cleo-historian.cant')]);

    expect(bundle.agents.length).toBe(1);
    const agent = bundle.agents[0]!;

    expect(agent.name).toBe('cleo-historian');
    expect(agent.typed).not.toBeNull();
    const typed = agent.typed!;

    // v1/v2 seed files do not declare tier — default is 'mid'.
    expect(typed.tier).toBe('mid');
    // Defaults for fields the seed file omits.
    expect(typed.contracts).toEqual({ requires: [], ensures: [] });
    expect(typed.contextSources).toEqual([]);
    expect(typed.onOverflow).toBe('escalate_tier');
    expect(typed.mentalModelRef).toBeNull();
    // Declared fields flow through correctly.
    expect(typed.role).toBe('specialist');
    expect(typed.parent).toBe('cleo-prime');
    expect(typed.sourcePath).toBe(resolve(SEED_DIR, 'cleo-historian.cant'));
    // permissions are joined from the domain-access AST shape.
    expect(typed.permissions['tasks']).toBe('read');
    expect(typed.permissions['memory']).toBe('read, write');

    // No S-TODO-001 diagnostics on a curated seed file.
    const todoDiags = bundle.diagnostics.filter((d) => d.ruleId === 'S-TODO-001');
    expect(todoDiags.length).toBe(0);
  });

  it('parses the canonical v3 exemplar (jit-backend-dev) with typed projection', async () => {
    const exemplar = resolve(FIXTURES_DIR, 'jit-backend-dev.cant');
    const bundle = await compileBundle([exemplar]);

    expect(bundle.agents.length).toBe(1);
    const agent = bundle.agents[0]!;
    expect(agent.typed).not.toBeNull();
    const typed = agent.typed!;

    expect(typed.name).toBe('backend-dev');
    expect(typed.role).toBe('worker');
    // This fixture declares `tier: mid` explicitly — mapper must honor it.
    expect(typed.tier).toBe('mid');
    // Fixture declares `on_overflow: escalate_tier`.
    expect(typed.onOverflow).toBe('escalate_tier');
    // prompt is a ProseBlock — mapper joins lines.
    expect(typed.prompt).toContain('backend developer');
    // skills array flows through.
    expect(typed.skills).toContain('ct-task-executor');

    // Mapper cannot reconstruct the Wave 0 dict-flattened context_sources AST
    // today, so contextSources defaults to [] — the surface remains stable
    // once the grammar grows nested-dict support.
    expect(Array.isArray(typed.contextSources)).toBe(true);
  });

  it('rejects agents with TODO stubs in prompt/tone/enforcement fields via S-TODO-001', async () => {
    const stubFile = createFixture(
      'stub-agent.cant',
      `---
kind: agent
version: 2
---

agent stub-worker:
  role: worker
  tier: mid
  description: "Worker with placeholder content"

  tone: "TODO: Describe how this agent communicates."

  prompt: "TODO: Write the core behavioral instruction."

  enforcement: "TODO: List the rules this agent enforces."

  skills: [ct-cleo]

  permissions:
    tasks: read
`,
    );

    const bundle = await compileBundle([stubFile]);

    const todoDiags = bundle.diagnostics.filter((d) => d.ruleId === 'S-TODO-001');
    // Three fields carry TODO — expect one diagnostic per field.
    expect(todoDiags.length).toBe(3);
    for (const d of todoDiags) {
      expect(d.severity).toBe('error');
      expect(d.sourcePath).toBe(stubFile);
      expect(d.message).toContain('stub-worker');
    }
    const fieldsMentioned = todoDiags.map((d) => d.message).join(' | ');
    expect(fieldsMentioned).toContain("'prompt'");
    expect(fieldsMentioned).toContain("'tone'");
    expect(fieldsMentioned).toContain("'enforcement'");

    // valid flips to false when any S-TODO-001 is raised.
    expect(bundle.valid).toBe(false);
  });

  it('does not raise S-TODO-001 for agents whose fields never mention TODO', async () => {
    const cleanFile = createFixture(
      'clean-agent.cant',
      `---
kind: agent
version: 2
---

agent clean-worker:
  role: worker
  tier: high
  description: "Fully-specified worker"

  tone: "Direct, assertive, evidence-based"

  prompt: "You are a test worker. Run tests and report pass/fail with commit SHA."

  skills: [ct-cleo]

  permissions:
    tasks: read
    memory: read, write
`,
    );

    const bundle = await compileBundle([cleanFile]);

    const todoDiags = bundle.diagnostics.filter((d) => d.ruleId === 'S-TODO-001');
    expect(todoDiags.length).toBe(0);
    expect(bundle.valid).toBe(true);

    const typed = bundle.agents[0]!.typed!;
    expect(typed.tier).toBe('high');
    expect(typed.prompt).toContain('test worker');
  });

  it('toCantAgentV3 returns null for an AgentEntry with no name', () => {
    const entry: AgentEntry = {
      name: '',
      sourcePath: '/tmp/does-not-exist.cant',
      properties: {},
    };
    expect(toCantAgentV3(entry, entry.sourcePath)).toBeNull();
  });

  it('toCantAgentV3 applies defaults on a minimal AgentEntry', () => {
    const entry: AgentEntry = {
      name: 'minimal',
      sourcePath: '/tmp/minimal.cant',
      properties: {},
    };
    const typed = toCantAgentV3(entry, entry.sourcePath);
    expect(typed).not.toBeNull();
    expect(typed!.tier).toBe('mid');
    expect(typed!.onOverflow).toBe('escalate_tier');
    expect(typed!.contracts).toEqual({ requires: [], ensures: [] });
    expect(typed!.contextSources).toEqual([]);
    expect(typed!.mentalModelRef).toBeNull();
    expect(typed!.skills).toEqual([]);
    expect(typed!.permissions).toEqual({});
    expect(typed!.version).toBe('1');
  });

  it('toCantAgentV3 clamps invalid tier values back to the default', () => {
    const entry: AgentEntry = {
      name: 'bad-tier',
      sourcePath: '/tmp/bad-tier.cant',
      properties: { tier: 'platinum' },
    };
    const typed = toCantAgentV3(entry, entry.sourcePath);
    expect(typed!.tier).toBe('mid');
  });

  it('toCantAgentV3 extracts list-form context_sources when declared', () => {
    const entry: AgentEntry = {
      name: 'list-sources',
      sourcePath: '/tmp/list-sources.cant',
      properties: {
        context_sources: [
          { source: 'patterns', query: 'coding conventions', maxEntries: 5 },
          { source: 'learnings', query: 'past mistakes', max_entries: 3 },
        ],
      },
    };
    const typed = toCantAgentV3(entry, entry.sourcePath);
    expect(typed!.contextSources).toEqual([
      { source: 'patterns', query: 'coding conventions', maxEntries: 5 },
      { source: 'learnings', query: 'past mistakes', maxEntries: 3 },
    ]);
  });
});
