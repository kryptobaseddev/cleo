/**
 * ADR Core Types (ADR-017)
 *
 * Type definitions for parsed ADR frontmatter and operations.
 *
 * @task T4792
 */

/** Parsed ADR frontmatter from .md file */
export interface AdrFrontmatter {
  Date: string;
  Status: 'proposed' | 'accepted' | 'superseded' | 'deprecated';
  Accepted?: string;
  Supersedes?: string;
  'Superseded By'?: string;
  Amends?: string;
  'Amended By'?: string;
  'Related ADRs'?: string;
  'Related Tasks'?: string;
  Gate?: 'HITL' | 'automated';
  'Gate Status'?: 'pending' | 'passed' | 'waived';
}

export interface AdrRecord {
  id: string;        // e.g., 'ADR-007'
  file: string;      // relative path from project root
  title: string;     // H1 title from markdown
  frontmatter: AdrFrontmatter;
}

export interface AdrSyncResult {
  inserted: number;
  updated: number;
  skipped: number;
  errors: Array<{ file: string; error: string }>;
}

export interface AdrListResult {
  adrs: Array<{
    id: string;
    title: string;
    status: string;
    date: string;
    filePath: string;
  }>;
  total: number;
}
