/**
 * Parser for CLEO-native task-anchored changeset files.
 *
 * A changeset file is a markdown file whose YAML frontmatter (between `---`
 * fences) carries structured fields validated by {@link ChangesetEntrySchema}.
 * The optional markdown body following the closing fence becomes the `notes`
 * field on the parsed entry.
 *
 * Used by:
 * - `scripts/lint-changesets.mjs` — CI gate that rejects malformed entries
 * - future `cleo release plan` aggregator (T9738 follow-up) — rolls up
 *   entries into release manifests
 *
 * @epic T9738
 * @task T9738
 */

import { readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import {
  type ChangesetEntry,
  ChangesetEntrySchema,
  ChangesetYamlInvalidError,
} from '@cleocode/contracts';
import { parse as parseYaml } from 'yaml';

// ─── YAML error introspection (T10105) ───────────────────────────────────────

/**
 * Extract the 1-based line number from a `yaml@2.x` YAMLParseError.
 *
 * The error carries `linePos: [{line, col}, ...]` when the parser localised
 * the failure; returns `null` for non-localised errors or non-YAMLParseError
 * exceptions.
 *
 * @internal
 * @task T10105
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

/**
 * Extract a short snippet (≤ 120 chars) of the offending line for surface
 * in CLI output. Returns `undefined` when the line is out of range so the
 * error envelope omits the field rather than carrying an empty string.
 *
 * @internal
 * @task T10105
 */
function extractSnippet(frontmatter: string, line: number): string | undefined {
  const lines = frontmatter.split(/\r?\n/);
  // YAML line numbers are 1-based; arrays are 0-based.
  const target = lines[line - 1];
  if (target === undefined) return undefined;
  const trimmed = target.length > 120 ? `${target.slice(0, 117)}...` : target;
  return trimmed;
}

// ─── Frontmatter splitting ────────────────────────────────────────────────────

/**
 * Result of separating frontmatter YAML from the markdown body.
 *
 * `frontmatterStartLine` is 1-based and points at the opening `---` fence —
 * used to surface line numbers in parse errors.
 */
interface FrontmatterSplit {
  /** Raw YAML text between the two fences (no trailing newline). */
  frontmatter: string;
  /** Markdown body after the closing fence (with leading whitespace trimmed). */
  body: string;
  /** 1-based line number of the opening `---` fence (always 1 for valid files). */
  frontmatterStartLine: number;
  /** 1-based line number of the closing `---` fence. */
  frontmatterEndLine: number;
}

/**
 * Split a markdown file into its YAML frontmatter and body sections.
 *
 * The file MUST open with a `---` fence on the very first line; whitespace
 * before the fence is not tolerated to keep the parser predictable.
 *
 * @throws {Error} when the file does not start with `---` or has no closing
 *   fence — error message includes the file path and offending line number.
 */
function splitFrontmatter(filePath: string, raw: string): FrontmatterSplit {
  const lines = raw.split(/\r?\n/);
  if (lines[0]?.trim() !== '---') {
    throw new Error(`${filePath}:1 missing opening '---' frontmatter fence`);
  }

  let closingIdx = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i]?.trim() === '---') {
      closingIdx = i;
      break;
    }
  }
  if (closingIdx === -1) {
    throw new Error(`${filePath}:${lines.length} missing closing '---' frontmatter fence`);
  }

  const frontmatter = lines.slice(1, closingIdx).join('\n');
  const body = lines
    .slice(closingIdx + 1)
    .join('\n')
    .replace(/^\s+/, '')
    .replace(/\s+$/, '');

  return {
    frontmatter,
    body,
    frontmatterStartLine: 1,
    frontmatterEndLine: closingIdx + 1,
  };
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Parse a single changeset file at `path` into a validated {@link ChangesetEntry}.
 *
 * @param path Absolute or process-relative path to a `.md` changeset file.
 * @throws {Error} On any of: missing frontmatter fence, malformed YAML, or
 *   schema violation. Error messages include `<path>:<line>` context where
 *   determinable, plus the offending field name from the Zod issue path.
 */
export function parseChangesetFile(path: string): ChangesetEntry {
  const raw = readFileSync(path, 'utf8');
  const split = splitFrontmatter(path, raw);

  let frontmatterData: unknown;
  try {
    frontmatterData = parseYaml(split.frontmatter);
  } catch (err) {
    const parserMessage = err instanceof Error ? err.message : String(err);
    // T10105: surface the offending line. yaml@2.x sets `linePos[0].line` on
    // YAMLParseError; fall back to the frontmatter opening fence (line 1)
    // when the parser did not localize the failure.
    const yamlLine = extractYamlLine(err);
    // Frontmatter starts on line AFTER the opening `---` fence. The reported
    // YAML line is relative to the frontmatter substring; add the offset so
    // the surfaced line number matches the actual file line.
    const line = yamlLine !== null ? split.frontmatterStartLine + yamlLine : null;
    const snippet = yamlLine !== null ? extractSnippet(split.frontmatter, yamlLine) : undefined;
    throw new ChangesetYamlInvalidError({
      file: path,
      line,
      ...(snippet !== undefined ? { snippet } : {}),
      parserMessage,
    });
  }

  if (frontmatterData === null || typeof frontmatterData !== 'object') {
    throw new Error(
      `${path}:${split.frontmatterStartLine} frontmatter must be a YAML mapping (got ${typeof frontmatterData})`,
    );
  }

  // Merge the markdown body into the candidate entry as `notes`, but only when
  // the frontmatter did not already set the field explicitly.
  const candidate: Record<string, unknown> = { ...(frontmatterData as Record<string, unknown>) };
  if (!('notes' in candidate) && split.body.length > 0) {
    candidate.notes = split.body;
  }

  const result = ChangesetEntrySchema.safeParse(candidate);
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => {
        const fieldPath = issue.path.length > 0 ? issue.path.join('.') : '<root>';
        return `  - ${fieldPath}: ${issue.message}`;
      })
      .join('\n');
    throw new Error(`${path}:${split.frontmatterStartLine} changeset schema violation:\n${issues}`);
  }

  // Cross-check: the filename slug should match `id`. This is a strong
  // convention — it keeps git history readable and lets `cleo release plan`
  // address entries by filename. Diverge → loud error.
  const expectedId = basename(path).replace(/\.md$/, '');
  if (result.data.id !== expectedId) {
    throw new Error(
      `${path}:${split.frontmatterStartLine} id '${result.data.id}' does not match filename slug '${expectedId}'`,
    );
  }

  return result.data;
}

/**
 * Parse every changeset file under `dir`, returning the validated entries.
 *
 * Excludes `README.md` (documentation, not an entry) and any non-`.md` file.
 * Returns entries in deterministic alphabetical order by filename so callers
 * (lint, release plan) emit stable output.
 *
 * @throws Re-throws the first schema violation encountered. Use the lint
 *   script for batch validation that surfaces all errors at once.
 */
export function parseChangesetDir(dir: string): ChangesetEntry[] {
  const files = readdirSync(dir)
    .filter((name) => name.endsWith('.md') && name !== 'README.md')
    .sort();

  const entries: ChangesetEntry[] = [];
  for (const file of files) {
    entries.push(parseChangesetFile(join(dir, file)));
  }
  return entries;
}
