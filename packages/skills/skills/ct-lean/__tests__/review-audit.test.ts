/**
 * T13665 — ct-lean review and audit workflows: Ponytail parity on CLEO's code
 * graph. Pins the priorities, the four-part finding contract, the nexus-backed
 * caller and dead-code checks, and the MIT attribution.
 *
 * @task T13665
 */
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const skillRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel: string) => readFileSync(join(skillRoot, rel), 'utf-8');

describe.each(['references/review.md', 'references/audit.md'])('ct-lean %s (T13665)', (rel) => {
  // Markdown wraps lines anywhere, including inside bold; compare on single spaces.
  const text = read(rel).replace(/\s+/g, ' ');

  it('keeps the priority order and the four-part finding contract', () => {
    expect(text).toContain('correct, safe, holds under load, tested, fast, lean');
    for (const part of ['What this is', 'Problem', 'Fix', 'If we skip it']) {
      expect(text).toMatch(new RegExp(`\\*\\*${part}:?\\*\\*`));
    }
    for (const group of ['Must fix', 'Should fix', 'Nice to have']) {
      expect(text).toMatch(new RegExp(`\\*\\*${group}:?\\*\\*`));
    }
    expect(text).toContain('Verdict');
    expect(text).toContain('Not checked:');
  });

  it('checks callers and unused code with cleo nexus, never an empty impact alone', () => {
    expect(text).toContain('cleo nexus impact <symbol>');
    expect(text).toContain('cleo nexus status');
    expect(text).toMatch(/\*\*and\*\* (no string|a grep)/);
  });

  it('treats a named shortcut as a decision and points at cleo lean debt', () => {
    expect(text).toContain('`shortcut:`');
    expect(text).toContain('cleo lean debt');
  });

  it('credits Ponytail under its MIT license', () => {
    expect(text).toContain('Ponytail 5.1.0');
    expect(text).toContain('MIT');
    expect(read('LICENSE-ponytail')).toContain('MIT License');
  });
});

describe('ct-lean SKILL.md points at both workflows (T13665)', () => {
  it('lists review.md and audit.md, not the old checklist', () => {
    const skill = read('SKILL.md');
    expect(skill).toContain('references/review.md');
    expect(skill).toContain('references/audit.md');
    expect(skill).not.toContain('references/reviewing.md');
  });
});
