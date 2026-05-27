/**
 * Migration types for markdown-to-CANT conversion.
 *
 * Defines the input/output contracts for the `cant migrate` command
 * and the underlying conversion engine.
 */

/** Options controlling migration behavior. */
export interface MigrationOptions {
  /** Write .cant files to disk (false = dry-run preview). */
  write: boolean;
  /** Show detailed conversion log during migration. */
  verbose: boolean;
  /** Where to write .cant files (default: .cleo/agents/). */
  outputDir?: string;
}

/** Result of migrating a single markdown file. */
export interface MigrationResult {
  /** Absolute path to the input markdown file. */
  inputFile: string;
  /** Array of .cant files produced (or that would be produced in dry-run). */
  outputFiles: ConvertedFile[];
  /** Sections that could not be automatically converted. */
  unconverted: UnconvertedSection[];
  /** Human-readable summary string. */
  summary: string;
}

/** A single converted .cant output file. */
export interface ConvertedFile {
  /** Relative path for the output file (e.g. ".cleo/agents/code-reviewer.cant"). */
  path: string;
  /** Document kind: agent, skill, hook, or workflow. */
  kind: string;
  /** The full .cant file content including frontmatter. */
  content: string;
}

/** A section of markdown that was not converted. */
export interface UnconvertedSection {
  /** 1-based line number where the section starts. */
  lineStart: number;
  /** 1-based line number where the section ends. */
  lineEnd: number;
  /** Human-readable reason why conversion was skipped. */
  reason: string;
  /** The raw markdown content of the section. */
  content: string;
}

/**
 * A parsed markdown section identified by heading.
 *
 * Used internally by the markdown parser to structure
 * the input before classification and conversion.
 */
export interface MarkdownSection {
  /** The heading text (without the `#` prefix). */
  heading: string;
  /** The heading level (2 for ##, 3 for ###, etc.). */
  level: number;
  /** 1-based line number where the section starts. */
  lineStart: number;
  /** 1-based line number where the section ends (inclusive). */
  lineEnd: number;
  /** Lines of content below the heading (excluding the heading line). */
  bodyLines: string[];
  /** Classified type of this section, determined by heuristic matching. */
  classification: SectionClassification;
}

/** Classification of a markdown section for conversion purposes. */
export type SectionClassification =
  | 'agent'
  | 'permissions'
  | 'hook'
  | 'skill'
  | 'workflow'
  | 'unknown';

/**
 * A key-value property extracted from a markdown bullet list.
 *
 * Matches patterns like `- **Key**: value` or `- Key: value`.
 */
export interface ExtractedProperty {
  /** Property key (lowercased, normalized). */
  key: string;
  /** Property value (trimmed). */
  value: string;
}

/**
 * A permission entry extracted from markdown.
 *
 * Matches patterns like `- Tasks: read, write` or `- Read and write tasks`.
 */
export interface ExtractedPermission {
  /** The domain (e.g. "tasks", "session", "memory"). */
  domain: string;
  /** Permission values (e.g. ["read", "write"]). */
  values: string[];
}
