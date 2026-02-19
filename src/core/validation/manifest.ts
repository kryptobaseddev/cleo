/**
 * Manifest validation - ported from lib/validation/manifest-validation.sh
 *
 * Validates subagent output by finding manifest entries, running protocol
 * validators on actual output, and logging real compliance metrics.
 *
 * @task T4526
 * @epic T4454
 */

import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { mkdir, appendFile } from 'node:fs/promises';

// ============================================================================
// Types
// ============================================================================

export interface ManifestEntry {
  id: string;
  file: string;
  title: string;
  date: string;
  status: 'complete' | 'partial' | 'blocked';
  agent_type: string;
  topics?: string[];
  key_findings?: string[];
  actionable?: boolean;
  needs_followup?: string[];
  linked_tasks?: string[];
  [key: string]: unknown;
}

export interface ManifestViolation {
  requirement: string;
  severity: 'error' | 'warning';
  message: string;
  fix?: string;
}

export interface ManifestValidationResult {
  valid: boolean;
  score: number;
  pass: boolean;
  agent_type?: string;
  violations: ManifestViolation[];
  note?: string;
}

export interface ComplianceEntry {
  timestamp: string;
  source_id: string;
  source_type: string;
  compliance: {
    compliance_pass_rate: number;
    rule_adherence_score: number;
    violation_count: number;
    violation_severity: 'none' | 'warning' | 'error';
    manifest_integrity: 'valid' | 'violations_found';
  };
  efficiency: {
    input_tokens: number;
    output_tokens: number;
    context_utilization: number;
    token_utilization_rate: number;
  };
  _context: {
    agent_type: string;
    validation_score: number;
    violations: ManifestViolation[];
  };
}

// ============================================================================
// Defaults
// ============================================================================

const DEFAULT_MANIFEST_PATH = '.cleo/agent-outputs/MANIFEST.jsonl';
const DEFAULT_COMPLIANCE_PATH = '.cleo/metrics/COMPLIANCE.jsonl';

// ============================================================================
// Find Manifest Entry
// ============================================================================

/**
 * Find a manifest entry for a task ID in a JSONL file.
 * @task T4526
 */
export async function findManifestEntry(
  taskId: string,
  manifestPath: string = DEFAULT_MANIFEST_PATH,
): Promise<ManifestEntry | null> {
  if (!existsSync(manifestPath)) return null;

  const content = await readFile(manifestPath, 'utf-8');
  const lines = content.split('\n').filter(l => l.trim());

  // Search from end (most recent entries first)
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    try {
      // Check if the line mentions this task ID
      if (line.includes(`"${taskId}"`) || line.includes(`"${taskId}-`)) {
        const entry = JSON.parse(line) as ManifestEntry;
        return entry;
      }
    } catch {
      continue;
    }
  }

  return null;
}

// ============================================================================
// Validate Manifest Entry
// ============================================================================

/**
 * Run validation on a manifest entry for a specific task.
 * @task T4526
 */
export async function validateManifestEntry(
  taskId: string,
  manifestEntry?: ManifestEntry | null,
  manifestPath: string = DEFAULT_MANIFEST_PATH,
): Promise<ManifestValidationResult> {
  // Find entry if not provided
  if (!manifestEntry) {
    manifestEntry = await findManifestEntry(taskId, manifestPath);
  }

  if (!manifestEntry) {
    return {
      valid: false,
      score: 0,
      pass: false,
      violations: [{
        requirement: 'MANIFEST-001',
        severity: 'error',
        message: 'Subagent did not write manifest entry',
      }],
    };
  }

  const agentType = manifestEntry.agent_type ?? 'unknown';
  const violations: ManifestViolation[] = [];

  // Check required fields
  const hasId = !!manifestEntry.id;
  const hasStatus = !!manifestEntry.status;
  const hasKeyFindings = Array.isArray(manifestEntry.key_findings);

  if (!hasId) {
    violations.push({
      requirement: 'BASIC-000',
      severity: 'error',
      message: 'Missing required id field',
    });
  }

  if (!hasStatus) {
    violations.push({
      requirement: 'BASIC-000',
      severity: 'error',
      message: 'Missing required status field',
    });
  }

  if (!hasId || !hasStatus) {
    return {
      valid: false,
      score: 0,
      pass: false,
      violations,
    };
  }

  // Score based on field completeness
  let score = 70;

  if (!hasKeyFindings) {
    score = 50;
    violations.push({
      requirement: 'BASIC-001',
      severity: 'error',
      message: 'Missing key_findings array',
    });
  } else {
    const kfCount = manifestEntry.key_findings!.length;
    if (kfCount < 3) {
      score = 60;
      violations.push({
        requirement: 'BASIC-001',
        severity: 'warning',
        message: 'Less than 3 key findings',
      });
    }
  }

  // Check file field
  if (!manifestEntry.file) {
    score -= 10;
    violations.push({
      requirement: 'BASIC-002',
      severity: 'warning',
      message: 'Missing file field',
    });
  }

  // Check title
  if (!manifestEntry.title) {
    score -= 5;
    violations.push({
      requirement: 'BASIC-003',
      severity: 'warning',
      message: 'Missing title field',
    });
  }

  // Check linked_tasks
  if (!manifestEntry.linked_tasks || manifestEntry.linked_tasks.length === 0) {
    score -= 5;
    violations.push({
      requirement: 'BASIC-004',
      severity: 'warning',
      message: 'Missing or empty linked_tasks',
    });
  }

  return {
    valid: score >= 70,
    score,
    pass: score >= 70,
    agent_type: agentType,
    violations,
  };
}

// ============================================================================
// Compliance Logging
// ============================================================================

/**
 * Log validation results to the compliance JSONL file.
 * @task T4526
 */
export async function logRealCompliance(
  taskId: string,
  validationResult: ManifestValidationResult,
  agentType: string = 'unknown',
  compliancePath: string = DEFAULT_COMPLIANCE_PATH,
): Promise<void> {
  const metricsDir = dirname(compliancePath);
  await mkdir(metricsDir, { recursive: true });

  const { score, pass, violations } = validationResult;

  const violationCount = violations.length;
  let severity: 'none' | 'warning' | 'error' = 'none';
  if (violationCount > 0) {
    severity = violations.some(v => v.severity === 'error') ? 'error' : 'warning';
  }

  const passRate = pass ? 1.0 : Math.round(score / 100 * 100) / 100;

  const entry: ComplianceEntry = {
    timestamp: new Date().toISOString(),
    source_id: taskId,
    source_type: 'subagent',
    compliance: {
      compliance_pass_rate: passRate,
      rule_adherence_score: Math.round(score / 100 * 100) / 100,
      violation_count: violationCount,
      violation_severity: severity,
      manifest_integrity: violationCount === 0 ? 'valid' : 'violations_found',
    },
    efficiency: {
      input_tokens: 0,
      output_tokens: 0,
      context_utilization: 0,
      token_utilization_rate: 0,
    },
    _context: {
      agent_type: agentType,
      validation_score: score,
      violations,
    },
  };

  await appendFile(compliancePath, JSON.stringify(entry) + '\n');
}

// ============================================================================
// Combined Validate & Log
// ============================================================================

/**
 * Find, validate, and log compliance for a task in one call.
 * @task T4526
 */
export async function validateAndLog(
  taskId: string,
  manifestPath: string = DEFAULT_MANIFEST_PATH,
  compliancePath: string = DEFAULT_COMPLIANCE_PATH,
): Promise<ManifestValidationResult> {
  const entry = await findManifestEntry(taskId, manifestPath);

  if (!entry) {
    const noEntryResult: ManifestValidationResult = {
      valid: false,
      score: 0,
      pass: false,
      violations: [{
        requirement: 'MANIFEST-001',
        severity: 'error',
        message: 'No manifest entry found - subagent did not write output',
      }],
    };
    await logRealCompliance(taskId, noEntryResult, 'unknown', compliancePath);
    return noEntryResult;
  }

  const agentType = entry.agent_type ?? 'unknown';
  const result = await validateManifestEntry(taskId, entry, manifestPath);
  await logRealCompliance(taskId, result, agentType, compliancePath);

  return result;
}
