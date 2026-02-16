/**
 * Manifest Parser Utilities
 *
 * Low-level parsing and validation functions for MANIFEST.jsonl entries.
 * Used by ManifestReader for line-by-line processing.
 *
 * @task T2919
 */

import type { ManifestEntry, ManifestValidation } from './manifest.js';

/**
 * Parse single JSONL line into ManifestEntry
 *
 * Attempts to parse a line from MANIFEST.jsonl into a structured entry.
 * Throws on invalid JSON or returns partial entry on parsing errors.
 *
 * @param line - Single line from JSONL file
 * @returns Parsed manifest entry
 * @throws Error if JSON is invalid
 */
export function parseManifestLine(line: string): ManifestEntry {
  const trimmed = line.trim();

  if (!trimmed) {
    throw new Error('Empty line');
  }

  try {
    const parsed = JSON.parse(trimmed);

    // Basic structure check
    if (typeof parsed !== 'object' || parsed === null) {
      throw new Error('Entry must be an object');
    }

    return parsed as ManifestEntry;
  } catch (error) {
    throw new Error(`Invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Validate entry format and required fields
 *
 * Performs comprehensive validation of manifest entry structure,
 * required fields, and data constraints.
 *
 * @param entry - Manifest entry to validate
 * @returns Validation result with detailed errors
 */
export function validateEntry(entry: ManifestEntry): ManifestValidation {
  const errors: Array<{ field: string; message: string; severity: 'error' | 'warning' }> = [];

  // === Required Fields ===

  // ID validation
  if (!entry.id) {
    errors.push({ field: 'id', message: 'id is required', severity: 'error' });
  } else {
    // ID format: T####-slug
    if (!/^T\d{3,}-[a-z0-9-]+$/.test(entry.id)) {
      errors.push({
        field: 'id',
        message: 'id must match pattern T####-slug (e.g., T2919-manifest-integration)',
        severity: 'error',
      });
    }
  }

  // File validation
  if (!entry.file) {
    errors.push({ field: 'file', message: 'file is required', severity: 'error' });
  } else if (typeof entry.file !== 'string') {
    errors.push({ field: 'file', message: 'file must be a string', severity: 'error' });
  }

  // Title validation
  if (!entry.title) {
    errors.push({ field: 'title', message: 'title is required', severity: 'error' });
  } else if (typeof entry.title !== 'string') {
    errors.push({ field: 'title', message: 'title must be a string', severity: 'error' });
  }

  // Date validation
  if (!entry.date) {
    errors.push({ field: 'date', message: 'date is required', severity: 'error' });
  } else if (!/^\d{4}-\d{2}-\d{2}$/.test(entry.date)) {
    errors.push({
      field: 'date',
      message: 'date must be ISO-8601 format (YYYY-MM-DD)',
      severity: 'error',
    });
  } else {
    // Check date is valid
    const dateObj = new Date(entry.date);
    if (isNaN(dateObj.getTime())) {
      errors.push({
        field: 'date',
        message: 'date must be a valid date',
        severity: 'error',
      });
    }
  }

  // Status validation
  if (!entry.status) {
    errors.push({ field: 'status', message: 'status is required', severity: 'error' });
  } else if (!['complete', 'partial', 'blocked'].includes(entry.status)) {
    errors.push({
      field: 'status',
      message: 'status must be one of: complete, partial, blocked',
      severity: 'error',
    });
  }

  // Agent type validation
  if (!entry.agent_type) {
    errors.push({ field: 'agent_type', message: 'agent_type is required', severity: 'error' });
  } else if (typeof entry.agent_type !== 'string') {
    errors.push({
      field: 'agent_type',
      message: 'agent_type must be a string',
      severity: 'error',
    });
  }

  // Topics validation
  if (!entry.topics) {
    errors.push({ field: 'topics', message: 'topics array is required', severity: 'error' });
  } else if (!Array.isArray(entry.topics)) {
    errors.push({ field: 'topics', message: 'topics must be an array', severity: 'error' });
  } else if (entry.topics.length === 0) {
    errors.push({
      field: 'topics',
      message: 'topics array must not be empty',
      severity: 'warning',
    });
  } else if (entry.topics.some((t) => typeof t !== 'string')) {
    errors.push({
      field: 'topics',
      message: 'all topics must be strings',
      severity: 'error',
    });
  }

  // Actionable validation
  if (entry.actionable === undefined || entry.actionable === null) {
    errors.push({ field: 'actionable', message: 'actionable is required', severity: 'error' });
  } else if (typeof entry.actionable !== 'boolean') {
    errors.push({
      field: 'actionable',
      message: 'actionable must be a boolean',
      severity: 'error',
    });
  }

  // === Optional Fields ===

  // Key findings validation (for research)
  if (entry.key_findings !== undefined) {
    if (!Array.isArray(entry.key_findings)) {
      errors.push({
        field: 'key_findings',
        message: 'key_findings must be an array',
        severity: 'error',
      });
    } else {
      if (entry.key_findings.length < 3) {
        errors.push({
          field: 'key_findings',
          message: 'key_findings should have at least 3 items',
          severity: 'warning',
        });
      }
      if (entry.key_findings.length > 7) {
        errors.push({
          field: 'key_findings',
          message: 'key_findings should have at most 7 items',
          severity: 'warning',
        });
      }
      if (entry.key_findings.some((f) => typeof f !== 'string')) {
        errors.push({
          field: 'key_findings',
          message: 'all key_findings must be strings',
          severity: 'error',
        });
      }
    }
  }

  // Needs followup validation
  if (entry.needs_followup !== undefined) {
    if (!Array.isArray(entry.needs_followup)) {
      errors.push({
        field: 'needs_followup',
        message: 'needs_followup must be an array',
        severity: 'error',
      });
    } else if (entry.needs_followup.some((id) => typeof id !== 'string')) {
      errors.push({
        field: 'needs_followup',
        message: 'all needs_followup items must be strings',
        severity: 'error',
      });
    } else if (entry.needs_followup.some((id) => !/^T\d+$/.test(id))) {
      errors.push({
        field: 'needs_followup',
        message: 'all needs_followup items must be task IDs (T####)',
        severity: 'warning',
      });
    }
  }

  // Linked tasks validation
  if (entry.linked_tasks !== undefined) {
    if (!Array.isArray(entry.linked_tasks)) {
      errors.push({
        field: 'linked_tasks',
        message: 'linked_tasks must be an array',
        severity: 'error',
      });
    } else if (entry.linked_tasks.some((id) => typeof id !== 'string')) {
      errors.push({
        field: 'linked_tasks',
        message: 'all linked_tasks must be strings',
        severity: 'error',
      });
    } else if (entry.linked_tasks.some((id) => !/^T\d+$/.test(id))) {
      errors.push({
        field: 'linked_tasks',
        message: 'all linked_tasks must be task IDs (T####)',
        severity: 'warning',
      });
    }
  }

  // Confidence validation
  if (entry.confidence !== undefined) {
    if (typeof entry.confidence !== 'number') {
      errors.push({
        field: 'confidence',
        message: 'confidence must be a number',
        severity: 'error',
      });
    } else if (entry.confidence < 0 || entry.confidence > 1) {
      errors.push({
        field: 'confidence',
        message: 'confidence must be between 0.0 and 1.0',
        severity: 'error',
      });
    }
  }

  // File checksum validation
  if (entry.file_checksum !== undefined) {
    if (typeof entry.file_checksum !== 'string') {
      errors.push({
        field: 'file_checksum',
        message: 'file_checksum must be a string',
        severity: 'error',
      });
    } else if (!/^[a-f0-9]{64}$/.test(entry.file_checksum)) {
      errors.push({
        field: 'file_checksum',
        message: 'file_checksum must be 64-character hex string (SHA256)',
        severity: 'warning',
      });
    }
  }

  // Duration validation
  if (entry.duration_seconds !== undefined) {
    if (typeof entry.duration_seconds !== 'number') {
      errors.push({
        field: 'duration_seconds',
        message: 'duration_seconds must be a number',
        severity: 'error',
      });
    } else if (entry.duration_seconds < 0) {
      errors.push({
        field: 'duration_seconds',
        message: 'duration_seconds must be non-negative',
        severity: 'error',
      });
    }
  }

  return {
    valid: errors.filter((e) => e.severity === 'error').length === 0,
    errors,
  };
}

/**
 * Serialize manifest entry to JSONL format
 *
 * Converts ManifestEntry to compact single-line JSON suitable for
 * appending to MANIFEST.jsonl file.
 *
 * @param entry - Manifest entry to serialize
 * @returns Single-line JSON string
 */
export function serializeEntry(entry: ManifestEntry): string {
  // Ensure all required fields are present
  const validation = validateEntry(entry);
  if (!validation.valid) {
    const errorMessages = validation.errors
      .filter((e) => e.severity === 'error')
      .map((e) => `${e.field}: ${e.message}`)
      .join(', ');
    throw new Error(`Cannot serialize invalid entry: ${errorMessages}`);
  }

  // Serialize to compact JSON (no whitespace)
  return JSON.stringify(entry);
}

/**
 * Extract task ID from entry ID
 *
 * Extracts the task ID prefix from a manifest entry ID.
 * Example: "T2919-manifest-integration" → "T2919"
 *
 * @param entryId - Entry ID (T####-slug format)
 * @returns Task ID or null if invalid format
 */
export function extractTaskId(entryId: string): string | null {
  const match = entryId.match(/^(T\d+)-/);
  return match ? match[1] : null;
}

/**
 * Check if entry needs followup
 *
 * Determines if a manifest entry requires follow-up actions based
 * on status and needs_followup field.
 *
 * @param entry - Manifest entry to check
 * @returns True if entry needs followup
 */
export function needsFollowup(entry: ManifestEntry): boolean {
  return (
    entry.status !== 'complete' ||
    (entry.needs_followup !== undefined && entry.needs_followup.length > 0)
  );
}
