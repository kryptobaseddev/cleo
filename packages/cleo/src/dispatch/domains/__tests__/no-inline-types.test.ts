/**
 * Regression-prevention test: no inline type/interface declarations in dispatch domain files.
 *
 * Enforces ADR-057 D3 + OpsFromCore migration (T1435 W3b / T1448):
 *
 *   dispatch domain files MUST NOT declare top-level `export type X*Params`,
 *   `export interface X*Params`, `export type X*Result`, or
 *   `export interface X*Result` declarations that mirror Core operation
 *   signatures.  Those types live in `packages/contracts/src/operations/` as
 *   the SSoT.  The dispatch layer infers param/result shapes via
 *   `OpsFromCore<typeof coreOps>` — redundant re-declarations cause silent
 *   drift and were explicitly prohibited by ADR-057 D3.
 *
 * Scope: every `.ts` file in `packages/cleo/src/dispatch/domains/` that is
 *   not a helper file (`_*.ts`), not `index.ts`, and not inside `__tests__/`.
 *
 * Allowed top-level exports (non-exhaustive):
 *   - `export type XOps = OpsFromCore<typeof coreOps>` — inferred domain ops binding
 *   - LAFS envelope re-exports (`LafsEnvelope`, `LafsPage`, `LafsError`)
 *   - Namespace re-exports of cross-domain enums
 *   - Internal utility/harness interfaces documented with `@internal`
 *
 * Prohibited patterns (trigger this test to fail):
 *   - `export type Foo*Params` — mirrors a Core operation input type
 *   - `export interface Foo*Params` — same
 *   - `export type Foo*Result` — mirrors a Core operation output type
 *   - `export interface Foo*Result` — same
 *   - Any `export type` / `export interface` whose name ends in `Params` or
 *     `Result` (regardless of prefix)
 *
 * If a future PR re-introduces inline `*Params`/`*Result` declarations,
 * this test will fail with a message pointing to ADR-057 D3 and OpsFromCore.
 *
 * @task T1448 — biome lint rule + regression-prevention test
 * @see ADR-057 D3 — Dispatch as thin pass-through via OpsFromCore
 */

import { readdir, readFile } from 'node:fs/promises';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const DOMAINS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Pattern matching top-level exported type/interface declarations whose name
 * ends in `Params` or `Result`.  These are the canonical mirrored-Core-signature
 * anti-patterns.
 *
 * Matches:
 *   export type FooBarParams = ...
 *   export interface BazResult { ... }
 *   export type Something<T>Params ...  (generic variants)
 *
 * Does NOT match:
 *   export type PipelineOps = OpsFromCore<typeof coreOps>  (OpsFromCore binding)
 *   export interface PlaybookRuntimeOverrides { ... }      (internal harness)
 *   export interface NexusImpactAffectedSymbol { ... }     (internal shape)
 *   type Foo = ...  (non-exported)
 */
const PROHIBITED_PATTERN =
  /^export\s+(?:type|interface)\s+\w*(?:Params|Result)(?:<[^>]*>)?\s*[={;]/m;

/**
 * Checks a single top-level declaration line for prohibited patterns.
 * Returns the problematic identifier name or null.
 */
function extractProhibitedName(line: string): string | null {
  const m = line.match(
    /^export\s+(?:type|interface)\s+(\w*(?:Params|Result)(?:<[^>]*>)?)\s*[={;{]/,
  );
  return m ? m[1] : null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Collect all scanned domain files (not helper `_*.ts`, not `index.ts`).
 */
async function getDomainFiles(): Promise<string[]> {
  const entries = await readdir(DOMAINS_DIR, { withFileTypes: true });
  return entries
    .filter(
      (e) =>
        e.isFile() && extname(e.name) === '.ts' && !e.name.startsWith('_') && e.name !== 'index.ts',
    )
    .map((e) => join(DOMAINS_DIR, e.name))
    .sort();
}

/**
 * Scan source text for top-level `export type|interface` lines whose
 * identifier ends in `Params` or `Result`.
 *
 * Returns list of `{ line, name }` violations.
 */
function findProhibitedDeclarations(
  source: string,
): Array<{ lineNum: number; name: string; raw: string }> {
  const lines = source.split('\n');
  const violations: Array<{ lineNum: number; name: string; raw: string }> = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Only top-level declarations (no leading whitespace)
    if (/^\s/.test(line)) continue;

    const name = extractProhibitedName(line);
    if (name) {
      violations.push({ lineNum: i + 1, name, raw: line.trimEnd() });
    }
  }

  return violations;
}

// ---------------------------------------------------------------------------
// Test
// ---------------------------------------------------------------------------

describe('dispatch domain files: no inline Core-signature type declarations (ADR-057 D3)', () => {
  it('contains domain files to scan', async () => {
    const files = await getDomainFiles();
    expect(files.length).toBeGreaterThan(0);
  });

  it('has zero top-level export type/interface ending in *Params or *Result in any domain file', async () => {
    const files = await getDomainFiles();
    const allViolations: string[] = [];

    for (const filePath of files) {
      const source = await readFile(filePath, 'utf-8');
      const violations = findProhibitedDeclarations(source);

      for (const v of violations) {
        allViolations.push(`  ${filePath}:${v.lineNum}  ${v.name}\n    → ${v.raw}`);
      }
    }

    if (allViolations.length > 0) {
      throw new Error(
        [
          '',
          '╔══════════════════════════════════════════════════════════════════════╗',
          '║  ADR-057 D3 VIOLATION: Inline Core-signature type declarations found ║',
          '╚══════════════════════════════════════════════════════════════════════╝',
          '',
          'The following dispatch domain files contain `export type *Params` or',
          '`export interface *Result` declarations that mirror Core operation',
          'signatures.  These MUST NOT exist in the dispatch layer.',
          '',
          'FIX: Remove the inline declaration and use OpsFromCore inference instead:',
          '  1. Add the Core fn to the `coreOps` record in the domain file.',
          '  2. The domain ops type is: `type XOps = OpsFromCore<typeof coreOps>`',
          '  3. Params/Result shapes are inferred automatically — no re-declaration needed.',
          '',
          'See: ADR-057 D3 (docs/adr/ADR-057-contracts-core-ssot.md)',
          '     T1448 (OpsFromCore lint + regression gate)',
          '',
          'Violations:',
          ...allViolations,
          '',
        ].join('\n'),
      );
    }

    expect(allViolations).toHaveLength(0);
  });

  it('lists all scanned domain files for traceability', async () => {
    const files = await getDomainFiles();
    // Spot-check that the 9 migrated domains are included
    const names = files.map((f) => f.split('/').pop()!);
    const expectedDomains = [
      'admin.ts',
      'check.ts',
      'conduit.ts',
      'nexus.ts',
      'pipeline.ts',
      'playbook.ts',
      'sentient.ts',
      'session.ts',
      'tasks.ts',
    ];
    for (const expected of expectedDomains) {
      expect(names, `Expected domain file ${expected} to be present`).toContain(expected);
    }
  });

  it('detection pattern correctly identifies prohibited declarations', () => {
    // Positive cases — must be detected
    const prohibited = [
      'export type TasksAddParams = { title: string };',
      'export interface SessionStartParams {',
      'export type CheckRunResult = { passed: boolean };',
      'export interface NexusQueryResult {',
      'export type AdminSnapshotParams<T> = { id: T };',
    ];
    for (const decl of prohibited) {
      expect(
        extractProhibitedName(decl),
        `Expected "${decl}" to be detected as prohibited`,
      ).not.toBeNull();
    }

    // Negative cases — must NOT be detected
    // Note: EngineResult is in _base.ts (excluded from scan by file-name filter)
    // so it does not need to pass the pattern check — only in-scope domain-file
    // patterns are tested here.
    const allowed = [
      'export type PipelineOps = OpsFromCore<typeof coreOps>;',
      'export interface PlaybookRuntimeOverrides {',
      'export interface NexusImpactAffectedSymbol {',
      'export const __playbookRuntimeOverrides = {};',
      'export type { LafsEnvelope } from "@cleocode/lafs";',
      'type TasksAddParams = { title: string };', // non-exported
      '  export interface SomeParams {', // indented (not top-level)
    ];
    for (const decl of allowed) {
      expect(
        extractProhibitedName(decl),
        `Expected "${decl}" to NOT be detected as prohibited`,
      ).toBeNull();
    }
  });
});
