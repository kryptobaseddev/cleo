/**
 * Integration test: .cant agent file → cant-napi parse_document → TypeScript AST.
 *
 * This test validates the full pipeline from .cant file on disk through the
 * Rust parser (via napi-rs bridge) to a TypeScript-consumable AST.
 *
 * BLOCKED: cant-napi does not yet export parse_document (only Layer 1 cant_parse).
 * Once cleo-rust-lead extends cant-napi, remove the .skip from these tests.
 *
 * @see docs/specs/CANT-DSL-SPEC.md Section 7.2 (Workflow Execution)
 * @see docs/specs/CANT-EXECUTION-SEMANTICS.md Section 5 (Session Blocking)
 * @see docs/specs/CLEO-ORCH-PLAN.md Section 3.1 (Agent Profile System)
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// BLOCKED: uncomment when cant-napi exports parse_document
// import { cantParseDocument } from 'cant-napi';

describe('CANT Agent .cant File Parsing', () => {
  const AGENTS_DIR = join(process.cwd(), '.cleo', 'agents');

  it.skip('parses cleo-historian.cant through napi bridge', () => {
    const content = readFileSync(join(AGENTS_DIR, 'cleo-historian.cant'), 'utf-8');

    // BLOCKED: cantParseDocument not yet exported from cant-napi
    // const doc = cantParseDocument(content);

    // expect(doc.kind).toBe('agent');
    // expect(doc.sections).toHaveLength(1);

    // const agent = doc.sections[0];
    // expect(agent.type).toBe('Agent');
    // expect(agent.name).toBe('cleo-historian');
    // expect(agent.permissions).toHaveLength(6);
    // expect(agent.hooks).toHaveLength(4); // SessionStart, TaskCompleted, MemoryObserved, PipelineStageCompleted
    // expect(agent.properties.find((p: { key: string }) => p.key === 'model')?.value).toBe('opus');
  });

  it.skip('parses cleo-rust-lead.cant through napi bridge', () => {
    const content = readFileSync(join(AGENTS_DIR, 'cleo-rust-lead.cant'), 'utf-8');

    // BLOCKED: cantParseDocument not yet exported from cant-napi
    // const doc = cantParseDocument(content);

    // expect(doc.kind).toBe('agent');
    // expect(doc.sections[0].name).toBe('cleo-rust-lead');
  });

  it('.cant files exist on disk', () => {
    const historianContent = readFileSync(join(AGENTS_DIR, 'cleo-historian.cant'), 'utf-8');
    expect(historianContent).toContain('kind: agent');
    expect(historianContent).toContain('agent cleo-historian:');
    expect(historianContent).toContain('model: opus');
    expect(historianContent).toContain('permissions:');
    expect(historianContent).toContain('on SessionStart:');
    expect(historianContent).toContain('on TaskCompleted:');
    expect(historianContent).toContain('on MemoryObserved:');
    expect(historianContent).toContain('on PipelineStageCompleted:');
  });

  it('.cant file uses canonical CANT grammar elements', () => {
    const content = readFileSync(join(AGENTS_DIR, 'cleo-historian.cant'), 'utf-8');

    // Frontmatter
    expect(content).toMatch(/^---\nkind: agent\nversion: 1\n---/);

    // Agent block with proper indentation (2 spaces)
    expect(content).toMatch(/^agent cleo-historian:$/m);
    expect(content).toMatch(/^ {2}model: opus$/m);
    expect(content).toMatch(/^ {2}permissions:$/m);
    expect(content).toMatch(/^ {4}tasks: read$/m);
    expect(content).toMatch(/^ {4}memory: read, write$/m);

    // Hook blocks with canonical event names (PascalCase)
    expect(content).toMatch(/^ {2}on SessionStart:$/m);
    expect(content).toMatch(/^ {2}on TaskCompleted:$/m);
    expect(content).toMatch(/^ {2}on MemoryObserved:$/m);
    expect(content).toMatch(/^ {2}on PipelineStageCompleted:$/m);

    // Discretion conditions (** delimiters)
    expect(content).toMatch(/\*\*.+\*\*/);

    // CANT directives in hook bodies
    expect(content).toMatch(/\/checkin @all/);
    expect(content).toMatch(/\/review @cleo-historian/);
    expect(content).toMatch(/\/action @cleo-historian/);

    // No tabs (CANT spec rule: tabs rejected)
    expect(content).not.toMatch(/\t/);
  });
});
