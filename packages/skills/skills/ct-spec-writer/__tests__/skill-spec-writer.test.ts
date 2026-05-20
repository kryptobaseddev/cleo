/**
 * Regression test for ct-spec-writer/SKILL.md (T9643 / Epic T9629 / Saga T9625).
 *
 * Pins the SDK-first spec contract: specs MUST be created via
 * `cleo docs add --type spec --slug <name>` so they auto-attach to the
 * parent task and are retrievable by slug. The Output Location section
 * may still mention `docs/specs/{{SPEC_NAME}}.md` as the published path,
 * but the canonical write surface is the SDK.
 *
 * @task T9643
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

describe('ct-spec-writer SKILL.md — SDK-first contract (T9643)', () => {
  it('teaches `cleo docs add --type spec` as the canonical write path', () => {
    expect(skillContent).toMatch(/cleo docs add[\s\S]+--type spec/);
  });

  it('shows `--slug` as the kebab-case retrieval handle', () => {
    expect(skillContent).toContain('--slug');
    expect(skillContent).toMatch(/kebab-case/);
  });

  it('attaches the spec to a parent task via the owner ID', () => {
    // Owner ID example must use a T### prefix to demonstrate task linkage
    expect(skillContent).toMatch(/cleo docs add\s+T\d+\s/);
  });

  it('shows `cleo docs publish --for ... --to docs/specs/...` for git publication', () => {
    expect(skillContent).toMatch(/cleo docs publish[\s\S]+--for[\s\S]+--to[\s\S]+docs\/specs/);
  });

  it('shows `cleo docs fetch <slug>` for downstream retrieval', () => {
    expect(skillContent).toContain('cleo docs fetch');
  });

  it('shows `cleo docs list --type spec` for sibling spec discovery', () => {
    expect(skillContent).toMatch(/cleo docs list[\s\S]+--type spec/);
  });

  it('marks the old direct-filesystem write as deprecated with a migration note', () => {
    expect(skillContent).toContain('Deprecated: Direct filesystem write');
    expect(skillContent).toMatch(/cleo docs (add|sync)/);
  });

  it('references E_SLUG_TAKEN for collision handling', () => {
    expect(skillContent).toContain('E_SLUG_TAKEN');
  });
});
