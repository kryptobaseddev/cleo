/**
 * Protocol validation common utilities - ported from lib/validation/protocol-validation-common.sh
 *
 * Reusable validation functions for checking output files, manifest fields,
 * return message format, key findings count, status validity, and provenance.
 *
 * @task T4527
 * @epic T4454
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { MANIFEST_STATUSES } from '@cleocode/contracts';

// ============================================================================
// Types
// ============================================================================

export interface ProtocolViolation {
  requirement: string;
  severity: 'error' | 'warning';
  message: string;
  fix?: string;
}

export interface ProtocolValidationResult {
  valid: boolean;
  violations: ProtocolViolation[];
  score: number;
}

// ============================================================================
// Output File Validation
// ============================================================================

/**
 * Check if expected output file exists.
 * @task T4527
 */
export function checkOutputFileExists(
  taskId: string,
  expectedDir: string,
  pattern?: string,
): boolean {
  if (!existsSync(expectedDir)) return false;

  const filePattern = pattern ?? `${taskId}`;
  try {
    const files = readdirSync(expectedDir);
    return files.some((f) => f.includes(filePattern) && f.endsWith('.md'));
  } catch {
    return false;
  }
}

/**
 * Check if file contains required documentation sections.
 * @task T4527
 */
export function checkDocumentationSections(filePath: string, sections: string[]): boolean {
  if (!existsSync(filePath)) return false;

  try {
    const content = readFileSync(filePath, 'utf-8');
    return sections.every((section) => {
      const regex = new RegExp(`^#+ .*${escapeRegex(section)}`, 'm');
      return regex.test(content);
    });
  } catch {
    return false;
  }
}

// ============================================================================
// Return Message Validation
// ============================================================================

const VALID_TYPES = [
  'Research',
  'Implementation',
  'Validation',
  'Testing',
  'Specification',
  'Consensus',
  'Decomposition',
  'Contribution',
  'Release',
];
const VALID_STATUSES_MSG = MANIFEST_STATUSES.filter((s) => s !== 'archived');
const VALID_DETAILS = ['summary', 'details', 'blocker details'];

/**
 * Map from protocol type identifiers to the expected message type prefix.
 * When a protocolType is provided, the return message must use the matching type.
 */
const PROTOCOL_TYPE_MAP: Record<string, string> = {
  research: 'Research',
  implementation: 'Implementation',
  validation: 'Validation',
  testing: 'Testing',
  specification: 'Specification',
  consensus: 'Consensus',
  decomposition: 'Decomposition',
  contribution: 'Contribution',
  release: 'Release',
};

/**
 * Check if return message follows protocol format.
 * Expected: "<Type> <status>. See MANIFEST.jsonl for <detail>."
 *
 * When protocolType is provided, the message type must match the protocol
 * (e.g., a 'research' protocol must produce a "Research ..." message).
 *
 * @task T4527
 */
export function checkReturnMessageFormat(message: string, protocolType?: string): boolean {
  const statusPattern = VALID_STATUSES_MSG.join('|');
  const detailPattern = VALID_DETAILS.join('|');

  // If protocolType is given, constrain the type to the matching prefix
  let typePattern: string;
  if (protocolType) {
    const expectedType = PROTOCOL_TYPE_MAP[protocolType.toLowerCase()];
    if (!expectedType) {
      // Unknown protocol type — fall back to allowing any valid type
      typePattern = VALID_TYPES.join('|');
    } else {
      typePattern = expectedType;
    }
  } else {
    typePattern = VALID_TYPES.join('|');
  }

  const regex = new RegExp(
    `^(${typePattern}) (${statusPattern})\\. See MANIFEST\\.jsonl for (${detailPattern})\\.$`,
  );
  return regex.test(message);
}

// ============================================================================
// Manifest Field Validation
// ============================================================================

/**
 * Check if manifest entry has a required field (non-null, non-empty).
 * @task T4527
 */
export function checkManifestFieldPresent(
  entry: Record<string, unknown>,
  fieldName: string,
): boolean {
  const value = entry[fieldName];
  return value !== undefined && value !== null && value !== '';
}

/**
 * Check if manifest field has expected type.
 * @task T4527
 */
export function checkManifestFieldType(
  entry: Record<string, unknown>,
  fieldName: string,
  expectedType: 'string' | 'array' | 'number' | 'boolean' | 'object',
): boolean {
  const value = entry[fieldName];
  if (value === undefined || value === null) return false;

  switch (expectedType) {
    case 'array':
      return Array.isArray(value);
    case 'string':
      return typeof value === 'string';
    case 'number':
      return typeof value === 'number';
    case 'boolean':
      return typeof value === 'boolean';
    case 'object':
      return typeof value === 'object' && !Array.isArray(value);
    default:
      return false;
  }
}

/**
 * Check if key_findings array has valid count (3-7).
 * @task T4527
 */
export function checkKeyFindingsCount(entry: Record<string, unknown>): boolean {
  const kf = entry['key_findings'];
  if (!Array.isArray(kf)) return false;
  return kf.length >= 3 && kf.length <= 7;
}

/**
 * Check if status is valid enum value.
 * @task T4527
 */
export function checkStatusValid(entry: Record<string, unknown>): boolean {
  const status = entry['status'];
  if (typeof status !== 'string') return false;
  return (MANIFEST_STATUSES as readonly string[]).includes(status);
}

/**
 * Check if agent_type matches expected value.
 * @task T4527
 */
export function checkAgentType(entry: Record<string, unknown>, expectedType: string): boolean {
  return entry['agent_type'] === expectedType;
}

/**
 * Check if linked_tasks array contains required task IDs.
 * @task T4527
 */
export function checkLinkedTasksPresent(
  entry: Record<string, unknown>,
  requiredIds: string[],
): boolean {
  const linkedTasks = entry['linked_tasks'];
  if (!Array.isArray(linkedTasks)) return false;
  return requiredIds.every((id) => linkedTasks.includes(id));
}

// ============================================================================
// Provenance Validation
// ============================================================================

/**
 * Check if file contains @task provenance tag.
 * @task T4527
 */
export function checkProvenanceTags(filePath: string, taskId?: string): boolean {
  if (!existsSync(filePath)) return false;

  try {
    const content = readFileSync(filePath, 'utf-8');
    if (taskId) {
      return content.includes(`@task ${taskId}`);
    }
    return /@task T\d+/.test(content);
  } catch {
    return false;
  }
}

// ============================================================================
// Composite Validators
// ============================================================================

/**
 * Validate common manifest requirements across all protocols.
 *
 * When protocolType is provided, additionally validates that the manifest
 * entry's agent_type matches the expected protocol type.
 *
 * @task T4527
 */
export function validateCommonManifestRequirements(
  entry: Record<string, unknown>,
  protocolType?: string,
): ProtocolValidationResult {
  const violations: ProtocolViolation[] = [];
  let score = 100;

  // Check id field
  if (!checkManifestFieldPresent(entry, 'id')) {
    violations.push({
      requirement: 'COMMON-001',
      severity: 'error',
      message: 'Missing id field',
      fix: 'Add unique id to manifest entry',
    });
    score -= 20;
  }

  // Check file field
  if (!checkManifestFieldPresent(entry, 'file')) {
    violations.push({
      requirement: 'COMMON-002',
      severity: 'error',
      message: 'Missing file field',
      fix: 'Add file path to manifest entry',
    });
    score -= 15;
  }

  // Check status field
  if (!checkStatusValid(entry)) {
    violations.push({
      requirement: 'COMMON-003',
      severity: 'error',
      message: 'Invalid status value',
      fix: 'Set status to completed/partial/blocked',
    });
    score -= 15;
  }

  // Check key_findings
  if (!checkManifestFieldPresent(entry, 'key_findings')) {
    violations.push({
      requirement: 'COMMON-004',
      severity: 'error',
      message: 'Missing key_findings',
      fix: 'Add key_findings array with 3-7 items',
    });
    score -= 15;
  } else if (!checkKeyFindingsCount(entry)) {
    violations.push({
      requirement: 'COMMON-005',
      severity: 'warning',
      message: 'key_findings should have 3-7 items',
      fix: 'Adjust key_findings count',
    });
    score -= 5;
  }

  // Check linked_tasks
  if (!checkManifestFieldPresent(entry, 'linked_tasks')) {
    violations.push({
      requirement: 'COMMON-006',
      severity: 'warning',
      message: 'Missing linked_tasks',
      fix: 'Add linked_tasks array with epic and task IDs',
    });
    score -= 5;
  }

  // Protocol-specific: verify agent_type matches the protocol when specified
  if (protocolType && checkManifestFieldPresent(entry, 'agent_type')) {
    const expectedType = PROTOCOL_TYPE_MAP[protocolType.toLowerCase()];
    if (expectedType && !checkAgentType(entry, expectedType.toLowerCase())) {
      violations.push({
        requirement: 'COMMON-007',
        severity: 'warning',
        message: `agent_type '${String(entry['agent_type'])}' does not match protocol '${protocolType}'`,
        fix: `Set agent_type to '${expectedType.toLowerCase()}'`,
      });
      score -= 5;
    }
  }

  return {
    valid: score >= 70,
    violations,
    score,
  };
}

// ============================================================================
// Helpers
// ============================================================================

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
