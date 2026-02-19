/**
 * Orchestrator protocol compliance validation.
 * Ports lib/skills/orchestrator-validator.sh.
 *
 * Validates subagent output compliance, orchestrator behavior,
 * manifest integrity, and pre-spawn compliance checks.
 *
 * @epic T4454
 * @task T4519
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getTodoPath, getAgentOutputsAbsolute, getManifestPath as getManifestPathFromPaths } from '../../paths.js';
import type { Task } from '../../../types/task.js';
import type {
  ManifestEntry,
  ManifestValidationResult,
  ComplianceResult,
} from '../types.js';
// validateReturnMessage used for protocol validation in validate_return_message
// import { validateReturnMessage } from '../validation.js';

// ============================================================================
// Constants
// ============================================================================

const KEY_FINDINGS_MIN = 3;
const KEY_FINDINGS_MAX = 7;
const MANIFEST_REQUIRED_FIELDS = [
  'id', 'file', 'title', 'date', 'status', 'topics', 'key_findings', 'actionable',
];
const VALID_STATUSES = new Set(['complete', 'partial', 'blocked', 'archived']);

// ============================================================================
// Manifest Helpers
// ============================================================================

/** Alias for centralized getManifestPath to avoid name conflicts with local usages. */
function getManifestPath(cwd?: string): string {
  return getManifestPathFromPaths(cwd);
}

/**
 * Read all manifest entries from MANIFEST.jsonl.
 */
function readManifestEntries(cwd?: string): ManifestEntry[] {
  const manifestPath = getManifestPath(cwd);
  if (!existsSync(manifestPath)) return [];

  const content = readFileSync(manifestPath, 'utf-8');
  const entries: ManifestEntry[] = [];

  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      entries.push(JSON.parse(trimmed) as ManifestEntry);
    } catch {
      // Skip invalid lines
    }
  }

  return entries;
}

// ============================================================================
// Subagent Output Validation
// ============================================================================

/**
 * Validate a subagent's manifest entry for protocol compliance.
 * @task T4519
 */
export function validateSubagentOutput(
  researchId: string,
  cwd?: string,
): { passed: boolean; issues: string[]; checkedRules: string[] } {
  const issues: string[] = [];
  const checkedRules = [
    'MANIFEST_ENTRY_EXISTS',
    'REQUIRED_FIELDS_PRESENT',
    'STATUS_VALID_ENUM',
    'KEY_FINDINGS_COUNT_3_7',
    'DATE_ISO_8601',
    'TOPICS_ARRAY_NON_EMPTY',
    'NEEDS_FOLLOWUP_ARRAY',
    'ACTIONABLE_BOOLEAN',
    'OUTPUT_FILE_EXISTS',
  ];

  const entries = readManifestEntries(cwd);
  const entry = entries.find(e => e.id === researchId);

  if (!entry) {
    issues.push(`MANIFEST_ENTRY_MISSING: No manifest entry found for id=${researchId}`);
    return { passed: false, issues, checkedRules };
  }

  // Check required fields
  for (const field of MANIFEST_REQUIRED_FIELDS) {
    if (!(field in entry)) {
      issues.push(`MISSING_FIELD: ${field}`);
    }
  }

  // Validate status
  if (entry.status && !VALID_STATUSES.has(entry.status)) {
    issues.push(`INVALID_STATUS: ${entry.status} (must be complete|partial|blocked|archived)`);
  }

  // Validate key_findings count
  if (!Array.isArray(entry.key_findings)) {
    issues.push('KEY_FINDINGS_NOT_ARRAY');
  } else if (entry.key_findings.length < KEY_FINDINGS_MIN) {
    issues.push(`KEY_FINDINGS_TOO_FEW: count=${entry.key_findings.length} (must be ${KEY_FINDINGS_MIN}-${KEY_FINDINGS_MAX})`);
  } else if (entry.key_findings.length > KEY_FINDINGS_MAX) {
    issues.push(`KEY_FINDINGS_TOO_MANY: count=${entry.key_findings.length} (must be ${KEY_FINDINGS_MIN}-${KEY_FINDINGS_MAX})`);
  }

  // Validate date format
  if (entry.date && !/^\d{4}-\d{2}-\d{2}$/.test(entry.date)) {
    issues.push(`INVALID_DATE: ${entry.date} (must be YYYY-MM-DD)`);
  }

  // Validate topics
  if (!Array.isArray(entry.topics) || entry.topics.length === 0) {
    issues.push('TOPICS_EMPTY: topics must be a non-empty array');
  }

  // Validate actionable
  if (typeof entry.actionable !== 'boolean') {
    issues.push('ACTIONABLE_NOT_BOOLEAN');
  }

  // Check output file exists
  if (entry.file) {
    const absOutputDir = getAgentOutputsAbsolute(cwd);
    const filePath = join(absOutputDir, entry.file);
    if (!existsSync(filePath)) {
      issues.push(`FILE_NOT_FOUND: Expected file at ${filePath}`);
    }
  }

  return { passed: issues.length === 0, issues, checkedRules };
}

// ============================================================================
// Manifest Integrity
// ============================================================================

/**
 * Validate the entire manifest file integrity.
 * @task T4519
 */
export function validateManifestIntegrity(cwd?: string): ManifestValidationResult {
  const manifestPath = getManifestPath(cwd);

  if (!existsSync(manifestPath)) {
    return { exists: false, passed: true, issues: [] };
  }

  const content = readFileSync(manifestPath, 'utf-8');
  const lines = content.split('\n').filter(l => l.trim());
  const issues: string[] = [];
  let validEntries = 0;
  let invalidEntries = 0;
  const seenIds = new Set<string>();

  for (let i = 0; i < lines.length; i++) {
    const lineNum = i + 1;
    const line = lines[i].trim();
    if (!line) continue;

    // Check valid JSON
    let entry: ManifestEntry;
    try {
      entry = JSON.parse(line);
    } catch {
      issues.push(`LINE_${lineNum}_INVALID_JSON: Parse error`);
      invalidEntries++;
      continue;
    }

    // Check id field
    if (!entry.id) {
      issues.push(`LINE_${lineNum}_MISSING_ID: No id field`);
      invalidEntries++;
      continue;
    }

    // Check duplicate ID
    if (seenIds.has(entry.id)) {
      issues.push(`LINE_${lineNum}_DUPLICATE_ID: ${entry.id} already exists`);
      invalidEntries++;
      continue;
    }
    seenIds.add(entry.id);

    // Check file exists
    if (entry.file) {
      const absOutputDir = getAgentOutputsAbsolute(cwd);
      const filePath = join(absOutputDir, entry.file);
      if (!existsSync(filePath)) {
        issues.push(`LINE_${lineNum}_FILE_MISSING: ${entry.file} does not exist`);
      }
    }

    validEntries++;
  }

  return {
    exists: true,
    passed: issues.length === 0,
    stats: {
      totalLines: lines.length,
      validEntries,
      invalidEntries,
    },
    issues,
  };
}

// ============================================================================
// Pre-Spawn Compliance Verification
// ============================================================================

/**
 * Verify previous agent completed protocol compliance before spawning next.
 * @task T4519
 */
export function verifyCompliance(
  previousTaskId: string,
  researchId?: string,
  cwd?: string,
): ComplianceResult {
  const violations: string[] = [];
  const warnings: string[] = [];

  const entries = readManifestEntries(cwd);

  // Find manifest entry for previous task
  let entry: ManifestEntry | undefined;

  if (researchId) {
    entry = entries.find(e => e.id === researchId);
  } else {
    // Search by linked_tasks
    entry = entries.find(e =>
      e.linked_tasks?.includes(previousTaskId) ||
      e.needs_followup?.includes(previousTaskId),
    );

    // Try ID pattern match
    if (!entry) {
      const taskNum = previousTaskId.replace(/^T/, '');
      entry = entries.find(e => e.id.includes(taskNum));
    }
  }

  const manifestEntryExists = !!entry;
  if (!manifestEntryExists) {
    violations.push(
      `MANIFEST_ENTRY_MISSING: No manifest entry found for task ${previousTaskId}`,
    );
  }

  // Check research linked to task
  let researchLinkedToTask = false;
  if (entry) {
    researchLinkedToTask = entry.linked_tasks?.includes(previousTaskId) ?? false;
    if (!researchLinkedToTask) {
      warnings.push(
        `RESEARCH_NOT_LINKED: Research entry exists but not linked to task ${previousTaskId}`,
      );
    }
  }

  // Check return status
  let returnStatusValid: boolean | null = null;
  if (entry) {
    returnStatusValid = VALID_STATUSES.has(entry.status);
    if (!returnStatusValid) {
      violations.push(`INVALID_MANIFEST_STATUS: ${entry.status}`);
    }
  }

  return {
    previousTaskId,
    researchId: entry?.id ?? null,
    checks: {
      manifestEntryExists,
      researchLinkedToTask,
      returnStatusValid,
    },
    canSpawnNext: violations.length === 0,
    violations,
    warnings,
  };
}

/**
 * Validate orchestrator compliance (post-hoc behavioral checks).
 * @task T4519
 */
export function validateOrchestratorCompliance(
  epicId?: string,
  cwd?: string,
): {
  compliant: boolean;
  violations: string[];
  warnings: string[];
} {
  const violations: string[] = [];
  const warnings: string[] = [];

  const manifestPath = getManifestPath(cwd);

  // Check manifest usage
  if (!existsSync(manifestPath)) {
    warnings.push(`ORC-005_NO_MANIFEST: Manifest file not found at ${manifestPath}`);
  } else {
    const content = readFileSync(manifestPath, 'utf-8').trim();
    if (!content) {
      warnings.push('ORC-005_EMPTY_MANIFEST: Manifest exists but has no entries');
    }
  }

  // Check dependency order (ORC-004) for completed tasks
  if (epicId) {
    const todoPath = getTodoPath(cwd);
    if (existsSync(todoPath)) {
      try {
        const data = JSON.parse(readFileSync(todoPath, 'utf-8'));
        const tasks: Task[] = (data.tasks ?? []).filter(
          (t: Task) => t.parentId === epicId && t.status === 'done',
        );

        // Sort by updatedAt and check for dependency violations
        const sorted = tasks.sort(
          (a, b) => new Date(a.updatedAt ?? '').getTime() - new Date(b.updatedAt ?? '').getTime(),
        );
        const completionOrder = sorted.map(t => t.id);

        for (let i = 0; i < sorted.length; i++) {
          const deps = sorted[i].depends ?? [];
          for (const dep of deps) {
            const depIdx = completionOrder.indexOf(dep);
            if (depIdx >= 0 && depIdx >= i) {
              violations.push(
                `ORC-004_DEPENDENCY_ORDER: Task ${sorted[i].id} completed before dependency ${dep}`,
              );
            }
          }
        }
      } catch {
        // Skip on parse error
      }
    }
  }

  return {
    compliant: violations.length === 0,
    violations,
    warnings,
  };
}
