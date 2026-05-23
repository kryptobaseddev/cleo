/**
 * Human renderer for `cleo session`.
 *
 * Migrated from `packages/cleo/src/cli/renderers/system.ts` (T10131 — B6).
 *
 * @task T4666
 * @task T10131
 */

import { BOLD, DIM, GREEN, NC } from '../colors.js';
import { formatLabel } from '../format-label.js';

export function renderSession(data: Record<string, unknown>, quiet: boolean): string {
  const sessionId = data['sessionId'] as string | undefined;
  const status = data['status'] as string | undefined;
  const sessions = data['sessions'] as Array<Record<string, unknown>> | undefined;

  // Session list
  if (sessions) {
    if (quiet) return sessions.map((s) => String(s['id'])).join('\n');
    const lines: string[] = [];
    lines.push(`${BOLD}Sessions (${sessions.length})${NC}`);
    for (const s of sessions) {
      const active = s['active'] as boolean | undefined;
      const icon = active ? `${GREEN}●${NC}` : `${DIM}○${NC}`;
      lines.push(`  ${icon} ${BOLD}${s['id']}${NC}${active ? ' (active)' : ''}`);
    }
    return lines.join('\n');
  }

  // Single session
  if (!sessionId) {
    return quiet ? '' : 'No active session.';
  }

  if (quiet) return sessionId;

  const lines: string[] = [];
  lines.push(`${BOLD}Session:${NC} ${sessionId}`);
  if (status) lines.push(`  ${DIM}Status:${NC} ${status}`);

  // Render any other fields
  for (const [key, val] of Object.entries(data)) {
    if (key === 'sessionId' || key === 'status') continue;
    if (typeof val === 'string' || typeof val === 'number' || typeof val === 'boolean') {
      lines.push(`  ${DIM}${formatLabel(key)}:${NC} ${String(val)}`);
    }
  }

  return lines.join('\n');
}
