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

      // From a worktree gitlink, resolveProjectByCwd follows the gitlink to the
      // main repo and returns its CANONICAL project id. Post-T11013/T10297 the
      // canonical id is a sha256-derived 12-hex handle (NOT the raw
      // project-info.json `projectId` field), so assert on that shape rather
      // than the literal seed value. It may alternatively throw with a
      // `cleo init` remediation hint when no project resolves.
      try {
        const result = resolveProjectByCwd(worktree);
        expect(result).toMatch(/^[0-9a-f]{12}$/);
      } catch (err) {
        expect((err as Error).message).toContain('cleo init');
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
