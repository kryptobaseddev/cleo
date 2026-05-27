/**
 * Regression test for ct-adr-recorder/SKILL.md (T9643 / Epic T9629 / Saga T9625).
 *
 * Pins the SDK-first ADR contract: ADRs MUST be drafted via
 * `cleo docs add --type adr --slug adr-<NNNN>-<topic>` so the document
 * is owned by the originating consensus task and addressable by slug
 * for the HITL approval gate and the downstream supersession cascade.
 * The relational `decisions` row (ADR-006) is paired with the doc blob
 * but persisted separately via Drizzle.
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

describe('ct-adr-recorder SKILL.md — SDK-first contract (T9643)', () => {
  it('teaches `cleo docs add --type adr` as the canonical write path', () => {
    expect(skillContent).toMatch(/cleo docs add[\s\S]+--type adr/);
  });

  it('shows the `adr-<NNNN>-<topic>` slug convention', () => {
    expect(skillContent).toMatch(/adr-<NNNN>-<.*?topic/i);
  });

  it('attaches the ADR to the consensus task via the owner ID', () => {
    // The example MUST use a T### owner ID to demonstrate consensus-task linkage
    expect(skillContent).toMatch(/cleo docs add\s+T\d+\s/);
  });

  it('keeps the relational `decisions` write paired with the doc blob (ADR-006)', () => {
    expect(skillContent).toMatch(/decisions[\s\S]+Drizzle/i);
    expect(skillContent).toContain('ADR-006');
  });

  it('shows `cleo docs publish --for ... --to docs/adr/...` for git publication', () => {
    expect(skillContent).toMatch(/cleo docs publish[\s\S]+--for[\s\S]+--to[\s\S]+docs\/adr/);
  });

  it('shows `cleo docs fetch <slug>` for HITL review + supersession', () => {
    expect(skillContent).toContain('cleo docs fetch');
  });

  it('shows `cleo docs list --type adr` for ADR discovery', () => {
    expect(skillContent).toMatch(/cleo docs list[\s\S]+--type adr/);
  });

  it('marks the old direct-filesystem write as deprecated with a migration note', () => {
    expect(skillContent).toContain('Deprecated: Direct filesystem write');
    expect(skillContent).toMatch(/cleo docs (add|sync)/);
  });

  it('references E_SLUG_TAKEN for collision handling', () => {
    expect(skillContent).toContain('E_SLUG_TAKEN');
  });
});
