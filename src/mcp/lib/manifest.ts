/**
 * Manifest Integration System
 *
 * Reads and manages agent output manifests (MANIFEST.jsonl) with filtering,
 * validation, and task linkage capabilities.
 *
 * Manifest entries are append-only JSON Lines format where each line is a
 * single JSON object representing one agent output with metadata.
 *
 * @task T2919
 */

import { readFile } from 'fs/promises';
import { resolve } from 'path';

/**
 * Manifest entry structure
 *
 * Each entry represents one agent output with complete metadata including
 * task linkage, findings, and follow-up requirements.
 */
export interface ManifestEntry {
  /** Unique entry ID (format: T####-slug) */
  id: string;

  /** Relative path to output file */
  file: string;

  /** Human-readable title */
  title: string;

  /** ISO-8601 date (YYYY-MM-DD) */
  date: string;

  /** Completion status */
  status: 'complete' | 'partial' | 'blocked';

  /** Protocol type used */
  agent_type: string;

  /** Category tags (3-7 items recommended) */
  topics: string[];

  /** Key outcomes (3-7 items for research) */
  key_findings?: string[];

  /** Whether findings are actionable */
  actionable: boolean;

  /** Task IDs requiring follow-up */
  needs_followup?: string[];

  /** Related task IDs */
  linked_tasks?: string[];

  /** Confidence score (0.0-1.0) */
  confidence?: number;

  /** SHA256 of output file */
  file_checksum?: string;

  /** Wall-clock completion time in seconds */
  duration_seconds?: number;
}

/**
 * Filter criteria for manifest entries
 */
export interface ManifestFilter {
  /** Filter by task ID */
  taskId?: string;

  /** Filter by agent type */
  agent_type?: string;

  /** Filter by status */
  status?: 'complete' | 'partial' | 'blocked';

  /** Filter by date (ISO-8601) */
  date?: string;

  /** Filter by date range (after this date) */
  dateAfter?: string;

  /** Filter by date range (before this date) */
  dateBefore?: string;

  /** Filter by topic (exact match) */
  topic?: string;

  /** Filter by actionable flag */
  actionable?: boolean;

  /** Maximum number of entries to return */
  limit?: number;
}

/**
 * Manifest validation result
 */
export interface ManifestValidation {
  /** Whether entry is valid */
  valid: boolean;

  /** Validation errors */
  errors: Array<{
    field: string;
    message: string;
    severity: 'error' | 'warning';
  }>;
}

/**
 * Manifest reader and parser
 *
 * Provides methods to read, filter, and validate MANIFEST.jsonl entries
 * with efficient streaming for large files.
 */
export class ManifestReader {
  constructor(
    private manifestPath: string,
    private baseDir: string = process.cwd()
  ) {}

  /**
   * Read all entries from manifest
   *
   * Parses JSONL format (one JSON object per line) and returns array
   * of manifest entries. Skips invalid lines with warnings.
   *
   * @returns Array of parsed manifest entries
   */
  async readManifest(): Promise<ManifestEntry[]> {
    try {
      const absolutePath = resolve(this.baseDir, this.manifestPath);
      const content = await readFile(absolutePath, 'utf-8');

      const entries: ManifestEntry[] = [];
      const lines = content.split('\n');

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();

        // Skip empty lines
        if (!line) continue;

        try {
          const entry = JSON.parse(line) as ManifestEntry;
          entries.push(entry);
        } catch (parseError) {
          console.warn(`Invalid JSON at line ${i + 1}: ${parseError instanceof Error ? parseError.message : String(parseError)}`);
          continue;
        }
      }

      return entries;
    } catch (error) {
      // File doesn't exist or can't be read
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return [];
      }
      throw error;
    }
  }

  /**
   * Filter entries by criteria
   *
   * Applies multiple filter conditions using AND logic. All specified
   * conditions must match for an entry to be included.
   *
   * @param entries - Array of manifest entries to filter
   * @param filter - Filter criteria
   * @returns Filtered array of entries
   */
  filterEntries(entries: ManifestEntry[], filter: ManifestFilter): ManifestEntry[] {
    let filtered = entries;

    // Filter by task ID (check linked_tasks array)
    if (filter.taskId) {
      filtered = filtered.filter(
        (e) =>
          e.id.startsWith(filter.taskId!) ||
          e.linked_tasks?.includes(filter.taskId!)
      );
    }

    // Filter by agent type
    if (filter.agent_type) {
      filtered = filtered.filter((e) => e.agent_type === filter.agent_type);
    }

    // Filter by status
    if (filter.status) {
      filtered = filtered.filter((e) => e.status === filter.status);
    }

    // Filter by exact date
    if (filter.date) {
      filtered = filtered.filter((e) => e.date === filter.date);
    }

    // Filter by date range (after)
    if (filter.dateAfter) {
      filtered = filtered.filter((e) => e.date > filter.dateAfter!);
    }

    // Filter by date range (before)
    if (filter.dateBefore) {
      filtered = filtered.filter((e) => e.date < filter.dateBefore!);
    }

    // Filter by topic
    if (filter.topic) {
      filtered = filtered.filter((e) => e.topics.includes(filter.topic!));
    }

    // Filter by actionable flag
    if (filter.actionable !== undefined) {
      filtered = filtered.filter((e) => e.actionable === filter.actionable);
    }

    // Apply limit
    if (filter.limit && filter.limit > 0) {
      filtered = filtered.slice(0, filter.limit);
    }

    return filtered;
  }

  /**
   * Get entries for specific task
   *
   * Convenience method to get all manifest entries linked to a task ID.
   * Searches both the entry ID prefix and linked_tasks array.
   *
   * @param taskId - Task ID to search for (e.g., "T2919")
   * @returns Array of entries linked to task
   */
  async getTaskEntries(taskId: string): Promise<ManifestEntry[]> {
    const entries = await this.readManifest();
    return this.filterEntries(entries, { taskId });
  }

  /**
   * Validate manifest entry
   *
   * Checks required fields, format constraints, and data integrity.
   * Returns detailed validation results with field-level errors.
   *
   * @param entry - Manifest entry to validate
   * @returns Validation result with errors
   */
  validateEntry(entry: ManifestEntry): ManifestValidation {
    const errors: Array<{ field: string; message: string; severity: 'error' | 'warning' }> = [];

    // Required fields
    if (!entry.id) {
      errors.push({ field: 'id', message: 'id is required', severity: 'error' });
    } else if (!/^T\d{3,}-[a-z0-9-]+$/.test(entry.id)) {
      errors.push({
        field: 'id',
        message: 'id must match pattern T####-slug',
        severity: 'error',
      });
    }

    if (!entry.file) {
      errors.push({ field: 'file', message: 'file is required', severity: 'error' });
    }

    if (!entry.title) {
      errors.push({ field: 'title', message: 'title is required', severity: 'error' });
    }

    if (!entry.date) {
      errors.push({ field: 'date', message: 'date is required', severity: 'error' });
    } else if (!/^\d{4}-\d{2}-\d{2}$/.test(entry.date)) {
      errors.push({
        field: 'date',
        message: 'date must be ISO-8601 format (YYYY-MM-DD)',
        severity: 'error',
      });
    }

    if (!entry.status) {
      errors.push({ field: 'status', message: 'status is required', severity: 'error' });
    } else if (!['complete', 'partial', 'blocked'].includes(entry.status)) {
      errors.push({
        field: 'status',
        message: 'status must be complete, partial, or blocked',
        severity: 'error',
      });
    }

    if (!entry.agent_type) {
      errors.push({ field: 'agent_type', message: 'agent_type is required', severity: 'error' });
    }

    if (!entry.topics) {
      errors.push({ field: 'topics', message: 'topics array is required', severity: 'error' });
    } else if (!Array.isArray(entry.topics)) {
      errors.push({ field: 'topics', message: 'topics must be an array', severity: 'error' });
    }

    if (entry.actionable === undefined) {
      errors.push({ field: 'actionable', message: 'actionable is required', severity: 'error' });
    }

    // Optional field validation
    if (entry.key_findings) {
      if (!Array.isArray(entry.key_findings)) {
        errors.push({
          field: 'key_findings',
          message: 'key_findings must be an array',
          severity: 'error',
        });
      } else if (entry.key_findings.length < 3 || entry.key_findings.length > 7) {
        errors.push({
          field: 'key_findings',
          message: 'key_findings should have 3-7 items',
          severity: 'warning',
        });
      }
    }

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

    return {
      valid: errors.filter((e) => e.severity === 'error').length === 0,
      errors,
    };
  }

  /**
   * Validate entire manifest
   *
   * Reads manifest and validates all entries. Returns aggregated
   * validation results with entry-level details.
   *
   * @returns Validation results for all entries
   */
  async validateManifest(): Promise<{
    valid: boolean;
    totalEntries: number;
    validEntries: number;
    invalidEntries: number;
    errors: Array<{ entryId: string; errors: ManifestValidation['errors'] }>;
  }> {
    const entries = await this.readManifest();
    const results = entries.map((entry) => ({
      entryId: entry.id,
      validation: this.validateEntry(entry),
    }));

    const invalidEntries = results.filter((r) => !r.validation.valid);

    return {
      valid: invalidEntries.length === 0,
      totalEntries: entries.length,
      validEntries: results.length - invalidEntries.length,
      invalidEntries: invalidEntries.length,
      errors: invalidEntries.map((r) => ({
        entryId: r.entryId,
        errors: r.validation.errors,
      })),
    };
  }

  /**
   * Get summary statistics from manifest
   *
   * Aggregates manifest entries into summary statistics for reporting.
   *
   * @returns Summary statistics
   */
  async getSummary(): Promise<{
    total: number;
    byStatus: Record<string, number>;
    byAgentType: Record<string, number>;
    actionable: number;
    needsFollowup: number;
  }> {
    const entries = await this.readManifest();

    const byStatus: Record<string, number> = {};
    const byAgentType: Record<string, number> = {};
    let actionable = 0;
    let needsFollowup = 0;

    for (const entry of entries) {
      // Count by status
      byStatus[entry.status] = (byStatus[entry.status] || 0) + 1;

      // Count by agent type
      byAgentType[entry.agent_type] = (byAgentType[entry.agent_type] || 0) + 1;

      // Count actionable
      if (entry.actionable) {
        actionable++;
      }

      // Count needs followup
      if (entry.needs_followup && entry.needs_followup.length > 0) {
        needsFollowup++;
      }
    }

    return {
      total: entries.length,
      byStatus,
      byAgentType,
      actionable,
      needsFollowup,
    };
  }
}

/**
 * Create manifest reader instance
 *
 * Factory function for creating configured ManifestReader.
 *
 * @param manifestPath - Path to MANIFEST.jsonl (relative to baseDir)
 * @param baseDir - Base directory (default: cwd)
 * @returns Configured ManifestReader
 */
export function createManifestReader(
  manifestPath: string,
  baseDir?: string
): ManifestReader {
  return new ManifestReader(manifestPath, baseDir);
}
