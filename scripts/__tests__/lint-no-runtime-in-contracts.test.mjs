/**
 * Tests for scripts/lint-no-runtime-in-contracts.mjs (T11418 · E5 · SG-PACKAGE-ARCH).
 *
 * Strategy: the classifier is the pure exported `findViolationsInFile(text, rel)`.
 * Each test feeds a synthetic contracts source string and asserts which exports
 * are flagged as runtime-logic violations and which are exempt (type guards,
 * assertion guards, zod schemas, const arrays, whitelist). One integration test
 * runs the real script (baseline mode) against the real repo and asserts exit 0.
 *
 * @task T11418
 * @epic T11392
 * @saga T11387
 */

import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { findViolationsInFile } from '../lint-no-runtime-in-contracts.mjs';

const __dirname = resolve(fileURLToPath(import.meta.url), '..');
const REPO_ROOT = resolve(__dirname, '../..');
const SCRIPT = join(REPO_ROOT, 'scripts/lint-no-runtime-in-contracts.mjs');

const names = (vs) => vs.map((v) => v.split(':')[1]);

describe('findViolationsInFile — classification', () => {
  it('flags a bodied function declaration', () => {
    const src = `export function doWork(a: number): number { return a + 1; }`;
    expect(names(findViolationsInFile(src, 'f.ts'))).toEqual(['doWork']);
  });

  it('flags a bodied arrow const', () => {
    const src = `export const doWork = (a: number): number => a + 1;`;
    expect(names(findViolationsInFile(src, 'f.ts'))).toEqual(['doWork']);
  });

  it('flags an async function', () => {
    const src = `export async function loadIt(p: string): Promise<void> { await Promise.resolve(); }`;
    expect(names(findViolationsInFile(src, 'f.ts'))).toEqual(['loadIt']);
  });

  it('flags a function-expression const', () => {
    const src = `export const doWork = function (a: number) { return a; };`;
    expect(names(findViolationsInFile(src, 'f.ts'))).toEqual(['doWork']);
  });

  it('EXEMPTS a type-predicate guard', () => {
    const src = `export function isFoo(v: unknown): v is Foo { return typeof v === 'object'; }`;
    expect(findViolationsInFile(src, 'f.ts')).toEqual([]);
  });

  it('EXEMPTS an assertion guard', () => {
    const src = `export function assertFoo(v: unknown): asserts v is Foo { if (!v) throw new Error('x'); }`;
    expect(findViolationsInFile(src, 'f.ts')).toEqual([]);
  });

  it('EXEMPTS a zod schema (value, not a function)', () => {
    const src = `export const fooSchema = z.object({ a: z.string() });`;
    expect(findViolationsInFile(src, 'f.ts')).toEqual([]);
  });

  it('EXEMPTS a const type-array', () => {
    const src = `export const KINDS = ['a', 'b', 'c'] as const;`;
    expect(findViolationsInFile(src, 'f.ts')).toEqual([]);
  });

  it('EXEMPTS a parenthesized const value (not an arrow)', () => {
    const src = `export const FLAG = (process.env.X || 'y');`;
    expect(findViolationsInFile(src, 'f.ts')).toEqual([]);
  });

  it('EXEMPTS whitelisted names', () => {
    const src = `export function isRenderableEnvelope(v: unknown): boolean { return true; }`;
    expect(findViolationsInFile(src, 'f.ts')).toEqual([]);
  });

  it('flags a boolean-returning helper (NOT a type predicate)', () => {
    const src = `export function isReady(v: number): boolean { return v > 0; }`;
    expect(names(findViolationsInFile(src, 'f.ts'))).toEqual(['isReady']);
  });

  it('handles destructured params without mis-detecting the body', () => {
    const src = `export function build({ a, b }: Opts): string { return a + b; }`;
    expect(names(findViolationsInFile(src, 'f.ts'))).toEqual(['build']);
  });
});

describe('integration: real repo tree (baseline mode)', () => {
  it('the committed contracts tree passes baseline mode (exit 0)', () => {
    const res = spawnSync('node', [SCRIPT], { cwd: REPO_ROOT, encoding: 'utf8' });
    expect(res.status).toBe(0);
    expect(res.stdout).toMatch(/no net-new runtime helpers/);
  });

  it('strict mode reports the baselined runtime helpers (exit 1, non-empty)', () => {
    const res = spawnSync('node', [SCRIPT, '--strict'], { cwd: REPO_ROOT, encoding: 'utf8' });
    // Contracts still has pre-existing runtime helpers (E5 migrates them out over
    // time); strict mode therefore fails today and will pass once the package is pure.
    expect(res.status).toBe(1);
    expect(res.stderr).toMatch(/runtime helper/);
  });
});
