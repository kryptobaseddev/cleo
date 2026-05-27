/**
 * Conflict report formatter for the T311 A/B JSON restore engine.
 *
 * Reads {@link JsonRestoreReport}[] (from T354) plus optional re-auth and
 * schema-compatibility warnings, and emits the markdown report format
 * defined in T311 spec §6.5.
 *
 * PURE FORMATTER — the only I/O in this module is inside
 * {@link writeConflictReport}, which writes a single file via
 * `fs.writeFileSync`.  Everything else is a pure string transformation.
 *
 * @task T357
 * @epic T311
 * @why ADR-038 §10 — restore writes a markdown conflict report at
 *      .cleo/restore-conflicts.md so users (and downstream agents) can
 *      review classifications + resolve manual-review fields + finalize
 *      via `cleo restore finalize`.
 * @what Pure formatter. Reads JsonRestoreReport[] from T354 + extra
 *       metadata (re-auth warnings, schema warnings) and emits markdown.
 * @module restore-conflict-report
 */

import fs from 'node:fs';
import path from 'node:path';

import type { JsonRestoreReport } from './restore-json-merge.js';

// ============================================================================
// Public types
// ============================================================================

/**
 * Warning emitted when a signaldock.db agent was encrypted with the
 * source machine's global-salt and therefore cannot be decrypted on the
 * target machine.
 *
 * @task T357
 * @epic T311
 */
export interface ReauthWarning {
  /** Canonical agent identifier, e.g. `"cleo-prime"`. */
  agentId: string;
  /** Human-readable reason the agent needs re-authentication. */
  reason: string;
}

/**
 * Warning emitted when a bundled database's schema version differs from
 * the local schema version.
 *
 * @task T357
 * @epic T311
 */
export interface SchemaCompatWarning {
  /** Database name without extension, e.g. `"brain"` or `"conduit"`. */
  db: string;
  /** Schema version string found in the bundle. */
  bundleVersion: string;
  /** Schema version string found in the local installation. */
  localVersion: string;
  /**
   * Severity of the mismatch:
   * - `older-bundle` — bundle schema is behind local; forward migration will
   *   run on first open.
   * - `newer-bundle` — bundle schema is ahead of local; upgrading cleo is
   *   recommended before using the restored database.
   */
  severity: 'older-bundle' | 'newer-bundle';
}

/**
 * All inputs required to build the `.cleo/restore-conflicts.md` report.
 *
 * @task T357
 * @epic T311
 */
export interface BuildConflictReportInput {
  /** Per-file A/B comparison results produced by T354. */
  reports: JsonRestoreReport[];
  /** Filesystem path of the bundle file that was imported. */
  bundlePath: string;
  /** Machine fingerprint recorded in the bundle manifest (source machine). */
  sourceMachineFingerprint: string;
  /** Machine fingerprint of the local machine (target machine). */
  targetMachineFingerprint: string;
  /** Cleo version string of the importing installation, e.g. `"2026.4.13"`. */
  cleoVersion: string;
  /**
   * Agent re-authentication warnings for agents whose credentials were
   * encrypted with the source machine's global-salt.
   * Omit or pass an empty array when no agents need re-auth.
   */
  reauthWarnings?: ReauthWarning[];
  /**
   * Schema version mismatch warnings for bundled databases.
   * Omit or pass an empty array when all schemas match.
   */
  schemaWarnings?: SchemaCompatWarning[];
}

// ============================================================================
// Value formatting helpers
// ============================================================================

/**
 * Formats an arbitrary field value as a compact inline markdown literal.
 *
 * - `undefined`  → `_(not present)_`
 * - `null`       → `` `null` ``
 * - strings      → `` `"value"` `` with interior double-quotes escaped
 * - other        → `` `JSON.stringify(value)` ``
 *
 * @param val - The value to format.
 * @returns A markdown-formatted string representation.
 */
function formatValue(val: unknown): string {
  if (val === undefined) return '_(not present)_';
  if (val === null) return '`null`';
  if (typeof val === 'string') return '`"' + val.replace(/"/g, '\\"') + '"`';
  return '`' + JSON.stringify(val) + '`';
}

// ============================================================================
// Per-file section renderer
// ============================================================================

/**
 * Renders the markdown section for a single {@link JsonRestoreReport}.
 *
 * Groups field classifications into three buckets:
 * - **identical** — skipped (no conflict).
 * - **resolved** — values differed but auto-resolution produced A or B.
 * - **manual-review** — no safe auto-resolution; operator must decide.
 *
 * @param report - The comparison result for one JSON file.
 * @returns Markdown string for the file section, without a trailing newline.
 */
function renderReportSection(report: JsonRestoreReport): string {
  const resolved = report.classifications.filter(
    (c) => c.category !== 'identical' && (c.resolution === 'A' || c.resolution === 'B'),
  );
  const manual = report.classifications.filter((c) => c.resolution === 'manual-review');
  const totalClassified = report.classifications.length;
  const conflictCount = manual.length;

  const lines: string[] = [];

  lines.push(`## ${report.filename}`);
  lines.push('');
  lines.push(
    `_${totalClassified} fields classified, ${conflictCount} conflict${conflictCount === 1 ? '' : 's'}._`,
  );
  lines.push('');

  // Resolved section
  if (resolved.length === 0) {
    lines.push('_No resolved conflicts._');
  } else {
    lines.push('### Resolved (auto-applied)');
    lines.push('');
    for (const c of resolved) {
      lines.push(`- \`${c.path}\``);
      lines.push(`  - Local (A): ${formatValue(c.local)}`);
      lines.push(`  - Imported (B): ${formatValue(c.imported)}`);
      lines.push(`  - Resolution: **${c.resolution}**`);
      lines.push(`  - Rationale: ${c.rationale}`);
    }
  }

  lines.push('');

  // Manual review section
  if (manual.length === 0) {
    lines.push('_No manual review needed._');
  } else {
    lines.push('### Manual review needed');
    lines.push('');
    for (const c of manual) {
      lines.push(`- \`${c.path}\``);
      lines.push(`  - Local (A): ${formatValue(c.local)}`);
      lines.push(`  - Imported (B): ${formatValue(c.imported)}`);
      lines.push(`  - Resolution: **manual-review**`);
      lines.push(`  - Rationale: ${c.rationale}`);
      lines.push(
        `  - RESOLVED: (edit this line to set 'A', 'B', or a custom value, then run 'cleo restore finalize')`,
      );
    }
  }

  return lines.join('\n');
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Builds the complete markdown content for `.cleo/restore-conflicts.md`.
 *
 * The output follows the T311 spec §6.5 format:
 * - Header with bundle metadata and timestamps
 * - One `##` section per file in `input.reports`
 * - Agent re-authentication section (or _None_ when empty)
 * - Schema compatibility warnings section (or _None_ when empty)
 * - Footer instruction for `cleo restore finalize`
 *
 * @task T357
 * @epic T311
 * @param input - All data required to render the report.
 * @returns The full markdown string. Does NOT write to disk.
 */
export function buildConflictReport(input: BuildConflictReportInput): string {
  const {
    reports,
    bundlePath,
    sourceMachineFingerprint,
    targetMachineFingerprint,
    cleoVersion,
    reauthWarnings = [],
    schemaWarnings = [],
  } = input;

  const restoredAt = new Date().toISOString();

  const lines: string[] = [];

  // ---- Header ----------------------------------------------------------------

  lines.push('# T311 Import Conflict Report');
  lines.push('');
  lines.push(`**Source bundle**: ${bundlePath}`);
  lines.push(`**Source machine**: ${sourceMachineFingerprint}`);
  lines.push(`**Target machine**: ${targetMachineFingerprint}`);
  lines.push(`**Restored at**: ${restoredAt}`);
  lines.push(`**Cleo version**: ${cleoVersion}`);
  lines.push('');
  lines.push('---');
  lines.push('');

  // ---- Per-file sections -----------------------------------------------------

  for (const report of reports) {
    lines.push(renderReportSection(report));
    lines.push('');
    lines.push('---');
    lines.push('');
  }

  // ---- Agent re-authentication section ---------------------------------------

  lines.push('## Agent re-authentication required');
  lines.push('');
  if (reauthWarnings.length === 0) {
    lines.push('_None_');
  } else {
    lines.push('The following agents in `signaldock.db` were encrypted with the source');
    lines.push("machine's `global-salt` and cannot be decrypted on this machine. Run");
    lines.push('`cleo agent auth <id>` to re-authenticate:');
    lines.push('');
    for (const w of reauthWarnings) {
      lines.push(`- ${w.agentId}: ${w.reason}`);
    }
  }
  lines.push('');
  lines.push('---');
  lines.push('');

  // ---- Schema compatibility warnings section ---------------------------------

  lines.push('## Schema compatibility warnings');
  lines.push('');
  if (schemaWarnings.length === 0) {
    lines.push('_None_');
  } else {
    for (const w of schemaWarnings) {
      lines.push(
        `- \`${w.db}\`: schema version \`${w.bundleVersion}\` (local: \`${w.localVersion}\`)`,
      );
      if (w.severity === 'older-bundle') {
        lines.push('  - Status: **older-bundle: forward migration will run on first open**');
      } else {
        lines.push('  - Status: **newer-bundle: upgrade cleo for full support**');
      }
    }
  }
  lines.push('');
  lines.push('---');
  lines.push('');

  // ---- Footer ----------------------------------------------------------------

  lines.push(
    '_Run `cleo restore finalize` after editing manual-review resolutions above to apply._',
  );

  return lines.join('\n');
}

/**
 * Writes the conflict report markdown to
 * `<projectRoot>/.cleo/restore-conflicts.md`.
 *
 * Creates the `.cleo/` directory if it does not already exist.
 *
 * @task T357
 * @epic T311
 * @param projectRoot - Absolute path to the project root directory.
 * @param content     - Markdown string produced by {@link buildConflictReport}.
 * @returns The absolute path of the written file.
 */
export function writeConflictReport(projectRoot: string, content: string): string {
  const cleoDir = path.join(projectRoot, '.cleo');
  fs.mkdirSync(cleoDir, { recursive: true });
  const filePath = path.join(cleoDir, 'restore-conflicts.md');
  fs.writeFileSync(filePath, content, 'utf-8');
  return filePath;
}
