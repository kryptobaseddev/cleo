/**
 * Drift guard against re-introducing hardcoded model strings outside the
 * single source-of-truth in `packages/core/src/llm/role-resolver.ts`.
 *
 * Phase 1 of T-LLM-CRED-CENTRALIZATION removed 7 call-sites that each pinned
 * `claude-haiku-4-5-20251001` inline. Phase 2 centralised the literal at
 * `IMPLICIT_FALLBACK_MODEL` (`role-resolver.ts:58`). This test walks every
 * `.ts`/`.tsx` source file under `packages/` and asserts the literal does NOT
 * appear outside:
 *
 *   • `packages/core/src/llm/`     (where the canonical const lives)
 *   • any `__tests__` directory    (test fixtures still pin the literal)
 *   • any `dist`, `build`, or `node_modules` directory (build artefacts)
 *
 * A failure here means a future refactor accidentally re-embedded the literal.
 * Fix it by importing `IMPLICIT_FALLBACK_MODEL` from
 * `@cleocode/core/llm/role-resolver` (or the package barrel) instead.
 *
 * @task T9259
 * @epic T-LLM-CRED-CENTRALIZATION
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const FORBIDDEN_LITERAL = 'claude-haiku-4-5-20251001';
const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx']);
const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', '.turbo', 'coverage', '.cache']);

/**
 * Resolve `<repo>/packages` by walking up from this test file. We are at
 * `packages/core/src/llm/__tests__/no-hardcoded-models.test.ts` — three
 * `dirname` calls land us in `packages/core/src/llm`, two more in `packages/core`,
 * one more in `packages`.
 */
function packagesRoot(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, '..', '..', '..', '..', '..', 'packages');
}

/** Recursively walk `dir` and yield absolute file paths. */
function* walk(dir: string): IterableIterator<string> {
  let entries: ReturnType<typeof readdirSync>;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      yield* walk(full);
    } else if (entry.isFile()) {
      yield full;
    }
  }
}

/**
 * `true` when `file` is allowed to contain the literal:
 * - inside `packages/core/src/llm/` (canonical const + nearby code)
 * - inside any `__tests__` directory (test fixtures pin the literal on
 *   purpose to assert behaviour against the implicit fallback)
 */
function isAllowed(file: string): boolean {
  const rel = file.split(sep);
  if (rel.includes('__tests__')) return true;
  // Allow `packages/core/src/llm/...` — but NOT `packages/core/src/llm/__tests__`
  // (that is the canonical home for the const + its tests).
  const llmIdx = rel.indexOf('llm');
  if (llmIdx > 0 && rel[llmIdx - 1] === 'src') {
    // Look two segments back to confirm we are under packages/core/src/llm
    if (rel[llmIdx - 2] === 'core') return true;
  }
  return false;
}

describe('grep guard — no hardcoded haiku model outside the source-of-truth', () => {
  it(`no .ts/.tsx file outside packages/core/src/llm/ contains "${FORBIDDEN_LITERAL}"`, () => {
    const root = packagesRoot();
    // Sanity: the packages root must exist.
    expect(statSync(root).isDirectory()).toBe(true);

    const violations: string[] = [];
    for (const file of walk(root)) {
      const ext = file.slice(file.lastIndexOf('.'));
      if (!SOURCE_EXTENSIONS.has(ext)) continue;
      if (isAllowed(file)) continue;

      const contents = readFileSync(file, 'utf-8');
      if (contents.includes(FORBIDDEN_LITERAL)) {
        violations.push(file);
      }
    }

    expect(
      violations,
      `hardcoded "${FORBIDDEN_LITERAL}" found in:\n  ${violations.join('\n  ')}`,
    ).toEqual([]);
  });

  it('the canonical const lives in packages/core/src/llm/role-resolver.ts', () => {
    const root = packagesRoot();
    const canonical = join(root, 'core', 'src', 'llm', 'role-resolver.ts');
    const contents = readFileSync(canonical, 'utf-8');
    expect(contents).toContain(`export const IMPLICIT_FALLBACK_MODEL = '${FORBIDDEN_LITERAL}'`);
  });
});
