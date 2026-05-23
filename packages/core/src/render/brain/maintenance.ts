/**
 * Human renderer for `cleo brain maintenance`.
 *
 * Migrated from `packages/cleo/src/cli/renderers/system.ts` (T10131 — B6).
 *
 * @task T1722
 * @task T10131
 */

import { BOLD, DIM, GREEN, NC } from '../colors.js';

export function renderBrainMaintenance(data: Record<string, unknown>, quiet: boolean): string {
  if (quiet) return String(data['duration'] ?? '');

  const lines: string[] = [];
  lines.push(`${GREEN}${BOLD}Maintenance complete.${NC}`);
  lines.push(`  ${DIM}Duration:${NC} ${data['duration']}ms`);

  const decay = data['decay'] as Record<string, unknown> | undefined;
  if (decay) {
    lines.push(`  ${DIM}Decay:${NC}         ${decay['affected']} learning(s) updated`);
  }

  const consolidation = data['consolidation'] as Record<string, unknown> | undefined;
  if (consolidation) {
    lines.push(
      `  ${DIM}Consolidation:${NC} ${consolidation['merged']} merged, ${consolidation['removed']} archived`,
    );
  }

  const tierPromotion = data['tierPromotion'] as Record<string, unknown> | undefined;
  if (tierPromotion) {
    lines.push(
      `  ${DIM}Tier promotion:${NC} ${tierPromotion['promoted']} promoted, ${tierPromotion['evicted']} evicted`,
    );
  }

  const reconciliation = data['reconciliation'] as Record<string, unknown> | undefined;
  if (reconciliation) {
    lines.push(
      `  ${DIM}Reconcile:${NC}     ${reconciliation['decisionsFixed']} decisions, ${reconciliation['observationsFixed']} observations, ${reconciliation['linksRemoved']} links`,
    );
  }

  const embeddings = data['embeddings'] as Record<string, unknown> | undefined;
  if (embeddings) {
    lines.push(
      `  ${DIM}Embeddings:${NC}    ${embeddings['processed']} processed, ${embeddings['skipped']} skipped, ${embeddings['errors']} errors`,
    );
  }

  return lines.join('\n');
}
