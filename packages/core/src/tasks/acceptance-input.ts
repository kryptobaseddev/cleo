/**
 * Canonical task acceptance input normalization, shared by CLI parsing and writes.
 * @task T12197
 */
import { ExitCode } from '@cleocode/contracts';
import { CleoError } from '../errors.js';

/**
 * Validate and normalize an explicitly supplied acceptance array.
 *
 * @remarks
 * Absent input remains undefined. String entries are trimmed and blank strings
 * are dropped; an explicitly empty result remains [] so update can clear it.
 * Entries stay literal, including pipes and quoted unions. Nonstring entries
 * reject the entire input before any task mutation.
 *
 * @param acceptance - Optional array of literal string criteria supplied by the caller.
 * @returns Trimmed nonblank criteria, including an explicit empty array; undefined for absent input.
 * @throws CleoError when the input is not an array or includes a nonstring entry.
 * @example
 * ```typescript
 * const criteria = [' literal a|b ', '', ' verify output '];
 * normalizeAcceptance(criteria);
 * // ['literal a|b', 'verify output']
 * normalizeAcceptance([]); // [] requests an explicit clear on update
 * ```
 */
export function normalizeAcceptance(
  acceptance: readonly string[] | undefined,
): string[] | undefined {
  if (acceptance === undefined) return undefined;
  if (!Array.isArray(acceptance)) {
    throw new CleoError(
      ExitCode.VALIDATION_ERROR,
      'Acceptance criteria must be an array of strings',
    );
  }
  const normalized: string[] = [];
  for (const [index, criterion] of acceptance.entries()) {
    if (typeof criterion !== 'string') {
      throw new CleoError(
        ExitCode.VALIDATION_ERROR,
        `Acceptance criterion ${index + 1} must be a string`,
      );
    }
    const text = criterion.trim();
    if (text) normalized.push(text);
  }
  return normalized;
}

/**
 * Find the previous non-whitespace character in `s` searching backwards from
 * the end. Returns the empty string when `s` is empty or all-whitespace.
 *
 * Used by `splitAcceptance` to detect the string-union continuation rule
 * (gh-409): a `|` between a closing quote and an opening quote is NOT a split.
 *
 * @internal
 */
function lastNonWsChar(s: string): string {
  for (let k = s.length - 1; k >= 0; k--) {
    const c = s[k];
    if (c !== ' ' && c !== '\t' && c !== '\n' && c !== '\r') return c;
  }
  return '';
}

/**
 * Find the next non-whitespace character in `s` starting at index `start`.
 * Returns the empty string when no non-whitespace remains.
 *
 * @internal
 */
function nextNonWsChar(s: string, start: number): string {
  for (let k = start; k < s.length; k++) {
    const c = s[k];
    if (c !== ' ' && c !== '\t' && c !== '\n' && c !== '\r') return c;
  }
  return '';
}

/**
 * Bracket+quote+escape-aware tokenizer for pipe-delimited acceptance criteria.
 *
 * Splits `input` on the top-level `delim` character ONLY — pipes inside
 * brackets/parens/braces or inside single-/double-quoted strings are preserved
 * as part of the current token. A backslash at depth 0 (outside any quote)
 * immediately preceding a delimiter escapes it (treats it as a literal
 * character in the current token).
 *
 * Used by `parseAcceptanceCriteria` to fix the data-corruption bug where
 * naive `String.split('|')` shredded criteria containing `ENUM (a|b|c)` or
 * quoted string-unions like `'realtime-token'|'batch'`.
 *
 * Rules:
 * - Quotes: `"` and `'` open a quote-context; the matching close char ends it.
 *   Inside a quote, `|`, brackets, and escape sequences are passed through
 *   literally (the only thing that exits the quote is the matching close).
 * - Brackets: `(`, `[`, `{` increase depth; `)`, `]`, `}` decrease (clamped
 *   at 0 — unbalanced closing brackets are tolerated, never throw).
 * - Escape: `\|` at depth 0 with no active quote → literal `|` in the token.
 * - Delimiter: `|` is a split point ONLY when depth === 0 AND no active quote
 *   AND it does NOT join two quoted spans. A `|` whose preceding non-whitespace
 *   char in `buf` is a closing quote AND whose next non-whitespace char in
 *   `input` is an opening quote is treated as a continuation (the entire
 *   `'a'|'b'` or `"a"|"b"` expression stays as one token). This is the
 *   gh-409 "string-union" rule used by T239.
 * - Trim: each emitted token is trimmed; empty tokens (after trim) are dropped.
 * - Defensive: unbalanced opening brackets do NOT throw; the unterminated
 *   tail is emitted as a single trailing token (no infinite loop possible —
 *   the loop is bounded by `input.length`).
 *
 * @param input - Raw delimiter-separated string
 * @param delim - Delimiter character (single char; default `|`)
 * @returns Array of trimmed, non-empty tokens
 *
 * @internal
 * @bug https://github.com/kryptobaseddev/cleo/issues/409
 * @task T9839
 */
function splitAcceptance(input: string, delim = '|'): string[] {
  const out: string[] = [];
  let buf = '';
  let depth = 0;
  let quote: string | null = null;
  let i = 0;
  while (i < input.length) {
    const ch = input[i];
    // Escape: \| at depth 0 with no active quote → literal | in the token.
    if (ch === '\\' && input[i + 1] === delim && depth === 0 && quote === null) {
      buf += delim;
      i += 2;
      continue;
    }
    if (quote !== null) {
      // Inside a quote: only the matching close char exits.
      if (ch === quote) quote = null;
      buf += ch;
    } else if (
      (ch === '"' || ch === "'") &&
      input.indexOf(ch, i + 1) !== -1 &&
      // An apostrophe INSIDE or AFTER a word is never a quote opener. `doesn't`
      // and `user's` are prose; `'batch'` is a quoted span. The discriminator is
      // the preceding character, and it must be an ALLOWLIST rather than "not
      // alphanumeric": `stash@{2}'s correction` is possessive even though `}` is
      // not a letter or digit, and the not-alphanumeric form admitted it as a
      // quote opener. With a second such possessive later in the string the
      // quotes balance, the lookahead below is satisfied, and the whole span
      // between them merges — supplied 5, parsed 4 (gh#1339).
      //
      // A quote that really opens a span sits at a token boundary: start of
      // input, whitespace, the delimiter itself, or an opening bracket. Nothing
      // else. A closing bracket, a letter, a digit or a period before it means
      // prose.
      /^$|[\s|([{,=:]$/.test(buf.slice(-1))
    ) {
      // gh#1321 — enter a quote context ONLY when a matching close exists later.
      //
      // An UNMATCHED quote used to open a context that nothing could close, so
      // every remaining delimiter was absorbed and the rest of the input became
      // one token. The common trigger is not exotic input — it is a prose
      // apostrophe:
      //
      //   "ac one|the user doesn't care|ac three"  ->  2 tokens, not 3
      //   "ac one|the user's token|ac three"       ->  2 tokens, not 3
      //
      // Measured: 804 characters of clean input split correctly, so the
      // length hypothesis in the report was a correlation — an unmatched quote
      // swallows the REMAINDER, so longer input loses more criteria. Length
      // governs severity, not occurrence.
      //
      // The lookahead preserves every gh#409 case, because those quotes are
      // balanced by construction (`'realtime-token'|'batch'`). An unmatched
      // quote is now what it almost always is in prose: a literal character.
      quote = ch;
      buf += ch;
    } else if (
      (ch === '(' || ch === '[' || ch === '{') &&
      // gh#1321 — only enter a bracket context when its partner exists later.
      // An unbalanced `(` used to absorb the remainder exactly as an unmatched
      // quote did: `"a|see (note|c|d|e"` became 2 tokens instead of 5. The old
      // docblock promised the tail was "emitted as a single trailing token",
      // which described the corruption rather than preventing it.
      input.indexOf(ch === '(' ? ')' : ch === '[' ? ']' : '}', i + 1) !== -1
    ) {
      depth++;
      buf += ch;
    } else if (ch === ')' || ch === ']' || ch === '}') {
      depth = Math.max(0, depth - 1);
      buf += ch;
    } else if (ch === delim && depth === 0) {
      // gh-409 string-union rule: `'a'|'b'` and `"a"|"b"` stay as one token.
      // If the previous non-ws char in buf is a closing quote AND the next
      // non-ws char in input is an opening quote, treat this `|` as part of
      // the current token (continuation), not as a split point.
      const prev = lastNonWsChar(buf);
      const next = nextNonWsChar(input, i + 1);
      const isUnionContinuation = (prev === "'" || prev === '"') && (next === "'" || next === '"');
      if (isUnionContinuation) {
        buf += ch;
      } else {
        const trimmed = buf.trim();
        if (trimmed) out.push(trimmed);
        buf = '';
      }
    } else {
      buf += ch;
    }
    i++;
  }
  // Flush trailing buffer (also handles unbalanced opens gracefully).
  const trimmed = buf.trim();
  if (trimmed) out.push(trimmed);
  return out;
}

/**
 * Parse acceptance criteria from a raw CLI string.
 *
 * @remarks
 * Supports two formats:
 * - JSON array: `'["AC1","AC2","AC3"]'` (literal entries, normalized whitespace)
 * - Pipe-separated: `"AC1|AC2|AC3"` (tokenized via `splitAcceptance`)
 *
 * The pipe-separated form uses a bracket+quote+escape-aware tokenizer so
 * criteria containing `ENUM (hot|cold|batch|embed)`, quoted string-unions
 * like `mode: 'realtime-token'|'batch'`, or escaped literals (`\|`) are
 * preserved as single tokens rather than being shredded.
 *
 * @param raw - Raw string from `--acceptance` flag
 * @returns Array of trimmed, non-empty acceptance criteria strings
 * @throws CleoError for malformed explicit JSON arrays or nonstring JSON elements.
 * @example
 * ```typescript
 * parseAcceptanceCriteria('first|ENUM (hot|cold)|third');
 * // ['first', 'ENUM (hot|cold)', 'third']
 * const raw = '["literal a|b", " verified "]';
 * parseAcceptanceCriteria(raw);
 * // ['literal a|b', 'verified']
 * ```
 *
 * @bug https://github.com/kryptobaseddev/cleo/issues/409
 * @task T1490
 * @task T9839
 */
export function parseAcceptanceCriteria(raw: string): string[] {
  // A bracketed prose fragment is not necessarily JSON. Preserve existing
  // delimiter behavior unless the first element has explicit JSON syntax.
  const jsonArray = /^\s*\[\s*(?:["[\]{}]|-?\d|true\b|false\b|null\b)/.test(raw);
  if (jsonArray) {
    let parsed: string[];
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new CleoError(ExitCode.VALIDATION_ERROR, 'Invalid JSON acceptance array');
    }
    return normalizeAcceptance(parsed) ?? [];
  }
  return normalizeAcceptance(splitAcceptance(raw, '|')) ?? [];
}
