/**
 * Tests for `scripts/lint-hitl-rule-delivery.mjs` (T12483).
 *
 * The gate must pass on the real repository and go red when the HITL ask-tool
 * rule is removed from ANY one delivery surface.
 *
 * @task T12483
 */
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { findMissing, SURFACES } from '../lint-hitl-rule-delivery.mjs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRIPT = join(REPO, 'scripts', 'lint-hitl-rule-delivery.mjs');

describe('lint-hitl-rule-delivery on the real repository', () => {
  it('finds the rule on every surface', () => {
    expect(findMissing(REPO)).toEqual([]);
  });

  it('exits 0 when run as a script', () => {
    const run = spawnSync(process.execPath, [SCRIPT], { cwd: REPO, encoding: 'utf8' });
    expect(run.status).toBe(0);
  });
});

describe('lint-hitl-rule-delivery goes red per surface', () => {
  let root;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'hitl-gate-'));
    for (const s of SURFACES) {
      mkdirSync(dirname(join(root, s.path)), { recursive: true });
      copyFileSync(join(REPO, s.path), join(root, s.path));
    }
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it.each(
    SURFACES.map((s) => [s.label, s]),
  )('fails when the rule is removed from the %s', (_label, surface) => {
    const file = join(root, surface.path);
    let text = readFileSync(file, 'utf8');
    for (const marker of surface.markers) text = text.split(marker).join('');
    writeFileSync(file, text);

    const problems = findMissing(root);
    expect(problems.map((p) => p.path)).toEqual([surface.path]);

    const run = spawnSync(process.execPath, [SCRIPT], { cwd: root, encoding: 'utf8' });
    expect(run.status).toBe(1);
    expect(run.stderr).toContain(surface.path);
  });

  it('fails when one marker alone is removed', () => {
    const surface = SURFACES[0];
    const file = join(root, surface.path);
    writeFileSync(file, readFileSync(file, 'utf8').split(surface.markers[0]).join(''));
    expect(findMissing(root)[0]?.missing).toEqual([surface.markers[0]]);
  });

  it('fails when a surface file is missing', () => {
    rmSync(join(root, SURFACES[1].path));
    expect(findMissing(root)[0]?.missing).toEqual(['<file unreadable>']);
  });
});
