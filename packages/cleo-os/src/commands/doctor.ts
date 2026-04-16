/**
 * CleoOS Doctor — aggregated sovereignty diagnostics.
 *
 * Runs a full sovereignty probe across the CleoOS harness: provider matrix,
 * agent registry, memory policy configuration, and per-provider smoke checks.
 * Produces a human-readable report and exits non-zero if any issue is found.
 *
 * Invoked via `cleoos --doctor` or `cleoos doctor`.
 *
 * @see ADR-049 — CleoOS Sovereignty Invariants
 * @see ADR-050 — CleoOS Sovereign Harness: Distribution Binding Charter
 * @task T649
 * @epic T636
 * @packageDocumentation
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { MemoryItemType } from '../policies/memory-policy.js';
import { MemoryPolicy } from '../policies/memory-policy.js';
import type { AgentDefinition } from '../registry/agent-registry.js';
import { AgentRegistry } from '../registry/agent-registry.js';
import type { ProviderMatrixRow } from '../registry/provider-matrix.js';
import { ProviderMatrix } from '../registry/provider-matrix.js';

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Result for a single per-provider sovereignty smoke check.
 */
interface SmokeResult {
  /** Canonical provider ID (e.g. `"claude-code"`). */
  providerId: string;
  /** Whether the smoke check passed. */
  passed: boolean;
  /** Human-readable status message. */
  message: string;
}

/**
 * Aggregated result of the full doctor probe.
 */
export interface DoctorReport {
  /** All rows from the provider matrix. */
  providerRows: ProviderMatrixRow[];
  /** All agents discovered in the registry. */
  agents: AgentDefinition[];
  /** Count of seed agents. */
  seedCount: number;
  /** Count of user agents. */
  userCount: number;
  /** Memory policy check results per item type. */
  policyResults: Array<{ type: MemoryItemType; store: boolean; reason: string }>;
  /** Per-provider smoke check results, or null when cleo CLI is unavailable. */
  smokeResults: SmokeResult[] | null;
  /** Total number of issues found across all sections. */
  issueCount: number;
}

// ---------------------------------------------------------------------------
// Section probes
// ---------------------------------------------------------------------------

/**
 * All memory item types to probe against the policy gate.
 *
 * Ordered: allowed types first, then rejected types.
 */
const PROBE_TYPES: ReadonlyArray<MemoryItemType> = [
  'observation',
  'decision',
  'pattern',
  'learning',
  'chatlog',
  'transcript',
];

/**
 * Probe text used when checking each item type against the memory policy.
 *
 * Long enough to pass the `minTextLength` gate so the type decision is the
 * only discriminant under test.
 */
const PROBE_TEXT = 'diagnostic probe text for memory policy check';

/**
 * Probe the memory policy for each recognised item type.
 *
 * @returns Array of policy results — one entry per item type.
 */
function probeMemoryPolicy(): Array<{ type: MemoryItemType; store: boolean; reason: string }> {
  const policy = new MemoryPolicy();
  return PROBE_TYPES.map((type) => {
    const item = { type, text: PROBE_TEXT };
    const store = policy.shouldStore(item);
    const reason = policy.reason(item);
    return { type, store, reason };
  });
}

/**
 * Detect whether the `cleo` binary is available on `PATH`.
 *
 * @returns `true` when `which cleo` exits with code 0.
 */
async function isCleoAvailable(): Promise<boolean> {
  try {
    await execFileAsync('which', ['cleo']);
    return true;
  } catch {
    return false;
  }
}

/**
 * Run `cleo admin smoke --provider <id>` for a single installed provider.
 *
 * @param providerId - Canonical provider ID to smoke-test.
 * @returns `SmokeResult` with pass/fail and status message.
 */
async function runProviderSmoke(providerId: string): Promise<SmokeResult> {
  try {
    await execFileAsync('cleo', ['admin', 'smoke', '--provider', providerId]);
    return { providerId, passed: true, message: 'PASS' };
  } catch (err) {
    const message = err instanceof Error ? (err.message.split('\n')[0] ?? 'FAIL') : 'FAIL';
    return { providerId, passed: false, message: `FAIL — ${message}` };
  }
}

/**
 * Run sovereignty smoke checks for all installed providers.
 *
 * Returns `null` when the `cleo` CLI is not on `PATH` (skipped section).
 *
 * @param rows - Provider matrix rows; only installed providers are checked.
 * @returns Array of smoke results or `null` when cleo is unavailable.
 */
async function runSmokeChecks(rows: ProviderMatrixRow[]): Promise<SmokeResult[] | null> {
  const available = await isCleoAvailable();
  if (!available) {
    return null;
  }

  const installed = rows.filter((r) => r.installed);
  if (installed.length === 0) {
    return [];
  }

  const results = await Promise.all(installed.map((r) => runProviderSmoke(r.providerId)));
  return results;
}

// ---------------------------------------------------------------------------
// Core doctor function
// ---------------------------------------------------------------------------

/**
 * Run all CleoOS sovereignty diagnostic probes and return the aggregated report.
 *
 * Does not print output — callers are responsible for rendering. This keeps
 * the probe logic testable without capturing stdout.
 *
 * @returns Populated {@link DoctorReport}.
 */
export async function runDoctor(): Promise<DoctorReport> {
  const matrix = new ProviderMatrix();
  const registry = new AgentRegistry();

  const [providerRows, agents] = await Promise.all([matrix.getMatrix(), registry.listAll()]);

  const seedCount = agents.filter((a) => a.source === 'seed').length;
  const userCount = agents.filter((a) => a.source === 'user').length;

  const policyResults = probeMemoryPolicy();

  const smokeResults = await runSmokeChecks(providerRows);

  // Count issues:
  // - A provider that is not installed is not an issue (not expected to be installed).
  // - A provider that IS installed but has no spawn implementation is flagged.
  // - A smoke check that failed is flagged.
  let issueCount = 0;

  for (const row of providerRows) {
    if (row.installed && !row.spawnImplemented) {
      issueCount++;
    }
  }

  if (smokeResults !== null) {
    for (const r of smokeResults) {
      if (!r.passed) {
        issueCount++;
      }
    }
  }

  return {
    providerRows,
    agents,
    seedCount,
    userCount,
    policyResults,
    smokeResults,
    issueCount,
  };
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/**
 * Render a {@link DoctorReport} to a human-readable string.
 *
 * Follows the canonical CleoOS Doctor output format. Does not include a
 * trailing newline after the summary line — callers append one if needed.
 *
 * @param report - The completed doctor report to render.
 * @returns Multi-line formatted string ready for `console.log`.
 */
export function renderDoctorReport(report: DoctorReport): string {
  const lines: string[] = [];

  const installedCount = report.providerRows.filter((r) => r.installed).length;
  const spawnCount = report.providerRows.filter((r) => r.installed && r.spawnImplemented).length;
  const stubbedCount = installedCount - spawnCount;

  lines.push('CleoOS Doctor — Sovereignty Diagnostics');
  lines.push('═══════════════════════════════════════════════════════════');
  lines.push('');

  // Provider Matrix
  lines.push(`[Provider Matrix]  ${report.providerRows.length} providers total`);
  lines.push(`   Installed:   ${installedCount}`);
  lines.push(`   With spawn:  ${spawnCount}`);
  lines.push(`   Stubbed:     ${stubbedCount}`);
  lines.push('');

  // Agent Registry
  lines.push('[Agent Registry]');
  lines.push(`   Seed agents:  ${report.seedCount}`);
  lines.push(`   User agents:  ${report.userCount}`);
  lines.push(`   Total:        ${report.agents.length}`);
  lines.push('');

  // Memory Policy
  lines.push('[Memory Policy]');
  for (const { type, store, reason } of report.policyResults) {
    const storeLabel = store ? 'store=true' : 'store=false';
    // For rejected types, append the short reason after the store label.
    const suffix = store ? '' : ` (${reason})`;
    lines.push(`   ${type.padEnd(12)}  ${storeLabel}${suffix}`);
  }
  lines.push('');

  // Sovereignty Invariants
  lines.push('[Sovereignty Invariants]');
  if (report.smokeResults === null) {
    lines.push('   skipped — cleo CLI not on PATH');
  } else if (report.smokeResults.length === 0) {
    lines.push('   no installed providers to smoke-test');
  } else {
    for (const r of report.smokeResults) {
      const status = r.passed ? 'PASS' : `FAIL`;
      const detail = r.passed ? '' : ` — ${r.message.replace(/^FAIL — /, '')}`;
      lines.push(`   ${r.providerId.padEnd(18)}  ${status}${detail}`);
    }
  }
  lines.push('');

  // Summary
  lines.push('───────────────────────────────────────────────────────────');
  if (report.issueCount === 0) {
    lines.push('Result: PASS (0 issues)');
  } else {
    lines.push(`Result: FAIL (${report.issueCount} issue${report.issueCount === 1 ? '' : 's'})`);
  }

  return lines.join('\n');
}
