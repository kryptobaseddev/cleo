/**
 * Human renderer for `cleo audit reconstruct`.
 *
 * Renders the {@link ReconstructResult} fields as a readable lineage summary
 * including direct commits, inferred children, child commits, and release tags.
 *
 * Migrated from `packages/cleo/src/cli/renderers/system.ts` (T10131 — B6).
 *
 * @task T1729
 * @task T10131
 * @epic T1691
 */

import { BOLD, CYAN, DIM, GREEN, NC } from '../colors.js';

export function renderAuditReconstruct(data: Record<string, unknown>, quiet: boolean): string {
  if (quiet) return '';

  const taskId = data['taskId'] as string | undefined;
  const directCommits = (data['directCommits'] as Array<Record<string, unknown>>) ?? [];
  const childIdRange = data['childIdRange'] as { min: string; max: string } | null | undefined;
  const childCommits =
    (data['childCommits'] as Record<string, Array<Record<string, unknown>>>) ?? {};
  const releaseTags = (data['releaseTags'] as Array<Record<string, unknown>>) ?? [];
  const inferredChildren = (data['inferredChildren'] as string[]) ?? [];
  const firstSeenAt = data['firstSeenAt'] as string | null | undefined;
  const lastSeenAt = data['lastSeenAt'] as string | null | undefined;

  const lines: string[] = [
    `${BOLD}Lineage for ${taskId ?? '?'}${NC}`,
    '='.repeat(40),
    '',
    `${DIM}Direct commits:${NC} ${directCommits.length}`,
  ];

  for (const c of directCommits) {
    const sha = typeof c['sha'] === 'string' ? c['sha'].slice(0, 10) : '?';
    const subject = typeof c['subject'] === 'string' ? c['subject'] : '';
    lines.push(`  ${CYAN}${sha}${NC}  ${subject}`);
  }

  lines.push('');
  if (childIdRange) {
    lines.push(
      `${DIM}Inferred children:${NC} ${inferredChildren.join(', ')} (${childIdRange.min} → ${childIdRange.max})`,
    );
  } else {
    lines.push(`${DIM}Inferred children:${NC} none`);
  }

  const childEntries = Object.entries(childCommits);
  if (childEntries.length > 0) {
    lines.push('');
    lines.push(`${BOLD}Child commits:${NC}`);
    for (const [childId, commits] of childEntries) {
      lines.push(`  ${CYAN}${childId}${NC}: ${commits.length} commit(s)`);
      for (const c of commits) {
        const sha = typeof c['sha'] === 'string' ? c['sha'].slice(0, 10) : '?';
        const subject = typeof c['subject'] === 'string' ? c['subject'] : '';
        lines.push(`    ${DIM}${sha}${NC}  ${subject}`);
      }
    }
  }

  lines.push('');
  if (releaseTags.length > 0) {
    lines.push(`${BOLD}Release tags (${releaseTags.length}):${NC}`);
    for (const t of releaseTags) {
      const tag = typeof t['tag'] === 'string' ? t['tag'] : '?';
      const sha = typeof t['commitSha'] === 'string' ? t['commitSha'].slice(0, 10) : '?';
      const subject = typeof t['subject'] === 'string' ? t['subject'] : '';
      lines.push(`  ${GREEN}${tag}${NC}  ${DIM}${sha}${NC}  ${subject}`);
    }
  } else {
    lines.push(`${DIM}Release tags:${NC} none found`);
  }

  lines.push('');
  lines.push(`${DIM}First seen:${NC} ${firstSeenAt ?? 'n/a'}`);
  lines.push(`${DIM}Last seen: ${NC} ${lastSeenAt ?? 'n/a'}`);

  return lines.join('\n');
}
