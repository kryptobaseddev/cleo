/**
 * Wire values and canonical JSON for the journal (spec §2.6). Shared by the
 * sealer and netting (S3a, S3b).
 *
 * @module store/sync/sealer-values
 * @task T12984
 */

/** A typed wire value (§2.6): canonical JSON with typed escapes. */
export type WireValue =
  | string
  | number
  | null
  | { readonly $i: string }
  | { readonly $r: string }
  | { readonly $b: string };

/**
 * Decode one `enc()` text (SQLite `quote()`, or `r<%!.17g>` for REAL) to a
 * typed wire value.
 *
 * @example
 * ```ts
 * decodeEnc("'it''s'");          // "it's"
 * decodeEnc('42');               // 42
 * decodeEnc('9007199254740993'); // { $i: '9007199254740993' }
 * decodeEnc('r0.10000000000000001'); // { $r: '0.10000000000000001' }
 * decodeEnc("X'00FF'");          // { $b: 'AP8=' }
 * decodeEnc('NULL');             // null
 * ```
 * @throws {Error} on text no `enc()` can produce.
 */
export function decodeEnc(text: string): WireValue {
  if (text === 'NULL') return null;
  if (text.startsWith("'") && text.endsWith("'") && text.length >= 2) {
    return text.slice(1, -1).replaceAll("''", "'");
  }
  if (text.startsWith('r')) return { $r: text.slice(1) };
  if (/^[Xx]'[0-9A-Fa-f]*'$/.test(text)) {
    return { $b: Buffer.from(text.slice(2, -1), 'hex').toString('base64') };
  }
  if (/^-?\d+$/.test(text)) {
    const n = Number(text);
    return Number.isSafeInteger(n) ? n : { $i: text };
  }
  throw new Error(`sealer: not an enc() value: ${text.slice(0, 40)}`);
}

/** Canonical JSON: keys sorted at every level. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`)
    .join(',')}}`;
}
