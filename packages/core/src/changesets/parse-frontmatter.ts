/**
 * Changeset frontmatter parser — pure-function variant of
 * {@link parseChangesetFile} that operates on an in-memory string body rather
 * than a filesystem path.
 *
 * ## Why a second parser?
 *
 * {@link parseChangesetFile} is the canonical reader used by the linter and
 * the release-plan aggregator: it accepts a path, reads the file, splits
 * frontmatter, and re-validates the slug against the filename. That contract
 * fits the read side perfectly.
 *
 * The write side ({@link writeChangesetEntry} delegation from
 * `cleo docs add --type changeset`) needs a slightly different shape:
 *   1. The input bytes already live in memory (the dispatch handler just
 *      read them via `fs/promises.readFile`).
 *   2. The slug comes from the CLI `--slug` flag — there is no file on disk
 *      yet, so the filename-vs-id cross-check inside `parseChangesetFile`
 *      cannot apply.
 *   3. Missing frontmatter MUST be reported as a structured `{ error }` so
 *      the caller can map it to the `E_REQUIRES_CHANGESET_VERB` envelope
 *      that hints the operator at `cleo changeset add`. Throwing here would
 *      force the caller into try/catch + string-match — every callsite
 *      already discriminates on tagged unions and we want to keep that
 *      consistency.
 *
 * Both parsers consume the same {@link ChangesetEntrySchema}, so the
 * structural contract is shared — there is no divergence in what counts
 * as a valid entry.
 *
 * @task T10367
 * @epic T10290
 * @saga T10288
 */

import {
  type ChangesetEntry,
  ChangesetEntrySchema,
  ChangesetYamlInvalidError,
} from '@cleocode/contracts';
import { parse as parseYaml } from 'yaml';

// ─── Result types ────────────────────────────────────────────────────────────

/**
 * Discriminated outcome of {@link parseChangesetFrontmatter}.
 *
 * On success the `entry` is a fully-validated {@link ChangesetEntry}. On
 * failure the `error` discriminator carries enough context for the caller
 * to map it to a CLI envelope without re-parsing:
 *
 *   - `'missing-frontmatter'`  — file lacks `---` fences entirely (the
 *     most common reason `cleo docs add --type changeset` should redirect
 *     the operator at `cleo changeset add`).
 *   - `'missing-required'`     — frontmatter present but at least one
 *     required schema field is absent. `missing` lists the field names
 *     (top-level only).
 *   - `'yaml-invalid'`         — frontmatter present but unparseable —
 *     surfaces the underlying parser message + 1-based line offset (if
 *     the YAML parser localised it) for human-friendly diagnostics.
 *   - `'schema-invalid'`       — every required field is present but at
 *     least one validation rule failed (e.g. bad `kind`, malformed task
 *     ID). `issues` is the human-readable bullet list.
 */
export type ParseChangesetFrontmatterResult =
  | { readonly ok: true; readonly entry: ChangesetEntry }
  | { readonly ok: false; readonly error: 'missing-frontmatter' }
  | {
      readonly ok: false;
      readonly error: 'missing-required';
      readonly missing: readonly string[];
    }
  | {
      readonly ok: false;
      readonly error: 'yaml-invalid';
      readonly parserMessage: string;
      readonly line?: number;
    }
  | {
      readonly ok: false;
      readonly error: 'schema-invalid';
      readonly issues: readonly string[];
    };

// ─── Required-field surface (mirrors ChangesetEntrySchema) ───────────────────

/**
 * Top-level required fields on a changeset entry.
 *
 * Kept hand-aligned with {@link ChangesetEntrySchema} so the parser can
 * report a clean `missing` list without traversing Zod's issue tree. A drift
 * here is caught by the schema-validation pass that runs immediately after
 * the required-field check — the test suite asserts that every name in this
 * array corresponds to a `.min(1)` (or non-`.optional()`) field on the
 * schema.
 */
const REQUIRED_FIELDS = ['id', 'tasks', 'kind', 'summary'] as const;

// ─── Splitter — accepts in-memory body, returns raw frontmatter + body ───────

/**
 * Internal: split an in-memory markdown body into `{ frontmatter, body }`.
 *
 * Mirrors the path-based splitter in {@link parser.ts} but returns `null`
 * instead of throwing when the input lacks a frontmatter fence — the caller
 * maps `null` → `error: 'missing-frontmatter'` so the redirect hint can
 * surface without a try/catch.
 *
 * @internal
 */
function splitInMemory(raw: string): { frontmatter: string; body: string } | null {
  const lines = raw.split(/\r?\n/);
  if (lines[0]?.trim() !== '---') {
    return null;
  }
  let closingIdx = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i]?.trim() === '---') {
      closingIdx = i;
      break;
    }
  }
  if (closingIdx === -1) {
    return null;
  }
  const frontmatter = lines.slice(1, closingIdx).join('\n');
  const body = lines
    .slice(closingIdx + 1)
    .join('\n')
    .replace(/^\s+/, '')
    .replace(/\s+$/, '');
  return { frontmatter, body };
}

// ─── YAML error introspection (shared with parser.ts) ────────────────────────

/**
 * Extract the 1-based line offset of a YAML parse failure.
 *
 * `yaml@2.x` sets `linePos: [{line, col}, ...]` on `YAMLParseError`. Returns
 * `null` when the parser failed to localise the error or the exception is
 * not a YAMLParseError.
 *
 * @internal
 */
function extractYamlLine(err: unknown): number | null {
  if (err === null || typeof err !== 'object') return null;
  const linePos = (err as { linePos?: unknown }).linePos;
  if (!Array.isArray(linePos) || linePos.length === 0) return null;
  const first = linePos[0];
  if (first === null || typeof first !== 'object') return null;
  const line = (first as { line?: unknown }).line;
  return typeof line === 'number' ? line : null;
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Parse changeset frontmatter from an in-memory markdown body.
 *
 * The body must follow the same `---`-fenced YAML + markdown-body layout
 * that {@link parseChangesetFile} consumes. The optional markdown body
 * after the closing fence is merged into the entry as `notes` (only when
 * the frontmatter did not already set the field).
 *
 * Unlike {@link parseChangesetFile} this function does NOT cross-check the
 * `id` against a filename — the slug comes from the CLI flag and the entry
 * is what we are about to write. Cross-checking the slug against the
 * frontmatter `id` is the caller's responsibility (the dispatch handler
 * does this and emits `E_SLUG_MISMATCH` when they diverge).
 *
 * @param raw - Full markdown body (frontmatter + body) as a string.
 * @returns Discriminated outcome — never throws.
 *
 * @task T10367
 *
 * @example
 * ```ts
 * const raw = `---
 * id: t10367-example
 * tasks: [T10367]
 * kind: feat
 * summary: example entry
 * ---
 * Body text here.
 * `;
 * const out = parseChangesetFrontmatter(raw);
 * if (out.ok) {
 *   console.log(out.entry.id); // 't10367-example'
 * }
 * ```
 */
export function parseChangesetFrontmatter(raw: string): ParseChangesetFrontmatterResult {
  // ── 1. Split frontmatter from body. ──
  const split = splitInMemory(raw);
  if (split === null) {
    return { ok: false, error: 'missing-frontmatter' };
  }

  // ── 2. Parse the YAML frontmatter. ──
  let frontmatterData: unknown;
  try {
    frontmatterData = parseYaml(split.frontmatter);
  } catch (err) {
    const parserMessage = err instanceof Error ? err.message : String(err);
    const yamlLine = extractYamlLine(err);
    // Re-use the contracts error class so downstream catch sites that
    // already know how to unpack it remain stable.
    void ChangesetYamlInvalidError;
    return yamlLine !== null
      ? { ok: false, error: 'yaml-invalid', parserMessage, line: yamlLine }
      : { ok: false, error: 'yaml-invalid', parserMessage };
  }

  // ── 3. Defensive object-shape check. ──
  if (frontmatterData === null || typeof frontmatterData !== 'object') {
    // Same shape as `schema-invalid` so the caller can render one path.
    return {
      ok: false,
      error: 'schema-invalid',
      issues: [`frontmatter must be a YAML mapping (got ${typeof frontmatterData})`],
    };
  }

  // ── 4. Required-field surface check — fast-path for the most common
  //       failure mode (operator pointed at a plain markdown file with no
  //       changeset frontmatter at all, or only some of the fields).
  const candidate: Record<string, unknown> = { ...(frontmatterData as Record<string, unknown>) };
  if (!('notes' in candidate) && split.body.length > 0) {
    candidate.notes = split.body;
  }

  const missing: string[] = [];
  for (const field of REQUIRED_FIELDS) {
    const value = candidate[field];
    if (value === undefined || value === null) {
      missing.push(field);
      continue;
    }
    if (typeof value === 'string' && value.length === 0) {
      missing.push(field);
      continue;
    }
    if (Array.isArray(value) && value.length === 0) {
      missing.push(field);
    }
  }
  if (missing.length > 0) {
    return { ok: false, error: 'missing-required', missing };
  }

  // ── 5. Schema validation (covers cross-field rules like
  //       `breaking` required when `kind === 'breaking'`). ──
  const result = ChangesetEntrySchema.safeParse(candidate);
  if (!result.success) {
    const issues = result.error.issues.map((issue) => {
      const fieldPath = issue.path.length > 0 ? issue.path.join('.') : '<root>';
      return `${fieldPath}: ${issue.message}`;
    });
    return { ok: false, error: 'schema-invalid', issues };
  }

  return { ok: true, entry: result.data };
}
