/**
 * ADR Frontmatter Parser (ADR-017)
 *
 * Parses bold-key frontmatter from ADR markdown files.
 * Pattern: **Key**: value
 *
 * @task T4792
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AdrRecord, AdrFrontmatter } from './types.js';

/** Extract ADR ID from filename (e.g., 'ADR-007-domain-consolidation.md' -> 'ADR-007') */
export function extractAdrId(filename: string): string {
  const match = filename.match(/^(ADR-\d+)/);
  return match ? match[1]! : filename.replace('.md', '');
}

/** Parse bold-key frontmatter pattern: **Key**: value */
export function parseFrontmatter(content: string): AdrFrontmatter {
  const frontmatter: Record<string, string> = {};
  const lines = content.split('\n');

  // Parse lines until first --- separator (skip H1 title)
  for (const line of lines) {
    if (line.trim() === '---') break;
    const match = line.match(/^\*\*([^*]+)\*\*:\s*(.+)$/);
    if (match) {
      frontmatter[match[1]!.trim()] = match[2]!.trim();
    }
  }

  return frontmatter as unknown as AdrFrontmatter;
}

/** Extract H1 title from markdown */
export function extractTitle(content: string): string {
  const match = content.match(/^#\s+(.+)$/m);
  return match ? match[1]!.trim() : 'Untitled';
}

/** Parse a single ADR markdown file into an AdrRecord */
export function parseAdrFile(filePath: string, projectRoot: string): AdrRecord {
  const absolutePath = filePath.startsWith('/') ? filePath : join(projectRoot, filePath);
  const content = readFileSync(absolutePath, 'utf-8');
  const filename = filePath.split('/').pop()!;

  return {
    id: extractAdrId(filename),
    file: filePath,
    title: extractTitle(content),
    frontmatter: parseFrontmatter(content),
  };
}
