/**
 * Human renderer for `cleo brain export` (file-write path only).
 *
 * Migrated from `packages/cleo/src/cli/renderers/system.ts` (T10131 — B6).
 *
 * @task T1722
 * @task T10131
 */

import { GREEN, NC } from '../colors.js';

export function renderBrainExport(data: Record<string, unknown>, quiet: boolean): string {
  if (quiet) return String(data['outputFile'] ?? '');

  return (
    `${GREEN}Exported to ${data['outputFile']}:${NC} ` +
    `${data['nodeCount']} nodes, ${data['edgeCount']} edges ` +
    `(${String(data['format'] ?? '').toUpperCase()})`
  );
}
