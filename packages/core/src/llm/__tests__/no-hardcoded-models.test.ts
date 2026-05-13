/**
 * Drift guard against re-introducing hardcoded model strings outside the
 * single source-of-truth in `packages/core/src/llm/role-resolver.ts`.
 *
 * Phase 1 of T-LLM-CRED-CENTRALIZATION removed 7 call-sites that each pinned
 * `claude-haiku-4-5-20251001` inline. Phase 2 centralised the literal at
 * `IMPLICIT_FALLBACK_MODEL` (`role-resolver.ts:58`) and added
 * `HYGIENE_FALLBACK_MODEL = 'claude-sonnet-4-6'` for the hygiene-tier path.
 * This test walks every `.ts`/`.tsx` source file under `packages/` and
 * asserts neither literal appears outside:
 *
 *   • `packages/core/src/llm/`     (where the canonical consts live)
 *   • any `__tests__` directory    (test fixtures still pin the literals)
 *   • any `dist`, `build`, or `node_modules` directory (build artefacts)
 *
 * A failure here means a future refactor accidentally re-embedded the literal.
 * Fix it by importing `IMPLICIT_FALLBACK_MODEL` / `HYGIENE_FALLBACK_MODEL`
 * from `@cleocode/core/llm/role-resolver` (or the package barrel) instead.
 *
 * @task T9259
 * @task T-LLM-CRED-CENTRALIZATION Phase 2 — DRY review P2-2
 * @epic T-LLM-CRED-CENTRALIZATION
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const FORBIDDEN_LITERAL = 'claude-haiku-4-5-20251001';
const FORBIDDEN_HYGIENE_LITERAL = 'claude-sonnet-4-6';
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

/**
 * Scoped grep guard for the hygiene-tier sonnet literal.
 *
 * Unlike the haiku literal (a version-pinned `-20251001` string that has no
 * legitimate use outside the resolver), `claude-sonnet-4-6` is a base model
 * name referenced by sibling subsystems with their own routing strategies:
 *
 *   • `memory/llm-backend-resolver.ts` — owner-mandated cold-tier model
 *     (`COLD_TIER_MODEL`) for the BRAIN promotion backend; orthogonal to
 *     the role resolver. Documented as "MUST be claude-sonnet-4-6, NOT
 *     Haiku" per the 2026-04-15 owner override.
 *   • TSDoc `@defaultValue` / `@example` blocks that surface the literal
 *     to API consumers without using it as a runtime default.
 *
 * The scan is therefore scoped to the call-site directories migrated by
 * T-LLM-CRED Phase 2 (sentient + deriver + tasks) plus the BRAIN-tier
 * extraction/consolidation surfaces under memory/, with a small allowlist
 * carving out the legitimate owner-mandated cold-tier consumer + the docs.
 *
 * @task T-LLM-CRED-CENTRALIZATION Phase 2 — DRY review P2-2
 */
const SONNET_SCAN_SUBDIRS = ['memory', 'sentient', 'deriver', 'tasks'];
const SONNET_ALLOWLIST_BASENAMES = new Set([
  // BRAIN cold-tier backend resolver — separate subsystem, owner-mandated literal.
  'llm-backend-resolver.ts',
  // TSDoc-only references to the model in API examples / @example blocks.
  'dialectic-evaluator.ts',
  'decisions.ts',
]);

describe('grep guard — no hardcoded sonnet model in T-LLM-CRED migrated call-sites', () => {
  it(`no .ts/.tsx file under packages/core/src/{${SONNET_SCAN_SUBDIRS.join(',')}}/ contains "${FORBIDDEN_HYGIENE_LITERAL}"`, () => {
    const coreSrc = join(packagesRoot(), 'core', 'src');
    expect(statSync(coreSrc).isDirectory()).toBe(true);

    const violations: string[] = [];
    for (const sub of SONNET_SCAN_SUBDIRS) {
      const dir = join(coreSrc, sub);
      for (const file of walk(dir)) {
        const ext = file.slice(file.lastIndexOf('.'));
        if (!SOURCE_EXTENSIONS.has(ext)) continue;
        // Tests inside the scanned dirs still pin literals on purpose.
        if (file.split(sep).includes('__tests__')) continue;
        // Owner-mandated or docs-only consumers are explicitly allowlisted.
        const basename = file.split(sep).pop() ?? '';
        if (SONNET_ALLOWLIST_BASENAMES.has(basename)) continue;

        const contents = readFileSync(file, 'utf-8');
        if (contents.includes(FORBIDDEN_HYGIENE_LITERAL)) {
          violations.push(file);
        }
      }
    }

    expect(
      violations,
      `hardcoded "${FORBIDDEN_HYGIENE_LITERAL}" found in migrated call-sites:\n  ${violations.join('\n  ')}\n` +
        `Use HYGIENE_FALLBACK_MODEL from @cleocode/core/llm/role-resolver instead.`,
    ).toEqual([]);
  });

  it('the canonical hygiene-fallback const lives in packages/core/src/llm/role-resolver.ts', () => {
    const root = packagesRoot();
    const canonical = join(root, 'core', 'src', 'llm', 'role-resolver.ts');
    const contents = readFileSync(canonical, 'utf-8');
    expect(contents).toContain(
      `export const HYGIENE_FALLBACK_MODEL = '${FORBIDDEN_HYGIENE_LITERAL}'`,
    );
  });
});
