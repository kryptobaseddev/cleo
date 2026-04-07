/**
 * Fixture validation tests for canonical CLEO `.cant` agent files.
 *
 * These tests do not exercise any TypeScript runtime code path — they
 * only verify that the on-disk `.cleo/agents/*.cant` files conform to
 * the canonical CANT grammar (PascalCase event names, two-space
 * indentation, discretion `**...**` delimiters, no tabs, etc.) so the
 * Rust parser can ingest them via napi-rs without surprises.
 *
 * Originally lived under `packages/core/src/cant/__tests__/` alongside
 * the now-deleted parallel core cant namespace. Moved here when the
 * Option Y collapse removed that namespace so the fixture tests keep
 * running and continue to guard the canonical agent files.
 *
 * @see docs/specs/CANT-DSL-SPEC.md Section 2 (Grammar)
 * @see ../../../.cleo/agents/cleo-historian.cant
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('CLEO canonical .cant agent fixtures', () => {
  const AGENTS_DIR = join(process.cwd(), '.cleo', 'agents');

  // BLOCKED: cant-napi does not yet export parse_document (only Layer 1
  // cant_parse). Once cant-napi extends parse_document, remove the .skip
  // from these tests so the napi pipeline gets coverage.
  it.skip('parses cleo-historian.cant through napi bridge', () => {
    const content = readFileSync(join(AGENTS_DIR, 'cleo-historian.cant'), 'utf-8');
    expect(content.length).toBeGreaterThan(0);
    // Awaiting cantParseDocument export from cant-napi.
  });

  it.skip('parses cleo-rust-lead.cant through napi bridge', () => {
    const content = readFileSync(join(AGENTS_DIR, 'cleo-rust-lead.cant'), 'utf-8');
    expect(content.length).toBeGreaterThan(0);
    // Awaiting cantParseDocument export from cant-napi.
  });

  it('cleo-historian.cant exists on disk and declares the expected hooks', () => {
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

  it('cleo-historian.cant uses canonical CANT grammar elements', () => {
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
