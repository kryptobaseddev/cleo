/**
 * Pragma SSoT loader for `cleo doctor db-substrate` drift detection (T10310).
 *
 * Exposes the canonical (pragma → expected-value) map used by the per-DB
 * pragma walker. Sourced from a TypeScript literal that MUST stay
 * byte-equivalent to `specs/sqlite-pragmas.json` v1 (mirrors the pattern
 * established by `packages/core/src/store/sqlite-pragmas.ts` for T9157
 * — embedded literal avoids `readFileSync` paths that break in
 * npm-installed consumers).
 *
 * The drift walker checks the six pragmas declared in
 * `specs/sqlite-pragmas.json#driftPragmas` (the AC list for T10310):
 *
 *   - `journal_mode`, `busy_timeout`, `synchronous`, `foreign_keys` —
 *     also live in `pragmas` (T9157 SSoT).
 *   - `page_size`, `application_id` — additional file-level invariants
 *     declared in the JSON spec's `fileInvariants` array.
 *
 * The equivalence test in `__tests__/pragma-ssot.test.ts` asserts this
 * module's embedded literal matches the on-disk JSON exactly so the
 * two cannot drift silently.
 *
 * @task T10310
 * @epic T10283
 * @saga T10281
 * @see specs/sqlite-pragmas.json
 * @see packages/core/src/store/sqlite-pragmas.ts (sibling embedded SSoT
 *      for the performance pragma applier — same pattern for the same
 *      installability reason)
 */

/**
 * One canonical (name, value) pair from the SSoT — exposed as a
 * `readonly tuple` to keep callers honest about immutability.
 */
export type PragmaSsotEntry = readonly [name: string, expectedValue: string];

/**
 * Result of {@link loadPragmaSsot}.
 *
 * `expectedByName` is the (lower-cased name) → expected-value map the
 * walker uses for O(1) lookups. `driftPragmas` is the ordered list of
 * pragma names the walker queries, derived directly from the SSoT
 * `driftPragmas` array.
 */
export interface PragmaSsot {
  /** Ordered list of (pragma, expected) pairs from `pragmas` + `fileInvariants`. */
  readonly entries: readonly PragmaSsotEntry[];
  /**
   * Lowercased pragma-name → expected-value lookup. Keys are lower-cased
   * because SQLite returns pragma names lower-cased on output (and
   * stores them case-insensitively).
   */
  readonly expectedByName: ReadonlyMap<string, string>;
  /**
   * Ordered list of pragma names the drift walker queries — mirrors
   * `specs/sqlite-pragmas.json#driftPragmas`. Every entry MUST resolve
   * via {@link expectedByName} or the walker throws at load time
   * (caught and surfaced as an empty drift array — a misconfigured SSoT
   * should not break the substrate survey).
   */
  readonly driftPragmas: readonly string[];
}

/**
 * Embedded byte-equivalent mirror of `specs/sqlite-pragmas.json`.
 * Keep in sync with that file. The pragma-ssot-test asserts equivalence
 * against the on-disk JSON when the repo layout is present.
 */
const EMBEDDED_SSOT = {
  // Same shape as sqlite-pragmas.ts SPEC, plus `fileInvariants` and
  // `driftPragmas`. Only the fields we consume are typed.
  pragmas: [
    ['busy_timeout', '30000'],
    ['journal_mode', 'WAL'],
    ['synchronous', 'NORMAL'],
    ['foreign_keys', 'ON'],
    ['cache_size', '-64000'],
    ['mmap_size', '268435456'],
    ['temp_store', 'MEMORY'],
    ['wal_autocheckpoint', '1000'],
  ] as ReadonlyArray<readonly [string, string]>,
  fileInvariants: [
    ['page_size', '4096'],
    ['application_id', '0'],
  ] as ReadonlyArray<readonly [string, string]>,
  driftPragmas: [
    'journal_mode',
    'busy_timeout',
    'foreign_keys',
    'synchronous',
    'page_size',
    'application_id',
  ] as readonly string[],
} as const;

/**
 * Build the pragma SSoT used by the drift walker.
 *
 * @remarks
 * Implementation intentionally returns the embedded literal — no
 * `readFileSync`. The on-disk JSON spec is the canonical source for
 * human review and the Rust applicator, but at runtime the TS side
 * relies on the embedded mirror for npm-install safety (matches the
 * T9157 pattern). The test suite asserts byte-equivalence.
 *
 * @returns A fully-populated {@link PragmaSsot}.
 *
 * @task T10310
 */
export function loadPragmaSsot(): PragmaSsot {
  const entries: PragmaSsotEntry[] = [...EMBEDDED_SSOT.pragmas, ...EMBEDDED_SSOT.fileInvariants];
  const expectedByName = new Map<string, string>();
  for (const [name, value] of entries) {
    expectedByName.set(name.toLowerCase(), value);
  }
  return {
    entries,
    expectedByName,
    driftPragmas: EMBEDDED_SSOT.driftPragmas,
  };
}

/**
 * Canonical pragma name-synonyms that need a post-query normalisation
 * step before equality is asserted.
 *
 * SQLite returns several pragma values as integer codes rather than the
 * symbolic name that the SSoT records:
 *
 *   - `synchronous`: `0`=OFF, `1`=NORMAL, `2`=FULL, `3`=EXTRA.
 *   - `foreign_keys`: `0`=OFF, `1`=ON.
 *
 * The walker resolves the actual integer code to the canonical symbolic
 * name before comparing against the SSoT so the equality check is
 * meaningful.
 *
 * @task T10310
 */
export const PRAGMA_VALUE_NORMALISERS: ReadonlyMap<string, ReadonlyMap<string, string>> = new Map([
  [
    'synchronous',
    new Map<string, string>([
      ['0', 'OFF'],
      ['1', 'NORMAL'],
      ['2', 'FULL'],
      ['3', 'EXTRA'],
    ]),
  ],
  [
    'foreign_keys',
    new Map<string, string>([
      ['0', 'OFF'],
      ['1', 'ON'],
    ]),
  ],
]);

/**
 * Normalise a raw pragma value to its canonical form for comparison.
 *
 * @remarks
 * - For pragmas with integer-coded values (see
 *   {@link PRAGMA_VALUE_NORMALISERS}), resolves the integer to its
 *   symbolic name (`'1'` → `'ON'`).
 * - Otherwise returns the input upper-cased to make the comparison
 *   case-insensitive (`'wal'` → `'WAL'`, `'memory'` → `'MEMORY'`).
 *
 * @param pragmaName - Pragma name (case-insensitive).
 * @param rawValue - Raw value as returned by `PRAGMA <name>`.
 * @returns Normalised value suitable for string-equality comparison
 *   against the SSoT.
 *
 * @task T10310
 */
export function normalisePragmaValue(pragmaName: string, rawValue: string): string {
  const normaliser = PRAGMA_VALUE_NORMALISERS.get(pragmaName.toLowerCase());
  if (normaliser !== undefined) {
    const resolved = normaliser.get(rawValue);
    if (resolved !== undefined) {
      return resolved.toUpperCase();
    }
  }
  return rawValue.toUpperCase();
}
