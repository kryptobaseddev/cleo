/**
 * Debug: Trace resolveProjectByCwd behavior from a worktree.
 * Run with: npx vitest run packages/core/src/__tests__/paths-debug.test.ts
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveProjectByCwd } from '../paths.js';

describe('DEBUG worktree resolution', () => {
  it('traces resolveProjectByCwd from worktree', () => {
    const tmpHome = join(tmpdir(), `debug-wt-${Date.now()}`);
    mkdirSync(tmpHome, { recursive: true });

    const origHome = process.env['CLEO_HOME'];
    process.env['CLEO_HOME'] = tmpHome;

    try {
      const mainRepo = join(tmpHome, 'main');
      const worktree = join(tmpHome, 'wt');
      mkdirSync(mainRepo, { recursive: true });
      mkdirSync(worktree, { recursive: true });

      // Set up main repo
      mkdirSync(join(mainRepo, '.git'), { recursive: true });
      mkdirSync(join(mainRepo, '.cleo'), { recursive: true });
      writeFileSync(
        join(mainRepo, '.cleo', 'project-info.json'),
        JSON.stringify({ projectId: 'DEBUG-MAIN-ID' }),
      );

      // Set up worktree gitlink
      writeFileSync(join(worktree, '.git'), `gitdir: ${mainRepo}/.git/worktrees/debug-wt\n`);

      // What does resolveProjectByCwd return?
      let result: string;
      let threw = false;
      try {
        result = resolveProjectByCwd(worktree);
        console.log('RESULT:', result);
        expect(result).toBe('DEBUG-MAIN-ID');
      } catch (err: any) {
        threw = true;
        console.log('THREW:', err.message);
        // If it throws, we expect it to throw with cleo init hint
        expect(err.message).toContain('cleo init');
      }
    } finally {
      if (origHome !== undefined) {
        process.env['CLEO_HOME'] = origHome;
      } else {
        delete process.env['CLEO_HOME'];
      }
      rmSync(tmpHome, { recursive: true, force: true });
    }
  });
});
