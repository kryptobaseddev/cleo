/**
 * Section-aware CHANGELOG writer with custom-log block support.
 *
 * @task T5579
 * @epic T5576
 */

import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { atomicWrite } from '../../store/atomic.js';

// ── Custom-log block parsing ──────────────────────────────────────────

/**
 * Parse [custom-log]...[/custom-log] blocks from a CHANGELOG section.
 * Returns the extracted block content (tags stripped) and the content
 * with tags+content removed.
 */
export function parseChangelogBlocks(content: string): {
  customBlocks: string[];
  strippedContent: string;
} {
  const customBlocks: string[] = [];
  const blockRe = /\[custom-log\]([\s\S]*?)\[\/custom-log\]/gi;

  for (const match of content.matchAll(blockRe)) {
    const inner = match[1].trim();
    if (inner.length > 0) {
      customBlocks.push(inner);
    }
  }

  const strippedContent = content.replace(/\[custom-log\][\s\S]*?\[\/custom-log\]/gi, '');

  return { customBlocks, strippedContent };
}

// ── Section helpers ───────────────────────────────────────────────────

/**
 * Build the full section text for a given version.
 */
function buildSection(version: string, generatedContent: string, customBlocks: string[]): string {
  const date = new Date().toISOString().split('T')[0];
  const lines: string[] = [];

  lines.push(`## [${version}] (${date})`);
  lines.push('');
  lines.push(generatedContent.trimEnd());

  if (customBlocks.length > 0) {
    lines.push('');
    for (const block of customBlocks) {
      lines.push(block);
      lines.push('');
    }
  }

  lines.push('---');
  lines.push('');

  return lines.join('\n');
}

/**
 * Write or update a CHANGELOG.md section for a specific version.
 *
 * - If ## [VERSION] section exists: replaces it in-place.
 * - If not: prepends as new section after any top-level # heading.
 * - Custom block content (from [custom-log] blocks) is appended after
 *   generated content.
 * - Section header format: '## [VERSION] (YYYY-MM-DD)'
 */
export async function writeChangelogSection(
  version: string,
  generatedContent: string,
  customBlocks: string[],
  changelogPath: string,
): Promise<void> {
  let existing = '';
  if (existsSync(changelogPath)) {
    existing = await readFile(changelogPath, 'utf8');
  }

  // Extract any custom blocks already stored in the existing section
  const existingSection = extractExistingSection(existing, version);
  const { customBlocks: existingCustomBlocks } = parseChangelogBlocks(existingSection);

  // Merge: passed-in blocks first, then any unique blocks from file
  const mergedBlocks = [...customBlocks];
  for (const block of existingCustomBlocks) {
    if (!mergedBlocks.includes(block)) {
      mergedBlocks.push(block);
    }
  }

  const newSection = buildSection(version, generatedContent, mergedBlocks);
  const updated = replaceOrInsertSection(existing, version, newSection);
  await atomicWrite(changelogPath, updated);
}

// ── Internal helpers ──────────────────────────────────────────────────

/**
 * Extract the existing section text for a version (empty string if none).
 */
function extractExistingSection(changelog: string, version: string): string {
  const escapedVersion = escapeRegex(version);
  const sectionStart = new RegExp(`^## \\[?${escapedVersion}\\]?`, 'm');
  const startMatch = sectionStart.exec(changelog);
  if (!startMatch) return '';

  const fromStart = changelog.slice(startMatch.index);
  const afterFirstLine = fromStart.indexOf('\n') + 1;
  const nextSection = /^## /m.exec(fromStart.slice(afterFirstLine));
  if (nextSection) {
    return fromStart.slice(0, afterFirstLine + nextSection.index);
  }
  return fromStart;
}

/**
 * Replace an existing section for version, or insert after the title heading.
 */
function replaceOrInsertSection(changelog: string, version: string, newSection: string): string {
  const escapedVersion = escapeRegex(version);
  const sectionStart = new RegExp(`^## \\[?${escapedVersion}\\]?`, 'm');
  const startMatch = sectionStart.exec(changelog);

  if (startMatch) {
    const before = changelog.slice(0, startMatch.index);
    const fromStart = changelog.slice(startMatch.index);
    const afterFirstLine = fromStart.indexOf('\n') + 1;
    const nextSection = /^## /m.exec(fromStart.slice(afterFirstLine));

    if (nextSection) {
      const after = fromStart.slice(afterFirstLine + nextSection.index);
      return before + newSection + after;
    }
    return before + newSection;
  }

  // Insert after top-level # heading if present
  const titleMatch = /^# .+$/m.exec(changelog);
  if (titleMatch) {
    const insertAt = titleMatch.index + titleMatch[0].length;
    const rest = changelog.slice(insertAt);
    const trimmedRest = rest.startsWith('\n') ? rest.slice(1) : rest;
    return changelog.slice(0, insertAt) + '\n\n' + newSection + trimmedRest;
  }

  // No existing content — prepend
  return newSection + changelog;
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
