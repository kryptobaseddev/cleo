/**
 * Envelope projection helpers — RFC 6901 JSON Pointer extraction.
 *
 * `extractByJsonPointer` resolves an RFC 6901 JSON Pointer against an
 * arbitrary envelope (or any plain JSON value) and returns the addressed
 * value. The CLI surfaces this via `--field <pointer>` so agents can
 * extract scalars from dispatch envelopes without a `jq` dependency:
 *
 * ```bash
 * cleo show T123 --field /data/title
 * cleo list --field /data/0/id
 * cleo show T123 --field /data/verification/gates/implemented
 * ```
 *
 * RFC 6901 conformance:
 *   - The empty string `""` references the whole document.
 *   - As a pragmatic extension, a single `/` also references the whole
 *     document (operator convenience — `cleo show T123 --field /` reads
 *     naturally as "the whole thing"). Strict RFC 6901 would interpret
 *     `/` as "the property with the empty-string name", which is never
 *     meaningful for our envelope shape.
 *   - Tokens are decoded per §4: `~1` → `/`, `~0` → `~`.
 *   - Numeric tokens on arrays are interpreted as zero-based indices.
 *   - `undefined` is returned for any missing key, out-of-range index,
 *     or traversal through a non-object/non-array value.
 *
 * @module @cleocode/core/dispatch/projection
 *
 * @epic T9919
 * @task T9929
 * @saga T9855
 */

/**
 * Sentinel returned by {@link extractByJsonPointer} when the pointer
 * does not address any value in the document. CLI callers convert this
 * to `E_FIELD_NOT_FOUND` (exit 4).
 *
 * @public
 */
export type PointerResult = unknown;

/**
 * Decode a single RFC 6901 reference token (§4): `~1` → `/`, `~0` → `~`.
 *
 * The escape order matters — `~1` must be decoded BEFORE `~0` so that
 * the literal sequence `~01` round-trips back to `~1` rather than `/`.
 *
 * @internal
 */
function decodeToken(token: string): string {
  return token.replace(/~1/g, '/').replace(/~0/g, '~');
}

/**
 * Extract a value from a document using an RFC 6901 JSON Pointer.
 *
 * Returns the addressed value, or `undefined` when the pointer does not
 * resolve. Never throws on missing paths — callers translate `undefined`
 * to whatever error semantics they need.
 *
 * @param document - The root document (any JSON value).
 * @param pointer  - RFC 6901 pointer string. Must start with `/`, or be
 *                   the empty string `""`. The single character `/` is
 *                   accepted as an alias for `""` (whole document).
 * @returns The addressed value, or `undefined` when not found.
 *
 * @example
 * ```ts
 * const env = { success: true, data: { task: { id: 'T123', title: 'Fix' } } };
 * extractByJsonPointer(env, '/data/task/title'); // => 'Fix'
 * extractByJsonPointer(env, '/data/0/id');       // => undefined (data is not array)
 * extractByJsonPointer(env, '');                 // => env (whole document)
 * extractByJsonPointer(env, '/');                // => env (CLI convenience alias)
 * ```
 *
 * @public
 */
export function extractByJsonPointer(document: unknown, pointer: string): PointerResult {
  // Whole-document cases — both the strict RFC 6901 empty pointer and
  // the CLI-convenience single-slash alias resolve to the root.
  if (pointer === '' || pointer === '/') return document;

  // RFC 6901 §3: every non-empty pointer MUST start with '/'. A
  // malformed pointer (no leading slash) cannot address anything.
  if (!pointer.startsWith('/')) return undefined;

  // §3: split on '/' AFTER stripping the leading '/' so a pointer like
  // '/a/b' yields the tokens ['a', 'b']. A trailing '/' yields a final
  // empty token, which addresses the empty-string property name —
  // unlikely in practice but kept faithful to the spec.
  const tokens = pointer.slice(1).split('/').map(decodeToken);

  let current: unknown = document;
  for (const token of tokens) {
    if (current === null || current === undefined) return undefined;

    if (Array.isArray(current)) {
      // §4: array indices are unsigned base-10 integers. The token '-'
      // is the special "after the last element" indicator and never
      // resolves to a member during read.
      if (token === '-') return undefined;
      if (!/^(0|[1-9][0-9]*)$/.test(token)) return undefined;
      const index = Number(token);
      if (index >= current.length) return undefined;
      current = current[index];
      continue;
    }

    if (typeof current === 'object') {
      const record = current as Record<string, unknown>;
      if (!Object.hasOwn(record, token)) return undefined;
      current = record[token];
      continue;
    }

    // Cannot descend into a primitive scalar.
    return undefined;
  }

  return current;
}

/**
 * Convenience predicate — `true` when the supplied string is a syntactic
 * RFC 6901 pointer (empty string, or starts with `/`).
 *
 * Used by the CLI to discriminate the JSON-pointer `--field /data/title`
 * form from the legacy fuzzy-field-name form (`--field title`). Pointers
 * are exclusive to scalar extraction; field names go through the legacy
 * `extractFieldFromResult` lookup for backward compatibility.
 *
 * @param value - The candidate string.
 * @returns `true` when `value` is shaped like an RFC 6901 pointer.
 *
 * @public
 */
export function isJsonPointer(value: string): boolean {
  return value === '' || value.startsWith('/');
}

/**
 * Serialize an extracted pointer value for plain-text CLI output.
 *
 * The contract mirrors what scripts and agents expect when piping a
 * `--field <pointer>` invocation:
 *
 *   - `string`           → raw value (no quotes, no trailing newline added here)
 *   - `number | boolean` → `JSON.stringify` form (`true`, `false`, `42`, `0.5`)
 *   - `null`             → the literal `"null"` (matches `JSON.stringify`)
 *   - `object | array`   → `JSON.stringify` with 2-space indentation so
 *                          structured results stay readable for humans
 *                          AND parseable for downstream `jq` / scripts.
 *
 * `undefined` is rejected by the contract — callers must guard against
 * missing-pointer cases before invoking this helper. The function throws
 * on `undefined` so a bug in the CLI surface fails loudly during tests.
 *
 * @param value - The value returned by {@link extractByJsonPointer}.
 * @returns The serialized scalar form, ready for `process.stdout.write`.
 *
 * @public
 */
export function serializePointerValue(value: unknown): string {
  if (value === undefined) {
    throw new TypeError('serializePointerValue: undefined is not serializable');
  }
  if (typeof value === 'string') return value;
  if (value === null || typeof value === 'number' || typeof value === 'boolean') {
    return JSON.stringify(value);
  }
  return JSON.stringify(value, null, 2);
}
