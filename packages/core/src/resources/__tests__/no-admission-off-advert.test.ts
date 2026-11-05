/**
 * No admission message, deferral or doctor output advertises the switch that
 * turns admission off (T14282). Agents and leads followed that advertisement,
 * so the owner approved a bypass per release; a held wait names the programs
 * holding the memory instead (E_RESOURCE_EXTERNAL_PRESSURE).
 *
 * Scans the source of every surface that writes those messages. Comments may
 * still describe the switch; code may not print it.
 *
 * @task T14282
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repo = join(dirname(fileURLToPath(import.meta.url)), '../../../../..');

/** Every non-test `.ts` file under `dir`. */
function sources(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      if (name !== '__tests__') out.push(...sources(path));
    } else if (name.endsWith('.ts') && !name.endsWith('.test.ts')) {
      out.push(path);
    }
  }
  return out;
}

const SURFACES = [
  ...sources(join(repo, 'packages/core/src/resources')),
  ...sources(join(repo, 'packages/core/src/doctor')),
  join(repo, 'packages/core/src/tasks/tool-semaphore.ts'),
  join(repo, 'packages/cleo/src/cli/commands/run.ts'),
  ...readdirSync(join(repo, 'packages/cleo/src/cli/commands'))
    .filter((n) => n.startsWith('doctor') && n.endsWith('.ts'))
    .map((n) => join(repo, 'packages/cleo/src/cli/commands', n)),
];

/** Lines of code (not comments) that name the off switch. */
function advertisements(path: string): string[] {
  return readFileSync(path, 'utf8')
    .split('\n')
    .map((line, i) => ({ line: line.trim(), n: i + 1 }))
    .filter(({ line }) => !/^(\*|\/\*|\/\/)/.test(line))
    .filter(({ line }) => /CLEO_RESOURCES_MODE=off|CLEO_ADMISSION_PRESSURE/.test(line))
    .map(({ line, n }) => `${relative(repo, path)}:${n}: ${line}`);
}

describe('no admission surface advertises turning admission off (T14282)', () => {
  it('scans the admission, deferral and doctor sources', () => {
    expect(SURFACES.length).toBeGreaterThan(10);
    expect(SURFACES.some((p) => p.endsWith('pressure-gate.ts'))).toBe(true);
    expect(SURFACES.some((p) => p.endsWith('run-admission.ts'))).toBe(true);
  });

  it('no code line names CLEO_RESOURCES_MODE=off or CLEO_ADMISSION_PRESSURE', () => {
    expect(SURFACES.flatMap(advertisements)).toEqual([]);
  });
});
