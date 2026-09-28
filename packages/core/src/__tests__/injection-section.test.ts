/**
 * `readInjectionSection` — the lookup behind `cleo briefing inject --section`.
 *
 * CLEO-INJECTION.md is the always-loaded core; reference sections live in
 * CLEO-REFERENCE.md. Every pointer in the core resolves through this function,
 * so it must find sections in both files and report every available name.
 *
 * @task T12580
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CLEO_REFERENCE_TEMPLATE,
  extractInjectionSection,
  listInjectionSections,
  readInjectionSection,
} from '../injection.js';

const section = (name: string, body: string): string =>
  `<!-- CLEO-INJECTION:section=${name} -->\n${body}\n<!-- /CLEO-INJECTION:section=${name} -->\n`;

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function templatesDir(core: string, reference?: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'cleo-inject-section-'));
  dirs.push(dir);
  writeFileSync(join(dir, 'CLEO-INJECTION.md'), core);
  if (reference !== undefined) writeFileSync(join(dir, CLEO_REFERENCE_TEMPLATE), reference);
  return dir;
}

describe('readInjectionSection (T12580)', () => {
  it('resolves a core section and a reference section from the same call surface', () => {
    const dir = templatesDir(section('work-loop', 'core body'), section('nexus', 'reference body'));
    const core = readInjectionSection('work-loop', dir);
    expect(core.content).toBe('core body');
    expect(core.source).toBe(join(dir, 'CLEO-INJECTION.md'));
    const ref = readInjectionSection('nexus', dir);
    expect(ref.content).toBe('reference body');
    expect(ref.source).toBe(join(dir, CLEO_REFERENCE_TEMPLATE));
  });

  it('reports a miss with every available name instead of an empty success', () => {
    const dir = templatesDir(section('work-loop', 'a'), section('nexus', 'b'));
    const miss = readInjectionSection('does-not-exist', dir);
    expect(miss.content).toBeNull();
    expect(miss.source).toBeNull();
    expect(miss.available).toEqual(expect.arrayContaining(['work-loop', 'nexus']));
  });

  it('prefers the core when both files declare a name', () => {
    const dir = templatesDir(section('rules', 'core'), section('rules', 'reference'));
    expect(readInjectionSection('rules', dir).content).toBe('core');
  });

  it('every section the shipped core points at resolves from the shipped templates', () => {
    const shipped = readInjectionSection('task-creation');
    expect(shipped.content).toContain('## Task Creation');
    for (const name of ['nexus', 'evidence', 'knowledge-repair', 'spawn-tiers', 'work-loop']) {
      expect(readInjectionSection(name).content, name).not.toBeNull();
    }
  });
});

describe('section helpers', () => {
  it('extracts trimmed bodies and lists names in order without duplicates', () => {
    const text = section('a', ' one ') + section('b', 'two') + section('a', 'dup');
    expect(extractInjectionSection(text, 'a')).toBe('one');
    expect(extractInjectionSection(text, 'missing')).toBeNull();
    expect(listInjectionSections(text)).toEqual(['a', 'b']);
  });
});
