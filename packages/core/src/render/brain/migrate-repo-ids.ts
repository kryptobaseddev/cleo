/**
 * Human renderer for `cleo brain migrate-repo-ids` (T14012): counts, then
 * every ambiguous evidence link, then the receipt or how to apply.
 *
 * @task T14012
 */

import { BOLD, DIM, GREEN, NC, YELLOW } from '../colors.js';

/**
 * Render an evidence repo-id migration plan or apply result.
 *
 * @param data - `EvidenceRepoMigrationResult` fields.
 * @param quiet - Print only the number of moved links.
 * @returns The rendered text.
 * @example
 * ```ts
 * renderBrainMigrateRepoIds({ dryRun: true, moved: [], nodes: [], unresolved: [], receiptPath: null }, false);
 * ```
 */
export function renderBrainMigrateRepoIds(data: Record<string, unknown>, quiet: boolean): string {
  const list = (key: string): Record<string, unknown>[] => {
    const value = data[key];
    return Array.isArray(value) ? value.filter((v) => typeof v === 'object' && v !== null) : [];
  };
  const moved = list('moved');
  if (quiet) return String(moved.length);
  const dryRun = data['dryRun'] !== false;
  const nodes = list('nodes');
  const unresolved = list('unresolved');
  const lines = [
    `${GREEN}${BOLD}${dryRun ? 'Dry run' : 'Applied'}:${NC} ${dryRun ? 'would move' : 'moved'} ${moved.length} evidence link(s) to ${nodes.length} repo-qualified node(s); ${unresolved.length} ambiguous`,
  ];
  for (const u of unresolved) {
    lines.push(
      `  ${YELLOW}ambiguous${NC} ${u['from']} -> ${u['target']}: ${DIM}${u['reason']}${NC}`,
    );
  }
  lines.push(
    dryRun
      ? `  ${DIM}Nothing written. Rerun with --apply to move them.${NC}`
      : `  ${DIM}Receipt:${NC} ${data['receiptPath']}`,
  );
  return lines.join('\n');
}
