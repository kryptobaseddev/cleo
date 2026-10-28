/**
 * The doc naming rule (T14107, owner decision D11210 "docs never rot"): a
 * published doc's name says what it is about, never when or for which task or
 * session it was written. Task and decision links and dates live in the doc's
 * metadata, so a doc can be updated in place for as long as it is true.
 *
 * A name is lowercase kebab-case, at most 64 characters, and carries no task
 * id (`t1234` as a token), no session id (`ses_…`) and no date (`2026-10-28`,
 * `2026-10`, `20261028`). An ADR keeps its number (`adr-0123-…`) and a release
 * note its version (`v2026.10.27`): those are the doc's identity.
 *
 * @task T14107
 */

import { existsSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';

/** Longest allowed doc name, in characters. */
export const DOC_NAME_MAX_LENGTH = 64;

/** Doc kinds the rule does not govern: per-task working state and release plumbing. */
export const DOC_NAME_EXEMPT_KINDS: readonly string[] = ['rcasd', 'changeset'];

/**
 * Tracked docs that broke the rule before it existed: a shrink-only list the
 * docs census (T14108) empties as it renames them.
 */
export const DOC_NAME_BASELINE_PATH = 'scripts/.docs-name-baseline.json';

/** Why a doc name breaks the rule. */
export type DocNameReason = 'format' | 'length' | 'task-id' | 'session-id' | 'date';

/** A doc name that breaks the rule, why, and a name that would not. */
export interface DocNameViolation {
  /** Every rule the name breaks. */
  reasons: DocNameReason[];
  /** The name with the forbidden tokens removed, in kebab-case. */
  suggestion: string;
}

const KEBAB = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;
const ADR_PREFIX = /^adr-\d{3,4}-/;
const RELEASE_NAME = /^v\d{4}\.\d+\.\d+(-[a-z0-9-]+)?$/;

/** Hyphen/underscore/dot-separated lowercase tokens of a name. */
function tokens(name: string): string[] {
  return name
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

const isTaskToken = (token: string): boolean => /^t\d{3,}$/.test(token);
const isDateToken = (token: string): boolean => /^(19|20)\d{6}$|^(19|20)\d{12}$/.test(token);

/** Whether the name holds a session id: `ses_…`, or `ses` then a numeric token. */
function hasSessionId(name: string): boolean {
  const parts = tokens(name);
  return (
    /(^|[^a-z])ses_/i.test(name) ||
    parts.some((token, i) => token === 'ses' && /^\d+$/.test(parts[i + 1] ?? ''))
  );
}

/** Whether the name holds a calendar date: `YYYY-MM(-DD)`, or `YYYYMMDD`. */
function hasDate(name: string): boolean {
  return (
    /(^|[^0-9])(19|20)\d{2}-(0[1-9]|1[0-2])(-\d{2})?([^0-9]|$)/.test(name) ||
    tokens(name).some(isDateToken)
  );
}

/**
 * A rule-abiding name built from `name`: lowercase kebab-case without task
 * ids, session ids or dates, cut to {@link DOC_NAME_MAX_LENGTH}.
 *
 * @param name - The offending name.
 * @returns The suggested name, or `doc` when nothing is left.
 * @task T14107
 */
export function suggestDocName(name: string): string {
  const parts = tokens(name.replace(/(19|20)\d{2}-\d{2}(-\d{2})?/g, ' '));
  const kept: string[] = [];
  // A session id is `ses` and the numeric tokens after it (`ses_<time>_<n>`).
  let inSession = false;
  for (const token of parts) {
    if (token === 'ses') {
      inSession = true;
      continue;
    }
    if (inSession && /^\d+$/.test(token)) continue;
    inSession = false;
    if (!isTaskToken(token) && !isDateToken(token)) kept.push(token);
  }
  const joined = kept.join('-').replace(/^[^a-z]+/, '');
  return joined.slice(0, DOC_NAME_MAX_LENGTH).replace(/-+$/, '') || 'doc';
}

/**
 * The rule-abiding slug CLEO mints from a title or file name: its subject
 * words in kebab-case, without task ids, session ids or dates, at most
 * `maxLength` characters. Internal writers (ADR allocation, spawn topic slugs,
 * imports) use it so their slugs pass {@link docNameViolation}; the task stays
 * a link on the doc, not part of its name.
 *
 * @param source - The title or file base name.
 * @param maxLength - Longest result, for callers that add a prefix.
 * @returns The slug, or `doc` when the source has no subject words.
 * @task T14129
 */
export function subjectSlug(source: string, maxLength: number = DOC_NAME_MAX_LENGTH): string {
  return suggestDocName(source).slice(0, maxLength).replace(/-+$/, '') || 'doc';
}

/**
 * Check a doc name (a slug, or a published file name without `.md`) against
 * the rule. An ADR's leading number and a release note's version are allowed.
 *
 * @param name - The slug or file base name.
 * @param kind - The doc kind, when known; exempt kinds always pass.
 * @returns The violation, or null when the name is fine.
 * @task T14107
 */
export function docNameViolation(name: string, kind?: string): DocNameViolation | null {
  if (kind !== undefined && DOC_NAME_EXEMPT_KINDS.includes(kind)) return null;
  if (kind === 'release-note' && RELEASE_NAME.test(name)) return null;
  const subject = ADR_PREFIX.test(name) ? name.replace(ADR_PREFIX, '') : name;
  const reasons: DocNameReason[] = [];
  if (!KEBAB.test(name)) reasons.push('format');
  if (name.length > DOC_NAME_MAX_LENGTH) reasons.push('length');
  if (tokens(subject).some(isTaskToken)) reasons.push('task-id');
  if (hasSessionId(subject)) reasons.push('session-id');
  if (hasDate(subject)) reasons.push('date');
  if (reasons.length === 0) return null;
  const prefix = ADR_PREFIX.exec(name)?.[0] ?? '';
  return { reasons, suggestion: `${prefix}${suggestDocName(subject)}` };
}

/** Readable explanation of a violation, for refusals and gate output. */
export function describeDocNameViolation(name: string, violation: DocNameViolation): string {
  const why: Record<DocNameReason, string> = {
    format: 'is not lowercase kebab-case',
    length: `is longer than ${DOC_NAME_MAX_LENGTH} characters`,
    'task-id': 'carries a task id',
    'session-id': 'carries a session id',
    date: 'carries a date',
  };
  return (
    `doc name "${name}" ${violation.reasons.map((r) => why[r]).join(', ')}; ` +
    `name docs by subject (e.g. "${violation.suggestion}") and record task, decision and date links in the doc's metadata`
  );
}

/**
 * Whether a repository path is a published doc the rule governs: a `*.md`
 * under `docs/`, except generated output and `README.md` files.
 *
 * @param path - Repository-relative path, `/`-separated.
 * @returns True when the rule applies.
 */
export function isGovernedDocPath(path: string): boolean {
  return (
    path.startsWith('docs/') &&
    path.endsWith('.md') &&
    !path.startsWith('docs/generated/') &&
    basename(path) !== 'README.md'
  );
}

/** The doc kind a governed path's directory implies, for the kind-specific allowances. */
function kindOfPath(path: string): string | undefined {
  return path.startsWith('docs/release/') ? 'release-note' : undefined;
}

/** One governed doc path and how it breaks the rule. */
export interface DocPathViolation extends DocNameViolation {
  /** Repository-relative path. */
  file: string;
}

/** Result of {@link checkDocNames}. */
export interface DocNameCheck {
  /** Governed paths that break the rule and are not baselined. */
  violations: DocPathViolation[];
  /** Baselined paths that no longer exist or no longer break the rule. */
  stale: string[];
}

/**
 * Check every governed doc path against the rule. A path in the shrink-only
 * baseline is tolerated while it still breaks the rule; a baseline entry that
 * is gone or fixed is stale and must be removed, so the list only shrinks.
 *
 * @param paths - Tracked repository paths.
 * @param baseline - Baselined paths ({@link readDocNameBaseline}).
 * @returns New violations and stale baseline entries.
 * @task T14107
 */
export function checkDocNames(paths: readonly string[], baseline: readonly string[]): DocNameCheck {
  const tolerated = new Set(baseline);
  const breaking = new Map<string, DocNameViolation>();
  for (const file of paths) {
    if (!isGovernedDocPath(file)) continue;
    const violation = docNameViolation(basename(file, '.md'), kindOfPath(file));
    if (violation) breaking.set(file, violation);
  }
  return {
    violations: [...breaking]
      .filter(([file]) => !tolerated.has(file))
      .map(([file, violation]) => ({ file, ...violation })),
    stale: baseline.filter((file) => !breaking.has(file)),
  };
}

/**
 * The baselined doc paths of a repository ({@link DOC_NAME_BASELINE_PATH}).
 *
 * @param root - Repository root.
 * @returns The baselined paths; empty when the file is absent.
 * @throws When the file exists but is not `{ "files": string[] }`.
 */
export function readDocNameBaseline(root: string): string[] {
  const path = join(root, DOC_NAME_BASELINE_PATH);
  if (!existsSync(path)) return [];
  const parsed: unknown = JSON.parse(readFileSync(path, 'utf-8'));
  const files =
    parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as { files?: unknown }).files
      : undefined;
  if (!Array.isArray(files) || files.some((f) => typeof f !== 'string'))
    // @sync-invariant none:input-shape a malformed baseline file is refused before any check runs; nothing is written
    throw new Error(`${DOC_NAME_BASELINE_PATH} must be { "files": string[] }`);
  return files.filter((f): f is string => typeof f === 'string');
}
