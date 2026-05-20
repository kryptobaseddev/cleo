/**
 * Regression test for ct-docs-review/SKILL.md (T9642 / Epic T9629 / Saga T9625).
 *
 * Pins the SDK-first review contract: reviewers MUST read docs through
 * `cleo docs fetch <slug>` rather than the working-tree file. Documents
 * the version-diff recipe (`versions` + two `fetch`es) since the CLI has
 * no dedicated `cleo docs diff` verb yet, and forces the Deprecated
 * direct-filesystem section to stay in the file.
 *
 * @task T9642
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

describe('ct-docs-review SKILL.md — SDK-first contract (T9642)', () => {
  it('teaches `cleo docs fetch` as the canonical read path', () => {
    expect(skillContent).toContain('cleo docs fetch');
  });

  it('documents fetch by slug, attachment ID, AND SHA-256', () => {
    expect(skillContent).toMatch(/By slug/i);
    expect(skillContent).toMatch(/By attachment ID/i);
    expect(skillContent).toMatch(/By SHA-256/i);
  });

  it('documents the version-diff recipe (no dedicated `cleo docs diff` verb yet)', () => {
    expect(skillContent).toContain('cleo docs versions');
    // The diff recipe MUST show two fetches piped to `diff`
    expect(skillContent).toMatch(/cleo docs fetch[\s\S]+cleo docs fetch[\s\S]+diff/);
  });

  it('teaches `cleo docs list --type` for candidate discovery', () => {
    expect(skillContent).toMatch(/cleo docs list\s+--type/);
  });

  it('shows `cleo docs status` for SSoT drift detection in PR review mode', () => {
    expect(skillContent).toContain('cleo docs status');
  });

  it('marks the old direct-filesystem read path as deprecated', () => {
    expect(skillContent).toContain('Deprecated: Direct filesystem');
  });
});
