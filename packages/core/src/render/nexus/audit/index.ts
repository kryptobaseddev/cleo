/**
 * Human-readable renderers for the **audit** family of nexus subcommands.
 *
 * Covers diff / export / hygiene surfaces:
 * - diff (before/after analyze snapshot)
 * - coldSymbols (low-weight / stale symbols)
 * - export (graph export confirmation)
 *
 * Each renderer follows the legacy `(data, quiet) => string` shape. The
 * shape stays stable until the consumer-side dispatcher migrates to the
 * typed envelope path (B5 `renderEnvelopeForHuman`).
 *
 * Subtask: T10152 (B7.3). Migrated verbatim from the deleted file
 * `packages/cleo/src/cli/renderers/nexus.ts` per ADR-077.
 *
 * @epic T10114
 * @task T10132
 */

import { str } from '../_format.js';

// ---------------------------------------------------------------------------
// nexus diff
// ---------------------------------------------------------------------------

/**
 * Render `cleo nexus diff` human output.
 */
export function renderNexusDiff(data: Record<string, unknown>, quiet: boolean): string {
  if (quiet) return '';
  const changedFiles = (data['changedFiles'] as string[]) ?? [];
  const regressions = (data['regressions'] as string[]) ?? [];
  const lines: string[] = [
    `[nexus] Diff: ${str(data['beforeSha'])}..${str(data['afterSha'])}\n` +
      `  Changed files: ${changedFiles.length > 0 ? changedFiles.join(', ') : 'n/a'}\n` +
      `  Nodes:     before=${str(data['nodesBefore'])}  after=${str(data['nodesAfter'])}  new=+${str(data['newNodes'])}  removed=-${str(data['removedNodes'])}\n` +
      `  Relations: before=${str(data['relationsBefore'])}  after=${str(data['relationsAfter'])}  new=+${str(data['newRelations'])}  removed=-${str(data['removedRelations'])}\n` +
      `  Health:    ${str(data['healthStatus'])}`,
  ];
  if (regressions.length > 0) {
    lines.push('\n  REGRESSIONS:');
    for (const reg of regressions) lines.push(`    - ${reg}`);
  } else {
    lines.push('  No regressions detected.');
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// nexus cold-symbols
// ---------------------------------------------------------------------------

/**
 * Render `cleo nexus cold-symbols` human output.
 *
 * TODO(T10128 B3 primitive ready): collapse the inline markdown table into
 * the B3 table primitive once B3 lands.
 */
export function renderNexusColdSymbols(data: Record<string, unknown>, quiet: boolean): string {
  if (quiet) return '';
  const symbols = (data['symbols'] as Array<Record<string, unknown>>) ?? [];
  const count = Number(data['count'] ?? 0);
  const thresholdDays = Number(data['thresholdDays'] ?? 30);
  const note = data['note'] as string | undefined;

  const lines: string[] = [];
  if (note) lines.push(`[nexus] Note: ${note}`);
  if (symbols.length === 0) {
    lines.push(`[nexus] No cold symbols found (threshold: ${thresholdDays} days, weight < 0.1).`);
    return lines.join('\n');
  }
  lines.push('| Symbol | Last Accessed | Weight | File |\n| --- | --- | --- | --- |');
  for (const s of symbols) {
    const lastAccessed = str(s['lastAccessed'], '(never)');
    const file = str(s['filePath'], '(unknown)');
    lines.push(
      `| ${str(s['label'])} | ${lastAccessed} | ${Number(s['maxWeight'] ?? 0).toFixed(4)} | ${file} |`,
    );
  }
  lines.push(`\n${count} cold symbol(s) found (threshold: ${thresholdDays} days).`);
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// nexus export (handled separately — raw file output)
// ---------------------------------------------------------------------------

/**
 * Render `cleo nexus export` confirmation human output.
 */
export function renderNexusExport(data: Record<string, unknown>, quiet: boolean): string {
  if (quiet) return '';
  if (data['outputFile']) {
    return `[nexus] Exported to ${str(data['outputFile'])} (${str(data['nodeCount'])} nodes, ${str(data['edgeCount'])} edges)`;
  }
  // stdout export: raw content is handled separately
  return '';
}
