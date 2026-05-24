/**
 * SQLite version pin assertion — T10313 (Saga T10281 / Epic T10283).
 *
 * `specs/sqlite-pragmas.json` declares `sqliteVersionPin.version` — the
 * node:sqlite SQLite library version that the CLEO project is currently
 * pinned against. The live brain.db malformation recorded in Saga T10281
 * on 2026-05-23 (`epic:T1075` signature, `ERR_SQLITE_ERROR errcode=11`)
 * occurred under node:sqlite v3.51.2; upstream concurrent-write race is
 * suspected per T10301 RCA (D012).
 *
 * The pin is held until the upstream fix is confirmed via
 * `https://sqlite.org/src/timeline`.
 *
 * **Soft pin semantics**: this test logs a warning when
 * `process.versions.sqlite` differs from the declared pin but does NOT
 * fail the suite. Hard-failing on every Node minor release would break
 * the whole pipeline; the goal is observability + a deliberate review
 * step when the upstream library changes.
 *
 * The assertion that DOES fail: the JSON SSoT must declare a
 * `sqliteVersionPin` block with a well-formed `version` string. That
 * guarantees the pin can never be silently removed.
 *
 * @task T10313
 * @saga T10281
 * @epic T10283
 * @see specs/sqlite-pragmas.json (SSoT for the pin)
 * @see packages/core/src/store/sqlite-pragmas.ts (consumer docs)
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Shape of the SQLite version pin block in `specs/sqlite-pragmas.json`.
 * Only the fields this test consumes are typed.
 */
interface SqliteVersionPin {
  readonly version: string;
  readonly source: string;
  readonly nodeMinimum: string;
  readonly upstreamBugTracker: string;
  readonly rationale: string;
}

/**
 * Shape of the parts of `specs/sqlite-pragmas.json` this test reads.
 */
interface SqlitePragmaSpecWithPin {
  readonly version: number;
  readonly sqliteVersionPin: SqliteVersionPin;
}

/**
 * Load the SSoT JSON from the repo specs directory.
 */
function loadSpec(): SqlitePragmaSpecWithPin {
  const here = dirname(fileURLToPath(import.meta.url));
  // packages/core/src/__tests__/ → repo root is 5 levels up
  const specPath = resolve(here, '..', '..', '..', '..', 'specs', 'sqlite-pragmas.json');
  const raw = readFileSync(specPath, 'utf8');
  return JSON.parse(raw) as SqlitePragmaSpecWithPin;
}

/** Match `X.Y.Z` semver-ish strings (numbers only — no pre-release tags). */
const SEMVER_TRIPLE = /^\d+\.\d+\.\d+$/;

describe('sqlite version pin (T10313 · Saga T10281)', () => {
  it('specs/sqlite-pragmas.json declares a well-formed sqliteVersionPin block', () => {
    const spec = loadSpec();
    expect(spec.sqliteVersionPin).toBeDefined();

    const pin = spec.sqliteVersionPin;
    expect(typeof pin.version).toBe('string');
    expect(pin.version).toMatch(SEMVER_TRIPLE);

    expect(typeof pin.nodeMinimum).toBe('string');
    expect(pin.nodeMinimum).toMatch(SEMVER_TRIPLE);

    expect(typeof pin.source).toBe('string');
    expect(pin.source.length).toBeGreaterThan(0);

    expect(typeof pin.upstreamBugTracker).toBe('string');
    expect(pin.upstreamBugTracker).toMatch(/^https?:\/\//);

    expect(typeof pin.rationale).toBe('string');
    expect(pin.rationale.length).toBeGreaterThan(20);
  });

  it('warns (but does not fail) when process.versions.sqlite drifts from the pin', () => {
    const spec = loadSpec();
    const declared = spec.sqliteVersionPin.version;
    const actual = process.versions.sqlite;

    // process.versions.sqlite is set by node:sqlite on Node >= 22.5 with
    // --experimental-sqlite, and unconditionally on Node 24+. If the
    // runtime is older or the field is absent, skip the comparison (the
    // pin still asserts via the structural test above).
    if (typeof actual !== 'string' || actual.length === 0) {
      // eslint-disable-next-line no-console
      console.warn(
        `[T10313] process.versions.sqlite is not exposed by this Node runtime — ` +
          `pin comparison skipped (declared pin: ${declared}).`,
      );
      return;
    }

    if (actual !== declared) {
      // eslint-disable-next-line no-console
      console.warn(
        `[T10313] node:sqlite drift detected: process.versions.sqlite=${actual} ` +
          `but specs/sqlite-pragmas.json sqliteVersionPin.version=${declared}. ` +
          `Saga T10281 records the live brain.db malformation under ${declared}; ` +
          `if upstream has shipped a fix, confirm via ` +
          `${spec.sqliteVersionPin.upstreamBugTracker} and bump the pin.`,
      );
    }

    // Soft pin: always pass. The warning above is the signal.
    expect(typeof actual).toBe('string');
  });

  it('declares an upstream bug-tracker URL for traceability', () => {
    const spec = loadSpec();
    const url = spec.sqliteVersionPin.upstreamBugTracker;
    expect(url).toMatch(/^https?:\/\/.+/);
  });
});
