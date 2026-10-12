/**
 * Tests for the T13361 legacy docs verb retirement (spec `cleodocs-rearch-design` §6).
 *
 * The retirement is only real if the same registry the command-existence gates
 * (T12069 / T12093 / T12649) read no longer resolves the retired verbs. These
 * tests load that registry via `loadRegistry` from the gate SSoT and assert:
 *
 *   - the seven retired verbs are absent: search, find, rank (→ `docs query`),
 *     generate, export (→ `docs llm-output`), gap-check (→ `docs check`),
 *     import (legacy .md migration utility, no replacement);
 *   - the canonical replacement surfaces are present: query, llm-output, check;
 *   - `docs status` stays — the spec §6 tension resolution keeps it
 *     agent-facing (the Council had listed it as legacy; cleo-dev-mac's
 *     correction is incorporated in the spec);
 *   - `docs sync` is RETAINED for now: the T9645 docs-reingest workflow
 *     invokes `docs sync --from/--for/--name` in CI and no replacement verb
 *     exists — the AC3 production-caller check blocks its removal until that
 *     workflow migrates (see the T13361 report).
 *
 * @task T13361
 */
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadRegistry } from '../lint-injection-commands.mjs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

describe('T13361 — legacy docs verbs are retired from the command registry', () => {
  const docsSubs = loadRegistry(['docs'], REPO).get('docs') ?? new Set();

  it('the registry resolves docs subcommands', () => {
    expect(docsSubs.size).toBeGreaterThan(0);
  });

  it.each([
    'search',
    'find',
    'rank',
    'generate',
    'export',
    'gap-check',
    'import',
  ])('docs %s is retired (cleodocs-rearch-design §6)', (verb) => {
    expect(docsSubs.has(verb)).toBe(false);
  });

  it.each([
    'query',
    'llm-output',
    'check',
  ])('docs %s is the canonical replacement surface', (verb) => {
    expect(docsSubs.has(verb)).toBe(true);
  });

  it('docs status stays (agent-facing per the spec §6 tension resolution)', () => {
    expect(docsSubs.has('status')).toBe(true);
  });

  it('docs sync is retained until the T9645 reingest workflow migrates (AC3 caller check)', () => {
    expect(docsSubs.has('sync')).toBe(true);
  });
});
