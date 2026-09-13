/**
 * Pre-dispatch inference for `cleo add` — file detection, acceptance criteria
 * parsing, and parent-from-session lookup.
 *
 * Extracted from `packages/cleo/src/cli/commands/add.ts` (T1490) so that the
 * CLI layer remains a thin parse-and-delegate shell and all domain inference
 * lives in Core.
 *
 * Callers are responsible for any `process.stderr` output — this module never
 * writes to stdout/stderr directly.
 *
 * @task T1490
 */

import { execFileSync } from 'node:child_process';
import { getTaskAccessor } from '../store/data-accessor.js';
import { currentTask } from '../task-work/index.js';

/**
 * Input parameters for `inferTaskAddParams`.
 */
export interface InferAddParamsInput {
  /** Task title — forwarded to GitNexus query. */
  title: string;
  /** Optional task description — forwarded to GitNexus query for better ranking. */
  description?: string;
  /** When true and `filesRaw` is absent, invoke GitNexus to suggest files. */
  filesInfer?: boolean;
  /** Raw comma-separated file list from the `--files` CLI flag. */
  filesRaw?: string;
  /** Raw acceptance criteria string from the `--acceptance` CLI flag. */
  acceptanceRaw?: string;
  /** Already-resolved parent ID (from `--parent` or `--parent-id` flags). */
  parentRaw?: string;
  /** Task type string — inference is skipped when type is `'epic'`. */
  type?: string;
}

/**
 * Resolved inference results for `cleo add`.
 *
 * Only fields that were resolved or inferred are present; absent fields mean
 * "no change from what the CLI already determined".
 */
export interface InferAddParamsResult {
  /** Resolved file list (from inference or explicit `--files`). */
  files?: string[];
  /**
   * True when `--files-infer` was requested but GitNexus returned no results.
   * The caller should emit a warning to stderr.
   */
  filesInferWarning?: boolean;
  /** Parsed acceptance criteria array. */
  acceptance?: string[];
  /** Parent task ID inferred from the active session's current task. */
  inferredParent?: string;
}

/**
 * Infer files touched by a task from its title and description using GitNexus.
 *
 * Constructs a query from title + description, invokes `gitnexus query --json`,
 * and extracts file paths from the result.
 *
 * Fallback: if GitNexus is unavailable or returns empty results, returns an
 * empty array.
 *
 * @param title - Task title
 * @param description - Optional task description
 * @returns Array of inferred file paths (may be empty)
 *
 * @task T1330
 * @task T1490
 */
export function inferFilesViaGitNexus(title: string, description?: string): string[] {
  const queryText = description ? `${title} ${description}` : title;

  try {
    const output = execFileSync('gitnexus', ['query', '--json', '--limit', '5', queryText], {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const result = JSON.parse(output);
    const files = new Set<string>();

    if (Array.isArray(result)) {
      for (const process of result) {
        if (Array.isArray(process.symbols)) {
          for (const symbol of process.symbols) {
            if (symbol.location && typeof symbol.location === 'string') {
              const match = symbol.location.match(/^([^:]+):/);
              if (match?.[1]) {
                files.add(match[1]);
              }
            }
          }
        }
        if (Array.isArray(process.files)) {
          for (const file of process.files) {
            if (typeof file === 'string') {
              files.add(file);
            }
          }
        }
      }
    }

    return Array.from(files);
  } catch {
    return [];
  }
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
 * Supports two formats:
 * - JSON array: `'["AC1","AC2","AC3"]'` (fast-path; preserved verbatim)
 * - Pipe-separated: `"AC1|AC2|AC3"` (tokenized via `splitAcceptance`)
 *
 * The pipe-separated form uses a bracket+quote+escape-aware tokenizer so
 * criteria containing `ENUM (hot|cold|batch|embed)`, quoted string-unions
 * like `mode: 'realtime-token'|'batch'`, or escaped literals (`\|`) are
 * preserved as single tokens rather than being shredded.
 *
 * @param raw - Raw string from `--acceptance` flag
 * @returns Array of trimmed, non-empty acceptance criteria strings
 *
 * @bug https://github.com/kryptobaseddev/cleo/issues/409
 * @task T1490
 * @task T9839
 */
export function parseAcceptanceCriteria(raw: string): string[] {
  if (raw.trimStart().startsWith('[')) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        return parsed.map((s: unknown) => String(s).trim()).filter(Boolean);
      }
    } catch {
      // Not valid JSON — fall through to pipe-delimited parsing
    }
  }
  return splitAcceptance(raw, '|');
}

/**
 * Resolve pre-dispatch inference parameters for `cleo add`.
 *
 * Performs three inference steps (each independently non-fatal):
 * 1. **File inference** — resolves explicit `--files` CSV or invokes GitNexus
 *    when `--files-infer` is set.
 * 2. **Acceptance criteria parsing** — coerces pipe-separated or JSON-array
 *    `--acceptance` strings to a string array.
 * 3. **Parent inference** — when no explicit parent is set and the task type
 *    is not `'epic'`, looks up the active session's current task and returns
 *    it as `inferredParent`.
 *
 * The function never writes to `process.stderr`; callers are responsible for
 * surfacing `filesInferWarning` and `inferredParent` notices.
 *
 * @param projectRoot - Absolute path to the project root (passed to session lookup)
 * @param input - Resolved CLI flag values
 * @returns Partial inference result; absent fields = no inference available
 *
 * @task T1490
 */
export async function inferTaskAddParams(
  projectRoot: string,
  input: InferAddParamsInput,
): Promise<InferAddParamsResult> {
  const result: InferAddParamsResult = {};

  // ─── 1. File inference ──────────────────────────────────────────────────────
  if (input.filesInfer && !input.filesRaw) {
    const inferredFiles = inferFilesViaGitNexus(input.title, input.description);
    if (inferredFiles.length > 0) {
      result.files = inferredFiles;
    } else {
      result.filesInferWarning = true;
    }
  } else if (input.filesRaw) {
    result.files = input.filesRaw.split(',').map((s) => s.trim());
  }

  // ─── 2. Acceptance criteria parsing ─────────────────────────────────────────
  if (input.acceptanceRaw) {
    result.acceptance = parseAcceptanceCriteria(input.acceptanceRaw);
  }

  // ─── 3. Parent inference from session ────────────────────────────────────────
  // Only infer when:
  //   - No explicit parent was provided (including explicit "none" — user opted out)
  //   - Task type is not 'epic' (epics are root-level containers)
  //
  // T11293: `--parent none` is an explicit opt-out from the depth-2 focused-session
  // auto-parent trap. When the current focus task is at max depth (task depth 2),
  // auto-inference would fail with E_CLEO_DEPTH_EXCEEDED. The user signals "I know
  // this will be unparented — let strict-spine handle the containment check."
  if (!input.parentRaw && input.type !== 'epic') {
    try {
      const accessor = await getTaskAccessor(projectRoot);
      const focusResult = await currentTask(undefined, accessor);
      if (focusResult.currentTask) {
        result.inferredParent = focusResult.currentTask;
      }
    } catch {
      // Session lookup is non-fatal — proceed without inference
    }
  }

  return result;
}
