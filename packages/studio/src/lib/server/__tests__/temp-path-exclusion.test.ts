/**
 * Regression test for the strict server-side `.temp/` path exclusion in
 * `listRegisteredProjects` (project-context.ts).
 *
 * The pattern `/(^|\/)\.temp(\/|$)/` must:
 *   - match `.temp` anywhere in a path that is bordered by `/` or string boundaries
 *   - NOT match paths that merely contain "temp" or ".tempfoo"
 *
 * This rule is non-negotiable: `.temp/` is reserved for ephemeral fixture/scratch
 * state and MUST never appear in the project switcher or any client-side list.
 */

import { describe, expect, it } from 'vitest';

const TEMP_PATH_PATTERN = /(^|\/)\.temp(\/|$)/;

describe('TEMP_PATH_PATTERN — strict .temp/ exclusion', () => {
  it('matches paths with .temp segment in the middle', () => {
    expect(TEMP_PATH_PATTERN.test('/home/user/.temp/scratch/proj-x')).toBe(true);
    expect(TEMP_PATH_PATTERN.test('/var/data/.temp/p1')).toBe(true);
    expect(TEMP_PATH_PATTERN.test('/a/b/.temp/c/d')).toBe(true);
  });

  it('matches paths ending in /.temp', () => {
    expect(TEMP_PATH_PATTERN.test('/home/user/.temp')).toBe(true);
    expect(TEMP_PATH_PATTERN.test('/var/.temp')).toBe(true);
  });

  it('matches paths starting with .temp/', () => {
    expect(TEMP_PATH_PATTERN.test('.temp/scratch')).toBe(true);
    expect(TEMP_PATH_PATTERN.test('.temp')).toBe(true);
  });

  it('does NOT match paths with "temp" but no .temp segment', () => {
    expect(TEMP_PATH_PATTERN.test('/home/user/temp/proj')).toBe(false);
    expect(TEMP_PATH_PATTERN.test('/home/user/tempdir')).toBe(false);
    expect(TEMP_PATH_PATTERN.test('/home/user/.temporary')).toBe(false);
    expect(TEMP_PATH_PATTERN.test('/home/user/.tempfoo/p')).toBe(false);
  });

  it('does NOT match real project paths', () => {
    expect(TEMP_PATH_PATTERN.test('/mnt/projects/cleocode')).toBe(false);
    expect(TEMP_PATH_PATTERN.test('/home/user/code/myapp')).toBe(false);
    expect(TEMP_PATH_PATTERN.test('/Users/dev/repos/project')).toBe(false);
  });

  it('matches case-sensitively (only literal ".temp")', () => {
    // Linux/macOS file systems are case-sensitive; .Temp / .TEMP are different
    // directories. We only filter the literal `.temp` per the user directive.
    expect(TEMP_PATH_PATTERN.test('/home/user/.Temp/scratch')).toBe(false);
    expect(TEMP_PATH_PATTERN.test('/home/user/.TEMP/scratch')).toBe(false);
  });
});
