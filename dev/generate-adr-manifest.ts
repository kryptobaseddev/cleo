/**
 * ADR Manifest Generator
 *
 * Reads all .cleo/adrs/*.md files (including archive/) and generates
 * .cleo/adrs/MANIFEST.jsonl with one JSON entry per ADR.
 *
 * Usage: npm run adr:manifest
 *
 * @see ADR-017 §5.1 for frontmatter spec
 */

import { readFileSync, readdirSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, '..');
const ADRS_DIR = join(PROJECT_ROOT, '.cleo', 'adrs');
const MANIFEST_PATH = join(ADRS_DIR, 'MANIFEST.jsonl');

interface AdrManifestEntry {
  id: string;
  file: string;
  title: string;
  status: string;
  date: string;
  accepted?: string;
  supersedes?: string;
  supersededBy?: string;
  amends?: string;
  amendedBy?: string;
  relatedTasks?: string[];
  gate?: string;
  gateStatus?: string;
  // ADR-017 §5.4 cognitive search fields (T4942)
  summary?: string;
  keywords?: string[];
  topics?: string[];
}

/** Extract ADR ID from filename */
function extractAdrId(filename: string): string {
  const match = filename.match(/^(ADR-\d+)/);
  return match ? match[1]! : filename.replace('.md', '');
}

/** Parse **Key**: value frontmatter */
function parseFrontmatter(content: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of content.split('\n')) {
    if (line.trim() === '---') break;
    const match = line.match(/^\*\*([^*]+)\*\*:\s*(.+)$/);
    if (match) result[match[1]!.trim()] = match[2]!.trim();
  }
  return result;
}

/** Extract H1 title */
function extractTitle(content: string): string {
  const match = content.match(/^#\s+(.+)$/m);
  return match ? match[1]!.trim() : 'Untitled';
}

/** Recursively find all ADR .md files */
function findAdrFiles(dir: string, prefix: string = ''): Array<{ filename: string; relPath: string }> {
  const results: Array<{ filename: string; relPath: string }> = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      results.push(...findAdrFiles(join(dir, entry.name), `${prefix}${entry.name}/`));
    } else if (entry.name.endsWith('.md') && entry.name.match(/^ADR-\d+/)) {
      results.push({ filename: entry.name, relPath: `${prefix}${entry.name}` });
    }
  }
  return results;
}

function main(): void {
  if (!existsSync(ADRS_DIR)) {
    console.error(`ERROR: ADR directory not found: ${ADRS_DIR}`);
    process.exit(1);
  }

  const files = findAdrFiles(ADRS_DIR).sort((a, b) => a.filename.localeCompare(b.filename));
  console.log(`Processing ${files.length} ADR files...\n`);

  const entries: AdrManifestEntry[] = [];

  for (const { filename, relPath } of files) {
    const filePath = join(ADRS_DIR, relPath);
    const content = readFileSync(filePath, 'utf-8');
    const fm = parseFrontmatter(content);
    const title = extractTitle(content);
    const id = extractAdrId(filename);

    const entry: AdrManifestEntry = {
      id,
      file: `.cleo/adrs/${relPath}`,
      title,
      status: fm['Status'] ?? 'unknown',
      date: fm['Date'] ?? '',
    };

    if (fm['Accepted']) entry.accepted = fm['Accepted'];
    if (fm['Supersedes']) entry.supersedes = fm['Supersedes'];
    if (fm['Superseded By']) entry.supersededBy = fm['Superseded By'];
    if (fm['Amends']) entry.amends = fm['Amends'];
    if (fm['Amended By']) entry.amendedBy = fm['Amended By'];
    if (fm['Related Tasks']) {
      entry.relatedTasks = fm['Related Tasks'].split(',').map(s => s.trim()).filter(Boolean);
    }
    if (fm['Gate']) entry.gate = fm['Gate'];
    if (fm['Gate Status']) entry.gateStatus = fm['Gate Status'];
    if (fm['Summary']) entry.summary = fm['Summary'];
    if (fm['Keywords']) entry.keywords = fm['Keywords'].split(',').map(s => s.trim()).filter(Boolean);
    if (fm['Topics']) entry.topics = fm['Topics'].split(',').map(s => s.trim()).filter(Boolean);

    entries.push(entry);
    console.log(`  ${id}: ${title} [${entry.status}]`);
  }

  // Write MANIFEST.jsonl
  const jsonl = entries.map(e => JSON.stringify(e)).join('\n') + '\n';
  writeFileSync(MANIFEST_PATH, jsonl, 'utf-8');

  console.log(`\nManifest written: .cleo/adrs/MANIFEST.jsonl (${entries.length} entries)`);
}

main();
