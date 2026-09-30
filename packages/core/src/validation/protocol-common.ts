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
  'ADR',
  'Decomposition',
  'Contribution',
  'Release',
];

/**
 * Statuses a return message may carry. `complete` is the spelling the spawn
 * prompt renders; `completed` is the manifest status and stays accepted.
 */
const RETURN_STATUSES = ['complete', ...MANIFEST_STATUSES.filter((s) => s !== 'archived')];

/** Tail of the legacy one-line return message (ADR-027). */
const LEGACY_RETURN_TAIL = ' Manifest appended to pipeline_manifest.';

/** Keys a compressed return message may carry after its first line (T12521). */
const RETURN_DETAIL_KEYS = ['commits', 'gates', 'blocker'] as const;

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
  architecture_decision: 'ADR',
  decomposition: 'Decomposition',
  contribution: 'Contribution',
  release: 'Release',
};

/**
 * A subagent return message, parsed (T12521).
 *
 * Two forms are accepted:
 * - **compressed** — line 1 `<Type> <status>. manifest:<entryId>`, then
 *   optional `commits:`, `gates:` and `blocker:` lines, each at most once.
 * - **legacy** — the single line
 *   `<Type> <status>. Manifest appended to pipeline_manifest.`
 */
export interface ParsedReturnMessage {
  /** Which accepted form the message used. */
  form: 'compressed' | 'legacy';
  /** Type word, e.g. `Implementation`. */
  type: string;
  /** Status word: `complete`, `completed`, `partial` or `blocked`. */
  status: string;
  /** Manifest entry id (compressed form only; `null` for legacy). */
  entryId: string | null;
  /** `commits:` value, or `null` when the line is absent. */
  commits: string | null;
  /** `gates:` value, or `null` when the line is absent. */
  gates: string | null;
  /** `blocker:` value, or `null` when the line is absent. */
  blocker: string | null;
}

/**
 * Parse a subagent return message in the compressed or the legacy form.
 *
 * One surrounding ``` fence is stripped first. In the compressed form:
 * `blocker` must be `none` (or absent) when the status is
 * `complete`/`completed`, and present and not `none` when it is
 * `partial`/`blocked`; `manifest:none` is accepted only for `partial`/`blocked`;
 * an entry id containing `<` or `>` (an unfilled `<entryId>` placeholder) is
 * rejected. Unknown, duplicate or empty detail lines reject the message, and a
 * legacy message must be exactly one line (its rules are unchanged).
 *
 * @param message - Raw return message (surrounding whitespace and one
 *   surrounding code fence are ignored).
 * @param types - Allowed type words; omitted, any non-empty type is allowed.
 * @returns The parsed message, or `null` when it matches neither form.
 * @task T12521
 */
export function parseReturnMessage(
  message: string,
  types?: readonly string[],
): ParsedReturnMessage | null {
  const lines = stripReturnFence(message.trim().split(/\r?\n/));
  const typePattern = types ? types.map(escapeRegex).join('|') : '.+?';
  const head = new RegExp(
    `^(${typePattern}) (${RETURN_STATUSES.join('|')})\\.(?:${escapeRegex(LEGACY_RETURN_TAIL)}| manifest:(\\S+))$`,
  ).exec(lines[0] ?? '');
  const type = head?.[1];
  const status = head?.[2];
  if (!type || !status) return null;
  const entryId = head?.[3] ?? null;
  const parsed: ParsedReturnMessage = {
    form: entryId ? 'compressed' : 'legacy',
    type,
    status,
    entryId,
    commits: null,
    gates: null,
    blocker: null,
  };
  if (parsed.form === 'legacy') return lines.length === 1 ? parsed : null;
  for (const line of lines.slice(1)) {
    const detail = /^(\w+): (\S.*)$/.exec(line.trim());
    const key = RETURN_DETAIL_KEYS.find((k) => k === detail?.[1]);
    const value = detail?.[2]?.trim();
    if (!key || !value || parsed[key] !== null) return null;
    parsed[key] = value;
  }
  if (/[<>]/.test(entryId ?? '')) return null;
  const done = status === 'complete' || status === 'completed';
  const blocked = parsed.blocker !== null && parsed.blocker !== 'none';
  if (done && (blocked || entryId === 'none')) return null;
  if (!done && !blocked) return null;
  return parsed;
}

/**
 * Drop one surrounding ``` fence (with an optional info string) from the
 * lines of a return message, so a block copied verbatim from the spawn
 * prompt's template still parses (T12521).
 */
function stripReturnFence(lines: string[]): string[] {
  const first = lines[0]?.trim() ?? '';
  const last = lines[lines.length - 1]?.trim() ?? '';
  if (lines.length >= 3 && /^```[\w-]*$/.test(first) && last === '```') {
    return lines.slice(1, -1).map((line) => line.trim());
  }
  return lines;
}

/**
 * Check if return message follows protocol format — the compressed form
 * (`<Type> <status>. manifest:<entryId>` plus optional detail lines) or the
 * legacy one-liner (`<Type> <status>. Manifest appended to pipeline_manifest.`).
 *
 * When protocolType is provided, the message type must match the protocol
 * (e.g., a 'research' protocol must produce a "Research ..." message).
 *
 * @task T4527
 * @task T12521
 */
export function checkReturnMessageFormat(message: string, protocolType?: string): boolean {
  // Unknown protocol type — fall back to allowing any valid type.
  const expectedType = protocolType ? PROTOCOL_TYPE_MAP[protocolType.toLowerCase()] : undefined;
  return parseReturnMessage(message, expectedType ? [expectedType] : VALID_TYPES) !== null;
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
