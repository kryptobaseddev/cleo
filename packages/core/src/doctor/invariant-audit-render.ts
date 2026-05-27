/**
 * Human-render lines for `cleo doctor --audit-invariants` (T10340).
 *
 * Pure string-builder — produces an array of lines that the CLI thin
 * wrapper emits via `humanLine`. Keeping rendering in core honours the
 * CLI Boundary lint (T10076) and lets the underlying primitive be
 * unit-tested without spinning up the CLI surface.
 *
 * Output structure (Saga T10326 R6 AC2 + AC3):
 *   - Header line with totals + filter context.
 *   - One block per ADR (alphabetically), with severity bands inside.
 *   - Each violation line includes the offender ID + repair command.
 *   - Trailing roll-up recapping `passing / documented / not-applicable`
 *     so the gap analysis is visible end-to-end.
 *
 * @task T10340
 * @epic T10327
 * @saga T10326
 */

import type { InvariantAuditEntry, InvariantAuditResult } from '@cleocode/contracts';

/**
 * Stable severity ordering used to sort failing entries inside each ADR
 * block. `error` is loudest, `info` quietest.
 *
 * @internal
 */
const SEVERITY_RANK: Record<string, number> = {
  error: 0,
  warning: 1,
  info: 2,
};

/**
 * Compose the lines for the audit header (totals + optional filter
 * context). Returns two lines so the CLI surface can interleave a blank
 * line if it wants to.
 *
 * @internal
 */
function renderHeaderLines(result: InvariantAuditResult): string[] {
  const filterSuffix = result.filteredByAdr === null ? '' : ` (filtered: ${result.filteredByAdr})`;
  return [
    `Invariant Registry Audit${filterSuffix}`,
    `  ${result.totalCount} entries · ${result.errorCount} error · ` +
      `${result.warningCount} warning · ${result.infoCount} info · ` +
      `${result.notApplicableCount} not-applicable · ${result.documentedCount} documented`,
  ];
}

/**
 * Compose the lines for the failing entries inside a single ADR block.
 * Each violation line is followed by a `repair:` line with the canonical
 * command. Returns an empty array when there are no failures.
 *
 * @internal
 */
function renderFailingEntryLines(failing: InvariantAuditEntry[]): string[] {
  const out: string[] = [];
  const failingSorted = failing.slice().sort((a, b) => {
    const ra = SEVERITY_RANK[a.severity] ?? 9;
    const rb = SEVERITY_RANK[b.severity] ?? 9;
    if (ra !== rb) return ra - rb;
    return a.code.localeCompare(b.code);
  });
  for (const entry of failingSorted) {
    out.push(
      `  [${entry.severity.toUpperCase()}] ${entry.code} · ${entry.name}` +
        ` (${entry.violations.length} violation(s))`,
    );
    for (const v of entry.violations) {
      out.push(`    - ${v.message}`);
      out.push(`      repair: ${v.repairCommand}`);
    }
  }
  return out;
}

/**
 * Compose the lines for one ADR block (header + failing rows + roll-up).
 *
 * @internal
 */
function renderAdrBlockLines(adr: string, entries: InvariantAuditEntry[]): string[] {
  const out: string[] = [];
  const failing = entries.filter((e) => e.status === 'fail');
  out.push(`[${adr}] ${entries.length} invariant(s), ${failing.length} failing:`);
  out.push(...renderFailingEntryLines(failing));
  const passing = entries.filter((e) => e.status === 'pass').length;
  const docd = entries.filter((e) => e.status === 'documented').length;
  const na = entries.filter((e) => e.status === 'not-applicable').length;
  out.push(`  (${passing} passing · ${docd} documented · ${na} not-applicable)`);
  return out;
}

/**
 * Render the invariant-registry audit result as an array of human-readable
 * lines. The CLI thin-wrapper emits each entry via `humanLine` so this
 * function stays free of side effects + the rendering is unit-testable.
 *
 * @param result - The audit result from `auditInvariantRegistry`.
 * @returns An ordered list of lines to emit, one per row. Blank-line
 *          separators are produced as empty strings so the consumer can
 *          decide whether to fold them.
 */
export function renderInvariantAuditLines(result: InvariantAuditResult): string[] {
  const lines: string[] = [];
  lines.push('');
  lines.push(...renderHeaderLines(result));
  lines.push('');

  // Group entries by ADR (stable: entries are already sorted by ADR + code).
  const byAdr = new Map<string, InvariantAuditEntry[]>();
  for (const entry of result.entries) {
    const bucket = byAdr.get(entry.adr) ?? [];
    bucket.push(entry);
    byAdr.set(entry.adr, bucket);
  }

  for (const adr of Array.from(byAdr.keys()).sort()) {
    const adrEntries = byAdr.get(adr) ?? [];
    lines.push(...renderAdrBlockLines(adr, adrEntries));
    lines.push('');
  }

  if (result.entries.length === 0) {
    lines.push('  (no invariants registered)');
    lines.push('');
  }
  return lines;
}
