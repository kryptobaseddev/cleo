/**
 * One-time import of a Claude Code memory directory as BRAIN lessons
 * (T13949 part (c), owner decision D11181).
 *
 * A dry run plans every file: which become lessons, which are skipped and why,
 * with the source provenance of each. The plan carries a digest; an apply
 * re-plans the directory and writes only when the digest still matches the
 * approved one, so what is written is exactly what was reviewed. An apply
 * records a receipt (file, sha256, lesson id) before and after writing, and
 * never deletes or edits a source file.
 *
 * Mapping: a `feedback` memory is a process rule and becomes a lesson in the
 * main (global) brain; a `project` memory is a fact about one project and
 * becomes a lesson in that project's brain, so it never reaches other
 * projects' recall or syncs to them. Its frontmatter `description` is the
 * one-line rule (the lesson title) and its body the why. `user` and
 * `reference` memories are not lessons. A memory marked wrong or superseded
 * (its description or first body line starts with PARTLY WRONG, WRONG or
 * SUPERSEDED) and any file the reviewer excludes are skipped. Each lesson's
 * text ends with its provenance line (source file and content hash), so the
 * same file imported twice is deduplicated.
 *
 * Code placed in `packages/core/` per Package-Boundary Check — verified against AGENTS.md.
 *
 * @module memory/lessons-import
 * @task T13949
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { writeJsonFileAtomic } from '../store/file-utils.js';
import { parseMemoryFileFrontmatter } from './import-from-provider.js';
import { lessonRuleError } from './lessons.js';

/** Where each memory type lands as a lesson; other types are skipped. */
const LESSON_SCOPE_BY_TYPE: Readonly<Record<string, LessonImportScope>> = {
  feedback: 'global',
  project: 'project',
};

/** A memory its author marked as no longer true. */
const RETRACTED = /^(?:partly\s+wrong|wrong|superseded)\b/i;

/** Brain a lesson is written to. */
export type LessonImportScope = 'global' | 'project';

/**
 * Source type of imported lessons: agent-written memories, so `agent`
 * confidence in both brains. Each lesson's provenance line names its source
 * file.
 */
const LESSON_IMPORT_SOURCE_TYPE = 'agent' as const;

/** A frontmatter scalar without its surrounding YAML quotes. */
function unquote(value: string): string {
  const text = value.trim();
  if (text.length >= 2 && text.startsWith('"') && text.endsWith('"'))
    return text.slice(1, -1).replace(/\\(["\\])/g, '$1');
  if (text.length >= 2 && text.startsWith("'") && text.endsWith("'"))
    return text.slice(1, -1).replace(/''/g, "'");
  return text;
}

/** One memory file planned as a lesson. */
export interface LessonImportCandidate {
  /** File name inside the source directory. */
  file: string;
  /** SHA-256 of the file's bytes. */
  sha256: string;
  /** Frontmatter `name`, when present. */
  name: string | null;
  /** Frontmatter memory type (`feedback` or `project`). */
  memoryType: string;
  /** Brain the lesson is written to: `global` for feedback, `project` for project memories. */
  scope: LessonImportScope;
  /** The one-line rule (lesson title). */
  rule: string;
  /** The why, ending with the provenance line (lesson text). */
  text: string;
}

/** A memory file the import leaves out, and why. */
export interface LessonImportSkip {
  /** File name inside the source directory. */
  file: string;
  /** Why it is not imported. */
  reason: string;
}

/** What an import would write. */
export interface LessonImportPlan {
  /** Absolute source directory. */
  sourceDir: string;
  /** Files that become lessons, sorted by file name. */
  candidates: LessonImportCandidate[];
  /** Files left out, sorted by file name. */
  skipped: LessonImportSkip[];
  /** Digest of the candidate set (file, content hash, scope); an apply must match it. */
  digest: string;
}

/** One written lesson in a receipt. */
export interface LessonImportWrite {
  /** Source file. */
  file: string;
  /** Source content hash. */
  sha256: string;
  /** Brain the lesson was written to. */
  scope: LessonImportScope;
  /** Lesson id in that brain. */
  id: string;
  /** False when the same lesson already existed (the id names that entry). */
  stored: boolean;
}

/** Receipt of an applied import. */
export interface LessonImportReceipt {
  /** Receipt format version. */
  version: 1;
  /** ISO timestamp of the apply. */
  importedAt: string;
  /** `started` before the first write; `complete` after the last. */
  status: 'started' | 'complete';
  /** Absolute source directory. */
  sourceDir: string;
  /** Approved digest. */
  digest: string;
  /** Lessons written (or found already present), in plan order. */
  written: LessonImportWrite[];
}

/** An import refused before any write. */
export class LessonImportError extends Error {
  /**
   * @param code - Stable error code.
   * @param message - Human-readable reason.
   */
  constructor(
    readonly code: 'E_LESSON_IMPORT_SOURCE' | 'E_LESSON_IMPORT_DIGEST_MISMATCH',
    message: string,
  ) {
    super(message);
    this.name = 'LessonImportError';
  }
}

/**
 * The Claude Code memory directory of a project: `~/.claude/projects/<root
 * with every path separator replaced by '-'>/memory`.
 *
 * @param projectRoot - Absolute project root.
 * @param home - Home directory (for tests).
 * @returns The directory path; it may not exist.
 * @example
 * ```ts
 * defaultLessonImportDir('/Users/me/repo'); // ~/.claude/projects/-Users-me-repo/memory
 * ```
 */
export function defaultLessonImportDir(projectRoot: string, home: string = homedir()): string {
  return join(home, '.claude', 'projects', projectRoot.replace(/[\\/]/g, '-'), 'memory');
}

/**
 * Plan an import: read every `*.md` file except `MEMORY.md` and decide which
 * become lessons, and where. Reads only.
 *
 * @param sourceDir - Memory directory to import.
 * @param options - `exclude`: file names the reviewer dropped; they are skipped
 *   before the digest, so the digest pins the final set.
 * @returns The plan with its digest.
 * @throws LessonImportError when the directory does not exist.
 * @example
 * ```ts
 * const plan = planLessonImport(defaultLessonImportDir(root), { exclude: ['old.md'] });
 * ```
 */
export function planLessonImport(
  sourceDir: string,
  options: { exclude?: readonly string[] } = {},
): LessonImportPlan {
  const excluded = new Set(options.exclude ?? []);
  if (!existsSync(sourceDir))
    // @sync-invariant none:input-shape a missing source directory is refused before any write
    throw new LessonImportError(
      'E_LESSON_IMPORT_SOURCE',
      `Source directory not found: ${sourceDir}`,
    );
  const candidates: LessonImportCandidate[] = [];
  const skipped: LessonImportSkip[] = [];
  const files = readdirSync(sourceDir)
    .filter((file) => file.endsWith('.md') && file !== 'MEMORY.md')
    .sort();
  for (const file of files) {
    if (excluded.has(file)) {
      skipped.push({ file, reason: 'excluded by the reviewer' });
      continue;
    }
    const bytes = readFileSync(join(sourceDir, file));
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const { name, description, type, body } = parseMemoryFileFrontmatter(bytes.toString('utf-8'));
    const scope = type ? LESSON_SCOPE_BY_TYPE[type] : undefined;
    if (!type || !scope) {
      skipped.push({ file, reason: `memory type ${type ?? '(none)'} is not a lesson` });
      continue;
    }
    const rule = unquote(description ?? name ?? '');
    const firstLine =
      body
        .trim()
        .split('\n')[0]
        ?.replace(/^[#>*\s-]+/, '') ?? '';
    if (RETRACTED.test(rule) || RETRACTED.test(firstLine)) {
      skipped.push({ file, reason: 'marked wrong or superseded by its author' });
      continue;
    }
    const ruleError = lessonRuleError(rule);
    if (ruleError) {
      skipped.push({ file, reason: `no usable one-line rule: ${ruleError}` });
      continue;
    }
    if (!body.trim()) {
      skipped.push({ file, reason: 'empty body (no why)' });
      continue;
    }
    const provenance = `Imported from Claude memory ${file} (sha256 ${sha256.slice(0, 16)}).`;
    candidates.push({
      file,
      sha256,
      name: name ?? null,
      memoryType: type,
      scope,
      rule,
      text: `${body.trim()}\n\n${provenance}`,
    });
  }
  const digest = createHash('sha256')
    .update(candidates.map((c) => `${c.file}\0${c.sha256}\0${c.scope}`).join('\n'))
    .digest('hex')
    .slice(0, 16);
  return { sourceDir, candidates, skipped, digest };
}

/** Writes one lesson to the brain its scope names; injectable for tests. */
export type LessonWriter = (lesson: {
  text: string;
  title: string;
  scope: LessonImportScope;
}) => Promise<{ id: string; stored?: boolean }>;

/**
 * Apply an approved import: re-plan the directory with the same exclusions,
 * refuse unless the digest still matches, record a receipt, then write each
 * lesson to the main brain (feedback) or the project brain (project).
 *
 * @param projectRoot - Project whose brain receives project lessons.
 * @param sourceDir - Memory directory to import.
 * @param expectDigest - Digest of the approved dry run.
 * @param receiptPath - Where the receipt is written (before the first write).
 * @param options - `exclude` as in the dry run; `write` overrides the brain writers; `now` for tests.
 * @returns The completed receipt.
 * @throws LessonImportError when the directory changed since the approved plan.
 * @example
 * ```ts
 * const receipt = await applyLessonImport(dir, plan.digest, receiptPath);
 * ```
 */
export async function applyLessonImport(
  projectRoot: string,
  sourceDir: string,
  expectDigest: string,
  receiptPath: string,
  options: { exclude?: readonly string[]; write?: LessonWriter; now?: Date } = {},
): Promise<LessonImportReceipt> {
  const plan = planLessonImport(sourceDir, { exclude: options.exclude ?? [] });
  if (plan.digest !== expectDigest)
    // @sync-invariant none:input-shape the approved plan no longer holds; nothing is written
    throw new LessonImportError(
      'E_LESSON_IMPORT_DIGEST_MISMATCH',
      `The memory directory now plans digest ${plan.digest}, not the approved ${expectDigest}; run the dry run again`,
    );
  const write: LessonWriter =
    options.write ??
    (async ({ scope, ...lesson }) => {
      const params = { ...lesson, type: 'lesson' as const, sourceType: LESSON_IMPORT_SOURCE_TYPE };
      if (scope === 'global') {
        const { observeGlobalBrain } = await import('./global-brain.js');
        return observeGlobalBrain(params);
      }
      const { observeBrain } = await import('./retrieval/observe.js');
      return observeBrain(projectRoot, params);
    });
  const receipt: LessonImportReceipt = {
    version: 1,
    importedAt: (options.now ?? new Date()).toISOString(),
    status: 'started',
    sourceDir: plan.sourceDir,
    digest: plan.digest,
    written: [],
  };
  mkdirSync(dirname(receiptPath), { recursive: true });
  writeJsonFileAtomic(receiptPath, receipt);
  for (const candidate of plan.candidates) {
    const result = await write({
      text: candidate.text,
      title: candidate.rule,
      scope: candidate.scope,
    });
    receipt.written.push({
      file: candidate.file,
      sha256: candidate.sha256,
      scope: candidate.scope,
      id: result.id,
      stored: result.stored !== false,
    });
    // Each write is recorded as it lands, so an interrupted import names every lesson it made.
    writeJsonFileAtomic(receiptPath, receipt);
  }
  const complete: LessonImportReceipt = { ...receipt, status: 'complete' };
  writeJsonFileAtomic(receiptPath, complete);
  return complete;
}

/**
 * Default receipt path of an applied lessons import.
 *
 * @param projectRoot - Project root.
 * @param importedAt - ISO timestamp of the apply.
 * @returns Absolute path under `.cleo/backups/migrations/`.
 * @example
 * ```ts
 * defaultLessonImportReceiptPath(root, '2026-10-24T00:00:00.000Z');
 * ```
 */
export function defaultLessonImportReceiptPath(projectRoot: string, importedAt: string): string {
  return join(
    projectRoot,
    '.cleo',
    'backups',
    'migrations',
    `lessons-import-${importedAt.replace(/[:.]/g, '-')}.json`,
  );
}
