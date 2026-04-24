/**
 * PSYCHE E4 STRICT cutover migration tool for `.cantbook` files.
 *
 * Per Council mandate (T1261 ADR-055 STRICT cutover): all `.cantbook` files
 * MUST comply with the E4 DSL contract before the v2026.4.129 ship. This
 * module provides:
 *
 * 1. {@link validatePlaybookCompliance} — pure validator, returns compliance
 *    report without modifying files.
 * 2. {@link migratePlaybook} — enriches a `.cantbook` source string with
 *    minimal E4-compatible scaffolding (adds skeleton error_handlers if
 *    absent, adds requires/ensures stubs to nodes without them).
 * 3. {@link migratePlaybookFile} — reads, migrates, and optionally writes a
 *    `.cantbook` file in place. Dry-run mode returns the migrated source
 *    without writing.
 *
 * STRICT cutover policy (no opt-in flag):
 * - All existing `.cantbook` files MUST be validated/migrated at E4 ship.
 * - The starter playbooks (rcasd, ivtr, release) ship with full E4 DSL and
 *   pass validation without modification.
 * - User-authored playbooks MUST run this tool before using the E4 runtime.
 *
 * @task T1261 PSYCHE E4 — STRICT cutover migration
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { dump as yamlDump, load as yamlLoad } from 'js-yaml';
import { PlaybookParseError, parsePlaybook } from './parser.js';

// ---------------------------------------------------------------------------
// Compliance report
// ---------------------------------------------------------------------------

/** Per-node compliance entry. */
export interface NodeComplianceEntry {
  /** Node id. */
  id: string;
  /** Node type. */
  type: string;
  /** Whether the node has a `requires` block. */
  hasRequires: boolean;
  /** Whether the node has an `ensures` block. */
  hasEnsures: boolean;
}

/**
 * Result of {@link validatePlaybookCompliance}. Reports which E4 DSL
 * features are present and which are missing.
 */
export interface PlaybookComplianceReport {
  /** Whether the file parses successfully (pre-condition). */
  parses: boolean;
  /** Parse error message when `parses === false`. */
  parseError?: string;
  /** Whether the file has at least one `error_handlers` entry. */
  hasErrorHandlers: boolean;
  /** Number of agentic nodes missing `requires` (first predecessor context). */
  nodesMissingRequires: number;
  /** Number of nodes missing `ensures` (output guarantee). */
  nodesMissingEnsures: number;
  /** Per-node breakdown. */
  nodes: NodeComplianceEntry[];
  /** `true` when all E4 requirements are satisfied. */
  compliant: boolean;
}

/**
 * Validate a `.cantbook` source string for E4 DSL compliance without
 * modifying it.
 *
 * @param source - Raw `.cantbook` YAML text.
 * @returns A compliance report. Callers should check `compliant` before
 *          running the playbook.
 */
export function validatePlaybookCompliance(source: string): PlaybookComplianceReport {
  let parsed: ReturnType<typeof parsePlaybook>;
  try {
    parsed = parsePlaybook(source);
  } catch (err) {
    return {
      parses: false,
      parseError: err instanceof PlaybookParseError ? err.message : String(err),
      hasErrorHandlers: false,
      nodesMissingRequires: 0,
      nodesMissingEnsures: 0,
      nodes: [],
      compliant: false,
    };
  }

  const { definition } = parsed;
  const hasErrorHandlers = (definition.error_handlers?.length ?? 0) > 0;

  const nodeEntries: NodeComplianceEntry[] = definition.nodes.map((n) => ({
    id: n.id,
    type: n.type,
    hasRequires: n.requires !== undefined,
    hasEnsures: n.ensures !== undefined,
  }));

  // Agentic + deterministic nodes should have requires/ensures; approval
  // nodes are exempt (they are gate-only, not data-producing).
  const workNodes = nodeEntries.filter((e) => e.type !== 'approval');
  const nodesMissingRequires = workNodes.filter((e) => !e.hasRequires).length;
  const nodesMissingEnsures = workNodes.filter((e) => !e.hasEnsures).length;

  const compliant = hasErrorHandlers && nodesMissingRequires === 0 && nodesMissingEnsures === 0;

  return {
    parses: true,
    hasErrorHandlers,
    nodesMissingRequires,
    nodesMissingEnsures,
    nodes: nodeEntries,
    compliant,
  };
}

// ---------------------------------------------------------------------------
// Migration
// ---------------------------------------------------------------------------

/**
 * Apply PSYCHE E4 STRICT cutover scaffolding to a `.cantbook` source string.
 *
 * Conservative strategy: adds skeleton DSL where absent; never removes or
 * modifies existing DSL. Callers should review the migrated output before
 * writing to disk.
 *
 * Migrations applied:
 * - Adds a default `error_handlers` block if absent (iteration_cap_exceeded
 *   → hitl_escalate + contract_violation → inject_hint).
 * - Adds a stub `requires: {}` to work nodes (non-approval) that lack it.
 * - Adds a stub `ensures: {}` to work nodes that lack it.
 *
 * @param source - Raw `.cantbook` YAML text.
 * @returns The migrated YAML source string.
 * @throws {PlaybookParseError} when the source cannot be parsed.
 */
export function migratePlaybook(source: string): string {
  // Parse first to validate structural correctness.
  parsePlaybook(source);

  // Work on the raw YAML object so we preserve ordering and comments where
  // possible (js-yaml dump always re-serialises, but it's the safest
  // approach for a migration tool).
  const raw = yamlLoad(source) as Record<string, unknown>;

  // 1. Ensure error_handlers exists.
  if (!Array.isArray(raw.error_handlers) || (raw.error_handlers as unknown[]).length === 0) {
    raw.error_handlers = [
      {
        on: 'iteration_cap_exceeded',
        action: 'hitl_escalate',
        message: 'Stage exhausted retries — escalate to human for direction.',
      },
      {
        on: 'contract_violation',
        action: 'inject_hint',
        message: 'Contract violated at stage boundary — check requires/ensures fields.',
      },
    ];
  }

  // 2. Add requires/ensures stubs to work nodes.
  if (Array.isArray(raw.nodes)) {
    raw.nodes = (raw.nodes as Record<string, unknown>[]).map((node) => {
      if (node.type === 'approval') return node; // approval nodes exempt
      const patched = { ...node };
      if (!patched.requires) patched.requires = {};
      if (!patched.ensures) patched.ensures = {};
      return patched;
    });
  }

  return yamlDump(raw, { lineWidth: 100, noRefs: true });
}

// ---------------------------------------------------------------------------
// File I/O helper
// ---------------------------------------------------------------------------

/** Result of {@link migratePlaybookFile}. */
export interface MigratePlaybookFileResult {
  /** Path that was processed. */
  filePath: string;
  /** Pre-migration compliance report. */
  before: PlaybookComplianceReport;
  /** Post-migration compliance report (same as `before` in dry-run mode). */
  after: PlaybookComplianceReport;
  /** Whether the file was written (false in dry-run mode). */
  written: boolean;
  /** Migrated YAML source (always set, even in dry-run mode). */
  migratedSource: string;
}

/**
 * Read, validate, migrate, and optionally write a `.cantbook` file.
 *
 * @param filePath - Absolute path to the `.cantbook` file.
 * @param dryRun - When `true`, return the migrated source without writing.
 * @returns Migration result including before/after compliance reports.
 */
export function migratePlaybookFile(filePath: string, dryRun = false): MigratePlaybookFileResult {
  const source = readFileSync(filePath, 'utf8');
  const before = validatePlaybookCompliance(source);

  if (!before.parses) {
    return {
      filePath,
      before,
      after: before,
      written: false,
      migratedSource: source,
    };
  }

  const migratedSource = migratePlaybook(source);
  const after = validatePlaybookCompliance(migratedSource);

  if (!dryRun && !before.compliant) {
    writeFileSync(filePath, migratedSource, 'utf8');
  }

  return {
    filePath,
    before,
    after,
    written: !dryRun && !before.compliant,
    migratedSource,
  };
}
