/**
 * Documentation gap analysis - ported from lib/validation/gap-check.sh
 *
 * Finds documents in review status, analyzes topic coverage against
 * canonical docs, and produces gap reports.
 *
 * @task T4524
 * @epic T4454
 */

// Gap analysis does not use fs directly - manifest parsing is string-based

// ============================================================================
// Types
// ============================================================================

export interface ManifestDoc {
  id: string;
  file: string;
  title: string;
  topics: string[];
  linked_tasks: string[];
  status: string;
}

export interface GapEntry {
  type: string;
  severity: string;
  document: string;
  topic: string;
  fix: string;
}

export interface CoverageEntry {
  document: string;
  topic: string;
}

export interface GapReport {
  epicId: string;
  timestamp: string;
  reviewDocs: ManifestDoc[];
  gaps: GapEntry[];
  coverage: CoverageEntry[];
  status: 'no_review_docs' | 'ready_to_archive' | 'gaps_detected';
  canArchive: boolean;
}

// ============================================================================
// Manifest Operations
// ============================================================================

/**
 * Parse a MANIFEST.jsonl file into entries.
 * Skips invalid JSON lines gracefully.
 * @task T4524
 */
export function parseManifest(content: string): ManifestDoc[] {
  const entries: ManifestDoc[] = [];
  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      entries.push({
        id: entry.id ?? '',
        file: entry.file ?? '',
        title: entry.title ?? '',
        topics: entry.topics ?? [],
        linked_tasks: entry.linked_tasks ?? [],
        status: entry.status ?? 'unknown',
      });
    } catch {
      // Skip invalid JSON lines
    }
  }
  return entries;
}

/**
 * Find documents in review status.
 * @task T4524
 */
export function findReviewDocs(entries: ManifestDoc[], filterId?: string): ManifestDoc[] {
  return entries.filter(doc => {
    if (doc.status !== 'review') return false;
    if (filterId && !doc.linked_tasks.includes(filterId)) return false;
    return true;
  });
}

/**
 * Extract markdown headings from file content.
 * @task T4524
 */
export function extractTopics(content: string): string[] {
  return content
    .split('\n')
    .filter(line => /^##+ /.test(line))
    .map(line => line.replace(/^##+ /, ''));
}

/**
 * Search for topic coverage in a docs directory.
 * Returns count of matching files.
 * @task T4524
 */
export function searchCanonicalCoverage(
  topic: string,
  docsFileContents: Map<string, string>,
): { topic: string; matches: number; files: string[] } {
  const escapedTopic = topic.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const regex = new RegExp(escapedTopic, 'i');

  const matchingFiles: string[] = [];
  for (const [filePath, content] of docsFileContents) {
    if (regex.test(content)) {
      matchingFiles.push(filePath);
    }
  }

  return { topic, matches: matchingFiles.length, files: matchingFiles };
}

// ============================================================================
// Gap Analysis
// ============================================================================

/**
 * Analyze documentation coverage for review documents.
 * @task T4524
 */
export function analyzeCoverage(
  reviewDocs: ManifestDoc[],
  docsFileContents: Map<string, string>,
  filterId?: string,
): GapReport {
  const timestamp = new Date().toISOString();

  if (reviewDocs.length === 0) {
    return {
      epicId: filterId ?? 'all',
      timestamp,
      reviewDocs: [],
      gaps: [],
      coverage: [],
      status: 'no_review_docs',
      canArchive: false,
    };
  }

  const gaps: GapEntry[] = [];
  const coverage: CoverageEntry[] = [];

  for (const doc of reviewDocs) {
    for (const topic of doc.topics) {
      const coverageInfo = searchCanonicalCoverage(topic, docsFileContents);

      if (coverageInfo.matches === 0) {
        gaps.push({
          type: 'missing_topic_coverage',
          severity: 'warning',
          document: doc.id,
          topic,
          fix: `Document ${topic} in canonical docs/`,
        });
      } else {
        coverage.push({ document: doc.id, topic });
      }
    }
  }

  return {
    epicId: filterId ?? 'all',
    timestamp,
    reviewDocs,
    gaps,
    coverage,
    status: gaps.length === 0 ? 'ready_to_archive' : 'gaps_detected',
    canArchive: gaps.length === 0,
  };
}

/**
 * Format a gap report for human-readable display.
 * @task T4524
 */
export function formatGapReport(report: GapReport): string {
  const lines: string[] = [];

  lines.push(`Gap Analysis for Epic ${report.epicId}`);
  lines.push('====================================');
  lines.push('');

  if (report.status === 'no_review_docs') {
    lines.push('No documents in review status.');
    lines.push('');
    lines.push('Status: All clear (nothing to archive)');
    return lines.join('\n');
  }

  lines.push(`Documents in review (${report.reviewDocs.length}):`);
  for (const doc of report.reviewDocs) {
    lines.push(`  - ${doc.file} (linked to ${doc.linked_tasks.join(', ')})`);
  }
  lines.push('');

  if (report.coverage.length > 0) {
    lines.push(`Topics with canonical coverage (${report.coverage.length}):`);
    // Group by document
    const byDoc = new Map<string, string[]>();
    for (const c of report.coverage) {
      if (!byDoc.has(c.document)) byDoc.set(c.document, []);
      byDoc.get(c.document)!.push(c.topic);
    }
    for (const [doc, topics] of byDoc) {
      lines.push(`  + ${doc}: ${topics.join(', ')}`);
    }
    lines.push('');
  }

  if (report.gaps.length > 0) {
    lines.push(`Gaps detected (${report.gaps.length}):`);
    for (const gap of report.gaps) {
      lines.push(`  x ${gap.document}: ${gap.topic} - ${gap.fix}`);
    }
    lines.push('');
    lines.push('Status: Gaps detected (archival blocked)');
  } else {
    lines.push('Status: No gaps detected (ready to archive)');
  }

  return lines.join('\n');
}
