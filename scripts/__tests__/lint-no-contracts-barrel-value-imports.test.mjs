/**
 * Unit tests for the contracts barrel value-import guard (T13126).
 */

import { describe, expect, it } from 'vitest';
import {
  BARREL_ENTRIES,
  BASELINE,
  findBarrelValueImports,
  SCANNED_PACKAGES,
} from '../lint-no-contracts-barrel-value-imports.mjs';

/** Offending lines found in `source`. */
function lines(source) {
  return findBarrelValueImports('x.ts', source).map((hit) => hit.line);
}

describe('findBarrelValueImports', () => {
  it.each([
    ["import type { Task } from '@cleocode/contracts';", 'a type-only import'],
    [
      "import { type Task, type TaskStatus } from '@cleocode/contracts';",
      'only inline type specifiers',
    ],
    ["export type { Task } from '@cleocode/contracts';", 'a type-only re-export'],
    ["export { type Task } from '@cleocode/contracts';", 'an inline type re-export'],
    ["import { ExitCode } from '@cleocode/contracts/exit-codes.js';", 'a leaf module'],
    [
      "const { ExitCode } = await import('@cleocode/contracts/exit-codes.js');",
      'a dynamic leaf import',
    ],
  ])('allows %s (%s)', (source) => {
    expect(lines(source)).toEqual([]);
  });

  it.each([
    ["import { ExitCode } from '@cleocode/contracts';", 'a value import'],
    ["import { type Task, ExitCode } from '@cleocode/contracts';", 'a value beside a type'],
    ["import * as contracts from '@cleocode/contracts';", 'a namespace import'],
    ["import '@cleocode/contracts';", 'a side-effect import'],
    ["export { ExitCode } from '@cleocode/contracts';", 'a value re-export'],
    ["export * from '@cleocode/contracts';", 'a star re-export'],
    ["export * as contracts from '@cleocode/contracts';", 'a namespace re-export'],
    ["const { ExitCode } = await import('@cleocode/contracts');", 'a dynamic import'],
  ])('flags %s (%s)', (source) => {
    expect(lines(source)).toEqual([1]);
  });

  it('reports the line of each offending statement', () => {
    const source = [
      "import type { Task } from '@cleocode/contracts';",
      "import { ExitCode } from '@cleocode/contracts';",
      '',
      "export { OPERATIONS } from '@cleocode/contracts';",
    ].join('\n');
    expect(lines(source)).toEqual([2, 4]);
  });
});

describe('scope', () => {
  it('scans the packages the CLI loads and exempts only the core public barrels', () => {
    expect(SCANNED_PACKAGES).toContain('packages/core/src/');
    expect(SCANNED_PACKAGES).toContain('packages/cleo/src/');
    expect(BARREL_ENTRIES.every((entry) => entry.startsWith('packages/core/src/'))).toBe(true);
  });

  it('keeps the baseline small: it may only shrink', () => {
    expect(BASELINE.length).toBeLessThanOrEqual(6);
  });
});
