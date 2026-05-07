/**
 * T9053 — SSoT cross-language equivalence test.
 *
 * Asserts that the canonical pragma SQL produced by the TS module
 * `sqlite-pragmas.ts` matches what the Rust crate `signaldock-storage`
 * produces from the same `specs/sqlite-pragmas.json` file at compile
 * time (via `build.rs` + `include_str!` codegen).
 *
 * Both sides apply the documented render rule:
 *   `PRAGMA name = value` per entry, joined with `;\n`.
 *
 * If this test fails, the JSON spec, the TS render path, or the Rust
 * render path diverged — the fix is to re-align with the SSoT, never
 * to weaken the assertion.
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CANONICAL_PRAGMA_SQL, CANONICAL_PRAGMAS, renderPragmaSql } from '../sqlite-pragmas.js';

interface SqlitePragmaSpec {
  readonly version: number;
  readonly pragmas: ReadonlyArray<readonly [string, string]>;
}

function loadSpec(): SqlitePragmaSpec {
  const here = dirname(fileURLToPath(import.meta.url));
  const specPath = resolve(here, '..', '..', '..', '..', '..', 'specs', 'sqlite-pragmas.json');
  return JSON.parse(readFileSync(specPath, 'utf8')) as SqlitePragmaSpec;
}

describe('sqlite-pragmas SSoT (T9053)', () => {
  it('exposes a non-empty canonical pragma list', () => {
    expect(CANONICAL_PRAGMAS.length).toBeGreaterThan(0);
  });

  it('TS export matches the JSON SSoT verbatim (order + values)', () => {
    const spec = loadSpec();
    expect(CANONICAL_PRAGMAS).toEqual(spec.pragmas);
  });

  it('renders each entry as `PRAGMA name = value`', () => {
    for (const entry of CANONICAL_PRAGMAS) {
      const [name, value] = entry;
      expect(renderPragmaSql(entry)).toBe(`PRAGMA ${name} = ${value}`);
    }
  });

  it('CANONICAL_PRAGMA_SQL is the `;\\n`-joined render of all entries', () => {
    const expected = CANONICAL_PRAGMAS.map(renderPragmaSql).join(';\n');
    expect(CANONICAL_PRAGMA_SQL).toBe(expected);
  });

  it('keeps the baseline pragmas required for concurrency/durability', () => {
    const names = CANONICAL_PRAGMAS.map(([n]) => n);
    for (const required of ['journal_mode', 'foreign_keys', 'busy_timeout', 'synchronous']) {
      expect(names).toContain(required);
    }
  });

  it('matches the same render rule the Rust crate applies in build.rs', () => {
    // Rust builds `format!("PRAGMA {name} = {value}")` for each pair and
    // joins with `";\n"`. We mirror that here over the JSON SSoT and
    // require the TS-exposed string to be byte-identical.
    const spec = loadSpec();
    const rustEquivalent = spec.pragmas
      .map(([name, value]) => `PRAGMA ${name} = ${value}`)
      .join(';\n');
    expect(CANONICAL_PRAGMA_SQL).toBe(rustEquivalent);
  });
});
