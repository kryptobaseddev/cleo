/**
 * Conflict-report markdown PARSER (sister to {@link writeConflictReport} in
 * `restore-conflict-report.ts`).
 *
 * Extracted from `packages/cleo/src/cli/commands/restore.ts` per the
 * AGENTS.md Package-Boundary Check (T9985 / E8-CLI-LAYERING). The parser is
 * a pure string transformation — it has no citty / process / fs deps — so it
 * belongs in core where it can be unit-tested without spinning up the CLI
 * and reused by any consumer (Studio routes, programmatic restore tooling,
 * scripts) that needs to read the `restore-conflicts.md` produced by the
 * T311 restore engine.
 *
 * @task T9985
 * @epic T9985 (E8-CLI-LAYERING)
 * @saga T9977 (SG-WORKTRUNK-OWN)
 * @see packages/core/src/store/restore-conflict-report.ts — formatter (sister)
 */

/**
 * Canonical set of JSON config filenames that are valid restore-conflict
 * targets. Used by both the parser and by `cleo restore finalize` to
 * validate caller-supplied filenames.
 *
 * @public
 */
export const RESTORE_VALID_JSON_FILENAMES: ReadonlySet<string> = new Set<string>([
  'config.json',
  'project-info.json',
  'project-context.json',
]);

/**
 * Filenames recognised by the conflict-report parser, as a union type so
 * downstream code can narrow safely.
 *
 * @public
 */
export type RestoreConflictFilename = 'config.json' | 'project-info.json' | 'project-context.json';

/**
 * A single field entry parsed from the conflict report.
 *
 * @public
 */
export interface ParsedResolution {
  /** Which section of the report this came from. */
  section: 'auto' | 'manual';
  /** The target JSON file on disk. */
  filename: RestoreConflictFilename;
  /** Dot-separated field path (e.g. "hooks.preCommit"). */
  fieldPath: string;
  /** The local (A) value, may be undefined if not present. */
  localValue: unknown;
  /** The imported (B) value, may be undefined if not present. */
  importedValue: unknown;
  /** The chosen resolution. */
  resolution: 'A' | 'B' | 'manual-review';
}

/**
 * Parse a backtick-quoted value from a markdown line such as:
 *   `"openai"` → "openai"
 *   `true`     → true
 *   `42`       → 42
 *   _(not present)_ → undefined
 *
 * @public
 */
export function parseMarkdownValue(raw: string): unknown {
  const trimmed = raw.trim();
  if (trimmed === '_(not present)_' || trimmed === '') return undefined;
  // Strip surrounding backticks if present
  const stripped = trimmed.replace(/^`([\s\S]*)`$/, '$1').trim();
  // Try JSON parse for booleans, numbers, quoted strings, objects, arrays
  try {
    return JSON.parse(stripped);
  } catch {
    // Return as-is string if JSON parse fails
    return stripped;
  }
}

/**
 * Set a value at a dot-separated path within a plain object tree,
 * creating intermediate objects as needed.
 *
 * @public
 */
export function setAtPath(obj: Record<string, unknown>, dotPath: string, value: unknown): void {
  const parts = dotPath.split('.');
  let curr: Record<string, unknown> = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const key = parts[i] as string;
    if (curr[key] === undefined || typeof curr[key] !== 'object' || curr[key] === null) {
      curr[key] = {};
    }
    curr = curr[key] as Record<string, unknown>;
  }
  const lastKey = parts[parts.length - 1] as string;
  curr[lastKey] = value;
}

/**
 * Parse a restore-conflicts.md markdown report into an array of
 * {@link ParsedResolution} entries.
 *
 * The format produced by T357 is:
 * ```
 * ## config.json
 * ### Resolved (auto-applied)
 * - `field.path`
 *   - Local (A): `value`
 *   - Imported (B): `value`
 *   - Resolution: **A**
 *   - Rationale: ...
 * ### Manual review needed
 * - `field.path`
 *   - Local (A): `value`
 *   - Imported (B): `value`
 *   - Resolution: **manual-review**
 *   - Rationale: ...
 * ```
 *
 * @task T365
 * @epic T311
 * @public
 */
export function parseConflictReport(md: string): ParsedResolution[] {
  const results: ParsedResolution[] = [];

  const VALID_FILENAMES = RESTORE_VALID_JSON_FILENAMES;

  // Split into lines for state-machine parsing
  const lines = md.split('\n');

  let currentFilename: ParsedResolution['filename'] | null = null;
  let currentSection: 'auto' | 'manual' | null = null;

  // State for the current field entry being accumulated
  let entryField: string | null = null;
  let entryLocalRaw: string | null = null;
  let entryImportedRaw: string | null = null;
  let entryResolution: 'A' | 'B' | 'manual-review' | null = null;

  /** Flush the current accumulated entry if complete. */
  function flushEntry(): void {
    if (
      entryField !== null &&
      entryResolution !== null &&
      currentFilename !== null &&
      currentSection !== null
    ) {
      results.push({
        section: currentSection,
        filename: currentFilename,
        fieldPath: entryField,
        localValue: entryLocalRaw !== null ? parseMarkdownValue(entryLocalRaw) : undefined,
        importedValue: entryImportedRaw !== null ? parseMarkdownValue(entryImportedRaw) : undefined,
        resolution: entryResolution,
      });
    }
    entryField = null;
    entryLocalRaw = null;
    entryImportedRaw = null;
    entryResolution = null;
  }

  for (const line of lines) {
    // ## <filename> heading
    const fileHeading = /^##\s+(.+\.json)\s*$/.exec(line);
    if (fileHeading) {
      flushEntry();
      const name = fileHeading[1]?.trim() ?? '';
      currentFilename = VALID_FILENAMES.has(name) ? (name as ParsedResolution['filename']) : null;
      currentSection = null;
      continue;
    }

    // ### section heading
    const sectionHeading = /^###\s+(.+)$/.exec(line);
    if (sectionHeading) {
      flushEntry();
      const headingText = (sectionHeading[1] ?? '').toLowerCase();
      if (headingText.includes('manual')) {
        currentSection = 'manual';
      } else if (headingText.includes('resolved') || headingText.includes('auto')) {
        currentSection = 'auto';
      } else {
        currentSection = null;
      }
      continue;
    }

    if (currentFilename === null || currentSection === null) continue;

    // - `field.path`  — starts a new field entry
    const fieldLine = /^-\s+`([^`]+)`\s*$/.exec(line);
    if (fieldLine) {
      flushEntry();
      entryField = fieldLine[1] ?? null;
      continue;
    }

    if (entryField === null) continue;

    // Sub-bullets:  - Local (A): `value`
    const localLine = /^\s+-\s+Local\s+\(A\):\s+(.+)$/.exec(line);
    if (localLine) {
      entryLocalRaw = localLine[1] ?? '';
      continue;
    }

    // - Imported (B): `value`
    const importedLine = /^\s+-\s+Imported\s+\(B\):\s+(.+)$/.exec(line);
    if (importedLine) {
      entryImportedRaw = importedLine[1] ?? '';
      continue;
    }

    // - Resolution: **X**
    const resolutionLine = /^\s+-\s+Resolution:\s+\*\*([^*]+)\*\*/.exec(line);
    if (resolutionLine) {
      const resText = (resolutionLine[1] ?? '').trim();
      if (resText === 'A') {
        entryResolution = 'A';
      } else if (resText === 'B') {
        entryResolution = 'B';
      } else {
        entryResolution = 'manual-review';
      }
    }
  }

  // Flush the last accumulated entry
  flushEntry();

  return results;
}
