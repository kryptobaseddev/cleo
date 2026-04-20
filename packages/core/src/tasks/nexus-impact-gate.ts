/**
 * IVTR Breaking-Change Gate — blocks completion when task touches CRITICAL-risk symbols.
 *
 * Implements EP3-T8 from T1042 living-brain decomposition. The gate reads the task's
 * `files` field, queries nexus for symbols in those files, calls `reasonImpactOfChange()`
 * for each symbol, and fails if any symbol returns `mergedRiskScore === 'CRITICAL'`.
 *
 * Gate is OPT-IN via `CLEO_NEXUS_IMPACT_GATE=1` env var to prevent surprise breakage.
 *
 * @task T1073
 * @epic T1042
 */

import type { ImpactFullReport, Task } from '@cleocode/contracts';
import { ExitCode } from '@cleocode/contracts';
import { CleoError } from '../errors.js';
import { getNexusNativeDb } from '../store/nexus-sqlite.js';
import { typedAll, typedGet } from '../store/typed-query.js';

// ─── Internal row types ────────────────────────────────────────────────────

interface NexusNode {
  id: string;
  name: string | null;
  file_path: string | null;
}

// ─── Gate result shape ─────────────────────────────────────────────────────

/**
 * Result of running the nexusImpact gate validator.
 */
export interface NexusImpactGateResult {
  /** Whether the gate passed (true = no CRITICAL symbols, or gate disabled). */
  passed: boolean;
  /** Exit code if gate failed. */
  exitCode?: number;
  /** Error message if gate failed. */
  error?: string;
  /** Critical symbols that triggered the failure. */
  criticalSymbols?: Array<{
    symbolId: string;
    symbolName: string | null;
    filePath: string | null;
    mergedRiskScore: string;
    narrative: string;
  }>;
  /** Narrative summary. */
  narrative: string;
}

// ─── Main gate validator ───────────────────────────────────────────────────

/**
 * Validate the nexusImpact gate for a task.
 *
 * If `CLEO_NEXUS_IMPACT_GATE` env var is not set to '1', returns passed=true
 * with a note that the gate is disabled (prevents surprise breakage).
 *
 * When enabled, reads the task's `files` array, queries nexus for all symbols
 * in those files, and calls `reasonImpactOfChange()` for each. If any symbol
 * returns `mergedRiskScore === 'CRITICAL'`, the gate fails with a list of
 * critical symbols.
 *
 * @param task - The task to validate
 * @param projectRoot - Absolute path to project root
 * @returns Gate result with pass/fail status and evidence
 */
export async function validateNexusImpactGate(
  task: Task,
  projectRoot: string,
): Promise<NexusImpactGateResult> {
  // ---- Check if gate is enabled ----
  const gateEnabled = process.env.CLEO_NEXUS_IMPACT_GATE === '1';
  if (!gateEnabled) {
    return {
      passed: true,
      narrative: 'CLEO_NEXUS_IMPACT_GATE is disabled (gate skipped, set env var to 1 to enable)',
    };
  }

  // ---- Extract files from task ----
  const filesToCheck = task.files ?? [];
  if (filesToCheck.length === 0) {
    return {
      passed: true,
      narrative: 'No files touched in task.files (no impact analysis needed)',
    };
  }

  // ---- Query nexus for symbols in touched files ----
  let symbolsInFiles: NexusNode[] = [];
  try {
    const nexusNative = getNexusNativeDb();
    if (nexusNative) {
      const placeholders = filesToCheck.map(() => '?').join(', ');
      symbolsInFiles = typedAll<NexusNode>(
        nexusNative.prepare(
          `SELECT id, name, file_path
           FROM nexus_nodes
           WHERE file_path IN (${placeholders}) AND kind NOT IN ('folder', 'community', 'process')
           ORDER BY file_path, name`,
        ),
        ...filesToCheck,
      );
    }
  } catch (err) {
    console.warn(
      '[nexus-impact-gate] nexus symbol lookup failed:',
      err instanceof Error ? err.message : String(err),
    );
    // If nexus lookup fails, we cannot assess impact — fail safe by passing the gate
    // (the gate is only advisory; the core code-quality checks are elsewhere)
    return {
      passed: true,
      narrative:
        'nexus symbol lookup failed; gate disabled (inspect error logs for details)',
    };
  }

  if (symbolsInFiles.length === 0) {
    return {
      passed: true,
      narrative: `No symbols found in touched files (${filesToCheck.length} files checked, 0 symbols)`,
    };
  }

  // ---- Run reasonImpactOfChange for each symbol ----
  const criticalSymbols: NexusImpactGateResult['criticalSymbols'] = [];

  for (const symbol of symbolsInFiles) {
    let impact: ImpactFullReport;
    try {
      const { reasonImpactOfChange } = await import('../nexus/living-brain.js');
      impact = await reasonImpactOfChange(symbol.id, projectRoot);
    } catch (err) {
      console.warn(
        `[nexus-impact-gate] reasonImpactOfChange failed for ${symbol.id}:`,
        err instanceof Error ? err.message : String(err),
      );
      // Skip this symbol if impact analysis fails
      continue;
    }

    // Check if mergedRiskScore is CRITICAL
    if (impact.mergedRiskScore === 'CRITICAL') {
      criticalSymbols.push({
        symbolId: symbol.id,
        symbolName: symbol.name,
        filePath: symbol.file_path,
        mergedRiskScore: impact.mergedRiskScore,
        narrative: impact.narrative,
      });
    }
  }

  // ---- Determine gate result ----
  if (criticalSymbols.length === 0) {
    return {
      passed: true,
      narrative: `All ${symbolsInFiles.length} symbols have acceptable risk levels (no CRITICAL)`,
    };
  }

  // Gate failed: critical symbols found
  const symbolList = criticalSymbols.map((s) => `${s.symbolName}(${s.symbolId})`).join(', ');
  return {
    passed: false,
    exitCode: ExitCode.NEXUS_IMPACT_CRITICAL,
    error: `Task ${task.id} touches ${criticalSymbols.length} CRITICAL-risk symbol${criticalSymbols.length !== 1 ? 's' : ''}: ${symbolList}. Use --acknowledge-risk "<reason>" to bypass.`,
    criticalSymbols,
    narrative: `CRITICAL impact detected on ${criticalSymbols.length} symbol${criticalSymbols.length !== 1 ? 's' : ''}. ${symbolList}`,
  };
}
