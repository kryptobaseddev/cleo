/**
 * A language default must not demand a toolchain the project does not have
 * (T12083).
 *
 * Measured on a fresh drop-in: `cleo init` on a plain JavaScript project, a
 * correct worker implements a function, writes a test, RUNS the suite, commits,
 * records `implemented` + `testsPassed` — and then `cleo complete` refuses:
 *
 *     Task T003 failed verification gates: qaPassed (45)
 *
 * because `qaPassed` wants `tool:typecheck`, whose node language default is
 * `npx tsc --noEmit`, which in a project with no TypeScript answers
 * *"This is not the tsc command you are looking for"* and exits 1. No task in
 * that project can EVER be completed, however correct the work.
 *
 * The asymmetry that fixes it: a command the operator DECLARED always runs; a
 * command CLEO guessed runs only when the project shows evidence of that
 * toolchain.
 *
 * @task T12083
 */

import { mkdtempSync, writeFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { resolveToolCommand } from '../tool-resolver.js';

let root: string;

/** Write a `package.json` into the sandbox. */
async function pkg(content: Record<string, unknown>): Promise<void> {
  await writeFile(join(root, 'package.json'), JSON.stringify(content), 'utf-8');
}

/** Write `.cleo/project-context.json` into the sandbox. */
async function context(content: Record<string, unknown>): Promise<void> {
  await mkdir(join(root, '.cleo'), { recursive: true });
  await writeFile(join(root, '.cleo/project-context.json'), JSON.stringify(content), 'utf-8');
}

describe('tool applicability (T12083)', () => {
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cleo-tool-applic-'));
  });

  describe('a plain JavaScript project', () => {
    beforeEach(async () => {
      await pkg({ name: 'calcbox', type: 'module', scripts: { test: 'node test/calc.test.js' } });
      await context({ primaryType: 'node' });
    });

    it('reports typecheck as NOT APPLICABLE instead of running `npx tsc`', async () => {
      const r = resolveToolCommand('typecheck', root);

      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.codeName).toBe('E_TOOL_NOT_APPLICABLE');
      // The reason must name the remedy that actually works here.
      expect(r.reason).toContain('project-context.json');
    });

    it('reports lint as NOT APPLICABLE with no linter config or dependency', () => {
      const r = resolveToolCommand('lint', root);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.codeName).toBe('E_TOOL_NOT_APPLICABLE');
    });

    it('still resolves `test`, which the project genuinely has', () => {
      // Applicability is per-tool. A project without a typechecker still has
      // tests, and `testsPassed` must keep biting.
      const r = resolveToolCommand('test', root);
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.command.canonical).toBe('test');
    });
  });

  describe('markers that make a tool applicable', () => {
    beforeEach(async () => {
      await context({ primaryType: 'node' });
    });

    it('tsconfig.json makes typecheck applicable', async () => {
      await pkg({ name: 'x' });
      writeFileSync(join(root, 'tsconfig.json'), '{}');
      expect(resolveToolCommand('typecheck', root).ok).toBe(true);
    });

    it('a `typecheck` script makes typecheck applicable', async () => {
      await pkg({ name: 'x', scripts: { typecheck: 'tsc --noEmit' } });
      expect(resolveToolCommand('typecheck', root).ok).toBe(true);
    });

    it('a typescript devDependency makes typecheck applicable', async () => {
      await pkg({ name: 'x', devDependencies: { typescript: '^5.0.0' } });
      expect(resolveToolCommand('typecheck', root).ok).toBe(true);
    });

    it('biome.json makes lint applicable', async () => {
      await pkg({ name: 'x' });
      writeFileSync(join(root, 'biome.json'), '{}');
      expect(resolveToolCommand('lint', root).ok).toBe(true);
    });

    it('an eslint config makes lint applicable', async () => {
      await pkg({ name: 'x' });
      writeFileSync(join(root, 'eslint.config.mjs'), 'export default [];');
      expect(resolveToolCommand('lint', root).ok).toBe(true);
    });
  });

  describe('an explicitly DECLARED command is always applicable', () => {
    it('runs a declared typecheck command even with no toolchain markers', async () => {
      // The operator said so. Applicability is only ever consulted for a guess.
      await pkg({ name: 'x' });
      await context({ primaryType: 'node', typecheck: { command: 'make typecheck' } });

      const r = resolveToolCommand('typecheck', root);

      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.command.source).toBe('project-context');
        expect(r.command.cmd).toBe('make');
      }
    });
  });

  describe('tools with no applicability marker are unaffected', () => {
    it('resolves `build` by language default without a marker check', async () => {
      // Only guesses that are KNOWN to be wrong in a bare project are gated.
      // Everything else keeps its previous behaviour exactly.
      await pkg({ name: 'x' });
      await context({ primaryType: 'node' });

      const r = resolveToolCommand('build', root);
      expect(r.ok).toBe(true);
    });
  });

  describe('non-node project types keep their defaults', () => {
    it('does not gate a rust typecheck', async () => {
      // No marker table for rust: `cargo check` is a safe default because a
      // rust project by definition has cargo.
      await context({ primaryType: 'rust' });
      const r = resolveToolCommand('typecheck', root);
      expect(r.ok).toBe(true);
    });
  });
});
