/**
 * Human renderer for `cleo brain backfill`.
 *
 * Migrated from `packages/cleo/src/cli/renderers/system.ts` (T10131 — B6).
 *
 * @task T1722
 * @task T10131
 */

import { BOLD, DIM, GREEN, NC } from '../colors.js';

export function renderBrainBackfill(data: Record<string, unknown>, quiet: boolean): string {
  if (quiet) return String(data['nodesInserted'] ?? '');

  const lines: string[] = [];
  const before = data['before'] as Record<string, unknown> | undefined;
  const after = data['after'] as Record<string, unknown> | undefined;
  const byType = data['byType'] as Record<string, unknown> | undefined;

  lines.push(`${GREEN}${BOLD}Back-fill complete.${NC}`);
  if (before) {
    lines.push(`  ${DIM}Before:${NC} ${before['nodes']} nodes, ${before['edges']} edges`);
    lines.push(
      `  ${DIM}Source:${NC} ${before['decisions']} decisions, ${before['patterns']} patterns, ${before['learnings']} learnings, ${before['observations']} observations, ${before['stickyNotes']} stickies`,
    );
  }
  lines.push(
    `  ${DIM}Nodes inserted:${NC} ${data['nodesInserted']} (including ${data['stubsCreated']} stub nodes)`,
  );
  lines.push(`  ${DIM}Edges inserted:${NC} ${data['edgesInserted']}`);
  if (after) {
    lines.push(`  ${DIM}After:${NC}  ${after['nodes']} nodes, ${after['edges']} edges`);
  }

  if (byType && Object.keys(byType).length > 0) {
    lines.push('\n  By type:');
    for (const [type, count] of Object.entries(byType)) {
      lines.push(`    ${DIM}${type}:${NC} ${count}`);
    }
  }

  return lines.join('\n');
}
