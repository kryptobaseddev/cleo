/**
 * Simple diff display for CANT migration preview.
 *
 * Provides a color-coded before/after view showing what the
 * migration engine would produce. Uses ANSI escape codes
 * for terminal output.
 */

import type { MigrationResult } from './types';

/** ANSI color codes for terminal diff output. */
const ANSI = {
  reset: '\x1b[0m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
  dim: '\x1b[2m',
  bold: '\x1b[1m',
} as const;

/**
 * Show a color-coded diff of the migration result.
 *
 * Displays:
 * - A summary header with conversion stats
 * - Each converted file with green-highlighted content
 * - Each unconverted section with yellow-highlighted warnings
 *
 * @param result - The migration result to display
 * @param useColor - Whether to use ANSI color codes (default: true)
 * @returns The formatted diff string
 */
export function showDiff(result: MigrationResult, useColor = true): string {
  const c = useColor
    ? ANSI
    : {
        reset: '',
        red: '',
        green: '',
        yellow: '',
        cyan: '',
        dim: '',
        bold: '',
      };

  const lines: string[] = [];

  // Header
  lines.push(`${c.bold}Migration Preview: ${result.inputFile}${c.reset}`);
  lines.push(`${c.dim}${'='.repeat(60)}${c.reset}`);
  lines.push(result.summary);
  lines.push('');

  // Converted files
  if (result.outputFiles.length > 0) {
    lines.push(`${c.bold}${c.green}Converted files:${c.reset}`);
    lines.push('');

    for (const file of result.outputFiles) {
      lines.push(`${c.cyan}--- ${file.path} (${file.kind})${c.reset}`);

      const contentLines = file.content.split('\n');
      for (const contentLine of contentLines) {
        lines.push(`${c.green}+ ${contentLine}${c.reset}`);
      }
      lines.push('');
    }
  }

  // Unconverted sections
  if (result.unconverted.length > 0) {
    lines.push(`${c.bold}${c.yellow}Unconverted sections (manual review needed):${c.reset}`);
    lines.push('');

    for (const section of result.unconverted) {
      lines.push(
        `${c.yellow}! Lines ${section.lineStart}-${section.lineEnd}: ${section.reason}${c.reset}`,
      );

      const sectionLines = section.content.split('\n');
      for (const sectionLine of sectionLines) {
        lines.push(`${c.red}- ${sectionLine}${c.reset}`);
      }
      lines.push('');
    }
  }

  return lines.join('\n');
}

/**
 * Generate a simple text-only summary (no color).
 *
 * Suitable for logging or non-terminal output.
 *
 * @param result - The migration result to summarize
 * @returns Plain text summary
 */
export function showSummary(result: MigrationResult): string {
  const lines: string[] = [];

  lines.push(`Migration: ${result.inputFile}`);
  lines.push(result.summary);

  if (result.outputFiles.length > 0) {
    lines.push('');
    lines.push('Would create:');
    for (const file of result.outputFiles) {
      lines.push(`  ${file.path} (${file.kind})`);
    }
  }

  if (result.unconverted.length > 0) {
    lines.push('');
    lines.push('Needs manual conversion:');
    for (const section of result.unconverted) {
      lines.push(`  Lines ${section.lineStart}-${section.lineEnd}: ${section.reason}`);
    }
  }

  return lines.join('\n');
}
