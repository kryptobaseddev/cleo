/**
 * YAML frontmatter parser/writer for RCASD provenance files.
 *
 * Provides Obsidian-like backlinks via YAML frontmatter blocks
 * (delimited by `---`). No YAML library dependency — uses
 * simple key-value parsing for the supported fields.
 *
 * @task T5200
 * @epic T4798
 */

import { join, relative } from 'node:path';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { getRcasdBaseDir } from './rcasd-paths.js';

// =============================================================================
// TYPES
// =============================================================================

/** Related link in frontmatter. */
export interface RelatedLink {
  type: 'consensus' | 'adr' | 'task' | 'research' | 'spec' | 'contribution' | 'file';
  path?: string;
  id?: string;
}

/** Frontmatter metadata for an RCASD artifact. */
export interface FrontmatterMetadata {
  epic: string;
  stage: string;
  task?: string;
  related?: RelatedLink[];
  created?: string;
  updated?: string;
  [key: string]: unknown;
}

/** Result of parsing frontmatter from a markdown file. */
export interface ParsedFrontmatter {
  frontmatter: FrontmatterMetadata | null;
  body: string;
  raw: string;
}

// =============================================================================
// PARSING
// =============================================================================

const FRONTMATTER_RE = /^---\n([\s\S]*?)\n---\n?/;

/**
 * Parse a simple YAML value string into a typed value.
 * Handles quoted strings, booleans, null, and bare strings.
 */
function parseScalar(value: string): string | boolean | null {
  const trimmed = value.trim();

  // Quoted strings — strip quotes
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }

  // Booleans
  if (trimmed === 'true') return true;
  if (trimmed === 'false') return false;

  // Null
  if (trimmed === 'null' || trimmed === '~') return null;

  return trimmed;
}

/**
 * Parse YAML frontmatter content (the text between `---` delimiters)
 * into a FrontmatterMetadata object.
 *
 * Supports:
 * - Top-level scalar fields: `key: value`
 * - Top-level array of objects: `related:` followed by `  - type: X\n    path: Y`
 */
function parseYamlContent(yaml: string): FrontmatterMetadata {
  const result: Record<string, unknown> = {};
  const lines = yaml.split('\n');

  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;

    // Skip blank lines
    if (line.trim() === '') {
      i++;
      continue;
    }

    // Top-level key: value
    const kvMatch = line.match(/^(\w[\w-]*)\s*:\s*(.*)/);
    if (!kvMatch) {
      i++;
      continue;
    }

    const key = kvMatch[1]!;
    const inlineValue = kvMatch[2]!.trim();

    // If value is present inline, it's a scalar
    if (inlineValue !== '') {
      const parsed = parseScalar(inlineValue);
      result[key] = parsed === null ? undefined : parsed;
      i++;
      continue;
    }

    // Value is empty — check for array items on subsequent lines
    const items: Record<string, unknown>[] = [];
    i++;

    while (i < lines.length) {
      const nextLine = lines[i]!;

      // Blank line within array block — skip
      if (nextLine.trim() === '') {
        i++;
        continue;
      }

      // Array item start: `  - key: value`
      const itemMatch = nextLine.match(/^\s+-\s+(\w[\w-]*)\s*:\s*(.*)/);
      if (!itemMatch) {
        // Not an array item — we've exited the array block
        break;
      }

      const itemObj: Record<string, unknown> = {};
      const firstKey = itemMatch[1]!;
      const firstValue = parseScalar(itemMatch[2]!);
      itemObj[firstKey] = firstValue === null ? undefined : firstValue;
      i++;

      // Read continuation lines for this array item (indented key: value, no `-`)
      while (i < lines.length) {
        const contLine = lines[i]!;
        // Must be indented but NOT start a new array item
        const contMatch = contLine.match(/^\s{4,}(\w[\w-]*)\s*:\s*(.*)/);
        if (!contMatch) break;

        const contKey = contMatch[1]!;
        const contValue = parseScalar(contMatch[2]!);
        itemObj[contKey] = contValue === null ? undefined : contValue;
        i++;
      }

      items.push(itemObj);
    }

    if (items.length > 0) {
      result[key] = items;
    }
  }

  return result as FrontmatterMetadata;
}

/**
 * Parse YAML frontmatter from a markdown string.
 *
 * Finds the YAML block delimited by `---` at the start of the file,
 * parses key-value pairs, and returns the structured metadata plus
 * the remaining body content.
 *
 * @param content - Full markdown file content
 * @returns Parsed frontmatter, body, and raw YAML block
 */
export function parseFrontmatter(content: string): ParsedFrontmatter {
  const match = content.match(FRONTMATTER_RE);

  if (!match) {
    return {
      frontmatter: null,
      body: content,
      raw: '',
    };
  }

  const raw = match[0]!;
  const yamlContent = match[1]!;
  const body = content.slice(raw.length);

  return {
    frontmatter: parseYamlContent(yamlContent),
    body,
    raw,
  };
}

// =============================================================================
// SERIALIZATION
// =============================================================================

/**
 * Serialize a scalar value for YAML output.
 * Wraps strings containing special characters in quotes.
 */
function serializeScalar(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'boolean') return String(value);
  const str = String(value);
  // Quote strings that contain YAML-special characters
  if (str.includes(':') || str.includes('#') || str.includes('{') || str.includes('}')) {
    return `"${str.replace(/"/g, '\\"')}"`;
  }
  return str;
}

/**
 * Convert a FrontmatterMetadata object to a YAML frontmatter string.
 *
 * Output format:
 * ```
 * ---
 * epic: T4881
 * stage: research
 * related:
 *   - type: consensus
 *     path: ../consensus/consensus-report.md
 * created: 2026-02-15
 * ---
 * ```
 *
 * @param metadata - The frontmatter metadata to serialize
 * @returns YAML frontmatter string including `---` delimiters
 */
export function serializeFrontmatter(metadata: FrontmatterMetadata): string {
  const lines: string[] = ['---'];

  // Ordered keys: epic, stage, task first, then related, then dates, then rest
  const orderedKeys = ['epic', 'stage', 'task'];
  const dateKeys = ['created', 'updated'];
  const processedKeys = new Set<string>();

  // Write ordered keys first
  for (const key of orderedKeys) {
    if (key in metadata && metadata[key] !== undefined) {
      lines.push(`${key}: ${serializeScalar(metadata[key])}`);
      processedKeys.add(key);
    }
  }

  // Write related array
  if (metadata.related && metadata.related.length > 0) {
    lines.push('related:');
    for (const link of metadata.related) {
      const entries = Object.entries(link).filter(([_, v]) => v !== undefined);
      if (entries.length === 0) continue;

      const [firstKey, firstValue] = entries[0]!;
      lines.push(`  - ${firstKey}: ${serializeScalar(firstValue)}`);
      for (let i = 1; i < entries.length; i++) {
        const [k, v] = entries[i]!;
        lines.push(`    ${k}: ${serializeScalar(v)}`);
      }
    }
    processedKeys.add('related');
  }

  // Write date keys
  for (const key of dateKeys) {
    if (key in metadata && metadata[key] !== undefined) {
      lines.push(`${key}: ${serializeScalar(metadata[key])}`);
      processedKeys.add(key);
    }
  }

  // Write remaining keys
  for (const [key, value] of Object.entries(metadata)) {
    if (processedKeys.has(key)) continue;
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      // Generic array serialization
      lines.push(`${key}:`);
      for (const item of value) {
        if (typeof item === 'object' && item !== null) {
          const entries = Object.entries(item as Record<string, unknown>).filter(
            ([_, v]) => v !== undefined,
          );
          if (entries.length === 0) continue;
          const [firstKey, firstValue] = entries[0]!;
          lines.push(`  - ${firstKey}: ${serializeScalar(firstValue)}`);
          for (let j = 1; j < entries.length; j++) {
            const [k, v] = entries[j]!;
            lines.push(`    ${k}: ${serializeScalar(v)}`);
          }
        } else {
          lines.push(`  - ${serializeScalar(item)}`);
        }
      }
    } else {
      lines.push(`${key}: ${serializeScalar(value)}`);
    }
  }

  lines.push('---');
  return lines.join('\n') + '\n';
}

// =============================================================================
// CONTENT MANIPULATION
// =============================================================================

/**
 * Add or replace YAML frontmatter in markdown content.
 *
 * If the content already has a frontmatter block, it is replaced.
 * Otherwise the YAML block is prepended.
 *
 * @param content - Original markdown content
 * @param metadata - Frontmatter metadata to set
 * @returns Updated content with new frontmatter
 */
export function addFrontmatter(content: string, metadata: FrontmatterMetadata): string {
  const parsed = parseFrontmatter(content);
  const serialized = serializeFrontmatter(metadata);

  if (parsed.frontmatter !== null) {
    // Replace existing frontmatter
    return serialized + parsed.body;
  }

  // Prepend new frontmatter
  return serialized + content;
}

// =============================================================================
// BUILDERS
// =============================================================================

/**
 * Convenience builder for common frontmatter patterns.
 *
 * Auto-sets `updated` to the current ISO date string.
 *
 * @param epicId - Epic identifier (e.g. `T4881`)
 * @param stage - RCASD stage name (e.g. `research`)
 * @param options - Optional fields: task, related links, created date
 * @returns A FrontmatterMetadata object ready for serialization
 */
export function buildFrontmatter(
  epicId: string,
  stage: string,
  options?: {
    task?: string;
    related?: RelatedLink[];
    created?: string;
  },
): FrontmatterMetadata {
  const now = new Date().toISOString().split('T')[0]!;

  const metadata: FrontmatterMetadata = {
    epic: epicId,
    stage,
  };

  if (options?.task) {
    metadata.task = options.task;
  }

  if (options?.related && options.related.length > 0) {
    metadata.related = options.related;
  }

  metadata.created = options?.created ?? now;
  metadata.updated = now;

  return metadata;
}

// =============================================================================
// BACKLINKS
// =============================================================================

/**
 * Scan all markdown files in `.cleo/rcasd/` for files that reference
 * the given epic+stage combination via their `related` frontmatter links.
 *
 * This enables "what links here?" queries (Obsidian-style backlinks).
 *
 * @param epicId - Epic identifier to search for
 * @param stage - Stage name to search for
 * @param cwd - Optional working directory override
 * @returns Array of files with matching related links
 */
export function getBacklinks(
  epicId: string,
  stage: string,
  cwd?: string,
): Array<{ file: string; link: RelatedLink }> {
  const baseDir = getRcasdBaseDir(cwd);
  if (!existsSync(baseDir)) return [];

  const results: Array<{ file: string; link: RelatedLink }> = [];
  const targetPattern = `${epicId}/${stage}`;

  scanDirectory(baseDir, baseDir, targetPattern, epicId, stage, results);

  return results;
}

/**
 * Recursively scan a directory for markdown files with matching backlinks.
 */
function scanDirectory(
  dir: string,
  baseDir: string,
  targetPattern: string,
  epicId: string,
  stage: string,
  results: Array<{ file: string; link: RelatedLink }>,
): void {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    const fullPath = join(dir, entry.name);

    if (entry.isDirectory()) {
      scanDirectory(fullPath, baseDir, targetPattern, epicId, stage, results);
      continue;
    }

    if (!entry.name.endsWith('.md')) continue;

    let content;
    try {
      content = readFileSync(fullPath, 'utf-8');
    } catch {
      continue;
    }

    const parsed = parseFrontmatter(content);
    if (!parsed.frontmatter?.related) continue;

    for (const link of parsed.frontmatter.related) {
      const matchesPath = link.path && link.path.includes(targetPattern);
      const matchesId = link.id === epicId && link.type === stage;
      const matchesEpicStage =
        parsed.frontmatter.epic === epicId && link.type === stage;

      if (matchesPath || matchesId || matchesEpicStage) {
        const relPath = relative(baseDir, fullPath);
        results.push({ file: relPath, link });
      }
    }
  }
}
