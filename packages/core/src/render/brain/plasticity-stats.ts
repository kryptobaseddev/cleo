/**
 * Human renderer for `cleo brain plasticity stats`.
 *
 * Migrated from `packages/cleo/src/cli/renderers/system.ts` (T10131 — B6).
 *
 * @task T1722
 * @task T10131
 */

import { BOLD, DIM, NC } from '../colors.js';

export function renderBrainPlasticityStats(data: Record<string, unknown>, quiet: boolean): string {
  if (quiet) return String(data['totalEvents'] ?? '');

  const lines: string[] = [];
  const recentEvents = data['recentEvents'] as Array<Record<string, unknown>> | undefined;
  const limit = data['limit'] as number | undefined;

  lines.push(`${BOLD}Brain Plasticity Stats (STDP)${NC}`);
  lines.push('═'.repeat(41));
  lines.push(`  ${DIM}Total events:${NC}       ${data['totalEvents']}`);
  lines.push(`  ${DIM}LTP (potentiation):${NC} ${data['ltpCount']}`);
  lines.push(`  ${DIM}LTD (depression):${NC}   ${data['ltdCount']}`);

  const netDeltaW = (data['netDeltaW'] as number) ?? 0;
  const sign = netDeltaW >= 0 ? '+' : '';
  lines.push(`  ${DIM}Net Δw:${NC}             ${sign}${netDeltaW.toFixed(4)}`);
  lines.push(`  ${DIM}Last event:${NC}         ${data['lastEventAt'] ?? '(none)'}`);

  if (recentEvents && recentEvents.length > 0) {
    lines.push(`\n${BOLD}Recent Events (newest first, limit=${limit ?? 20})${NC}`);
    for (const ev of recentEvents) {
      const evSign = (ev['deltaW'] as number) >= 0 ? '+' : '';
      const src = String(ev['sourceNode'] ?? '')
        .slice(0, 30)
        .padEnd(30);
      const tgt = String(ev['targetNode'] ?? '')
        .slice(0, 30)
        .padEnd(30);
      lines.push(
        `  ${DIM}[${String(ev['kind'] ?? '').toUpperCase()}]${NC} ${src} → ${tgt}  ${DIM}Δw=${evSign}${(ev['deltaW'] as number).toFixed(4)}${NC}  ${ev['timestamp']}`,
      );
    }
  } else {
    lines.push('');
    lines.push(`  ${DIM}No plasticity events recorded yet.${NC}`);
    lines.push(
      `  ${DIM}Run \`cleo brain maintenance\` or \`cleo session end\` to trigger STDP.${NC}`,
    );
  }

  return lines.join('\n');
}
