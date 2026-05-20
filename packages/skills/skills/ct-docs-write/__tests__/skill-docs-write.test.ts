/**
 * Regression test for ct-docs-write/SKILL.md (T9641 / Epic T9629 / Saga T9625).
 *
 * Pins the SDK-first writing contract: every new doc MUST flow through
 * `cleo docs add --type X --slug Y` rather than direct filesystem writes.
 * If a future edit drops the SDK section, this test breaks the build so
 * the writing protocol can't silently regress to the deprecated pattern.
 *
 * @task T9641
 * @epic T9629
 * @saga T9625
 */

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const thisFile = fileURLToPath(import.meta.url);
const skillRoot = resolve(dirname(thisFile), '..');
const skillPath = join(skillRoot, 'SKILL.md');
const skillContent = readFileSync(skillPath, 'utf-8');

describe('ct-docs-write SKILL.md — SDK-first contract (T9641)', () => {
  it('teaches `cleo docs add` as the canonical write path', () => {
    expect(skillContent).toContain('cleo docs add');
  });

  it('mentions the closed-set --type taxonomy', () => {
    expect(skillContent).toMatch(/spec\s*\|\s*adr\s*\|\s*research\s*\|\s*handoff\s*\|\s*note\s*\|\s*llm-readme/);
  });

  it('shows --slug as the human-friendly retrieval handle', () => {
    expect(skillContent).toContain('--slug');
    expect(skillContent).toContain('kebab-case');
  });

  it('shows `cleo docs publish --for ... --to ...` for git-tracked publication', () => {
    expect(skillContent).toMatch(/cleo docs publish\s+--for[\s\S]+--to/);
  });

  it('shows `cleo docs fetch` for slug-based retrieval', () => {
    expect(skillContent).toContain('cleo docs fetch');
  });

  it('marks the old direct-filesystem path as deprecated with a migration note', () => {
    expect(skillContent).toContain('Deprecated: Direct filesystem');
    // Migration must point at the SDK
    expect(skillContent).toMatch(/cleo docs (add|sync)/);
  });

  it('references E_SLUG_TAKEN so callers know how to handle collisions', () => {
    expect(skillContent).toContain('E_SLUG_TAKEN');
  });
});
