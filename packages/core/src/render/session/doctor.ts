/**
 * Human renderer for `cleo doctor`.
 *
 * Migrated from `packages/cleo/src/cli/renderers/system.ts` (T10131 — B6).
 *
 * @task T9393
 * @task T10131
 */

import { BOLD, DIM, GREEN, NC, RED, YELLOW } from '../colors.js';

export function renderDoctor(data: Record<string, unknown>, quiet: boolean): string {
  // T9393-followup: dispatcher returns `overall: 'pass'|'warning'|'fail'`,
  // per-check `status: 'pass'|'warn'|'fail'`. The previous implementation read
  // `healthy` (never set) so every check rendered as red ✗ regardless of state.
  const overall = (data['overall'] as string | undefined) ?? 'unknown';
  const version = data['version'] as string | undefined;
  const installation = data['installation'] as string | undefined;
  const checks = data['checks'] as Array<Record<string, unknown>> | undefined;

  if (quiet) {
    return overall;
  }

  const lines: string[] = [];
  const statusBadge =
    overall === 'pass'
      ? `${GREEN}${BOLD}HEALTHY${NC}`
      : overall === 'warning'
        ? `${YELLOW}${BOLD}DEGRADED${NC}`
        : overall === 'fail'
          ? `${RED}${BOLD}UNHEALTHY${NC}`
          : `${DIM}${overall.toUpperCase()}${NC}`;

  lines.push(`System Status: ${statusBadge}`);
  if (version) lines.push(`  ${DIM}Version:${NC} ${version}`);
  if (installation) lines.push(`  ${DIM}Installation:${NC} ${installation}`);

  if (checks && checks.length > 0) {
    let passCount = 0;
    let warnCount = 0;
    let failCount = 0;
    for (const c of checks) {
      const s = c['status'] as string;
      if (s === 'pass') passCount++;
      else if (s === 'warn' || s === 'warning') warnCount++;
      else failCount++;
    }
    lines.push(
      `  ${DIM}Checks:${NC} ${GREEN}${passCount} pass${NC} · ${YELLOW}${warnCount} warn${NC} · ${RED}${failCount} fail${NC}`,
    );
    lines.push('');
    for (const check of checks) {
      const status = check['status'] as string;
      const name = check['name'] as string | undefined;
      const message = check['message'] as string;
      const icon =
        status === 'pass'
          ? `${GREEN}✓${NC}`
          : status === 'warn' || status === 'warning'
            ? `${YELLOW}⚠${NC}`
            : `${RED}✗${NC}`;
      const label = name ? `${BOLD}${name}${NC}` : '';
      lines.push(`  ${icon} ${label}${label && message ? ` — ${message}` : message}`);
    }
  }

  return lines.join('\n');
}
