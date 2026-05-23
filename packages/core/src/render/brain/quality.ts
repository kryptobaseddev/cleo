/**
 * Human renderer for `cleo brain quality`.
 *
 * Migrated from `packages/cleo/src/cli/renderers/system.ts` (T10131 — B6).
 *
 * @task T1722
 * @task T10131
 */

import { BOLD, CYAN, DIM, NC, YELLOW } from '../colors.js';

export function renderBrainQuality(data: Record<string, unknown>, quiet: boolean): string {
  if (quiet) {
    const usageRate = (data['usageRate'] as number) ?? 0;
    return `${(usageRate * 100).toFixed(1)}%`;
  }

  const lines: string[] = [];
  const qualityDistribution = data['qualityDistribution'] as Record<string, unknown> | undefined;
  const tierDistribution = data['tierDistribution'] as Record<string, unknown> | undefined;
  const topRetrieved = data['topRetrieved'] as Array<Record<string, unknown>> | undefined;
  const neverRetrieved = data['neverRetrieved'] as Array<Record<string, unknown>> | undefined;

  const usageRate = (data['usageRate'] as number) ?? 0;
  const noiseRatio = (data['noiseRatio'] as number) ?? 0;

  lines.push(`${BOLD}Brain Memory Quality Report${NC}`);
  lines.push('═'.repeat(42));
  lines.push(`  ${DIM}Total retrievals:${NC}       ${data['totalRetrievals']}`);
  lines.push(`  ${DIM}Unique entries hit:${NC}     ${data['uniqueEntriesRetrieved']}`);
  lines.push(`  ${DIM}Usage rate:${NC}             ${(usageRate * 100).toFixed(1)}%`);
  lines.push(`  ${DIM}Noise ratio:${NC}            ${(noiseRatio * 100).toFixed(1)}%`);

  if (qualityDistribution) {
    lines.push('');
    lines.push(`${BOLD}Quality Distribution${NC}`);
    lines.push(`  ${DIM}Low  (<0.3):${NC}    ${qualityDistribution['low']}`);
    lines.push(`  ${DIM}Med  (0.3-0.6):${NC} ${qualityDistribution['medium']}`);
    lines.push(`  ${DIM}High (>0.6):${NC}    ${qualityDistribution['high']}`);
  }

  if (tierDistribution) {
    lines.push('');
    lines.push(`${BOLD}Tier Distribution${NC}`);
    lines.push(`  ${DIM}Short:${NC}   ${tierDistribution['short']}`);
    lines.push(`  ${DIM}Medium:${NC}  ${tierDistribution['medium']}`);
    lines.push(`  ${DIM}Long:${NC}    ${tierDistribution['long']}`);
    if ((tierDistribution['unknown'] as number) > 0) {
      lines.push(`  ${DIM}Unknown:${NC} ${tierDistribution['unknown']}`);
    }
  }

  if (topRetrieved && topRetrieved.length > 0) {
    lines.push('');
    lines.push(`${BOLD}Top 10 Most Retrieved${NC}`);
    for (const e of topRetrieved) {
      lines.push(
        `  ${CYAN}[${e['citationCount']}x]${NC} ${DIM}${e['id']}${NC}  ${String(e['title'] ?? '').slice(0, 60)}`,
      );
    }
  }

  if (neverRetrieved && neverRetrieved.length > 0) {
    lines.push('');
    lines.push(`${YELLOW}${BOLD}Never Retrieved (pruning candidates)${NC}`);
    for (const e of neverRetrieved) {
      lines.push(
        `  ${DIM}q=${(e['qualityScore'] as number).toFixed(2)}${NC}  ${DIM}${e['id']}${NC}  ${String(e['title'] ?? '').slice(0, 60)}`,
      );
    }
  }

  return lines.join('\n');
}
