/**
 * CANT file resolver for @import directives in instruction files.
 *
 * Scans content for `@import *.cant` lines, parses the referenced
 * .cant files, and converts their definitions to markdown for
 * injection into provider instruction files.
 *
 * This bridges the CANT DSL with the existing CAAMP marker-based
 * injection system, allowing .cant files to be referenced from
 * AGENTS.md alongside traditional markdown content.
 */

import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';

/**
 * Result of resolving `@import` lines in content.
 */
export interface ResolvedImports {
  /** Content with `@import` lines replaced by their resolved markdown. */
  resolvedContent: string;
  /** Absolute paths of successfully resolved .cant files. */
  importedFiles: string[];
  /** Error messages for failed resolutions. */
  errors: string[];
}

/**
 * Pattern matching @import lines that reference .cant files.
 *
 * Matches:
 * - `@import .cleo/agents/core-agent.cant`
 * - `@import "./relative/path.cant"`
 * - `@import .cleo/workflows/deploy.cant as deploy`
 */
const CANT_IMPORT_PATTERN = /^@import\s+["']?([^"'\s]+\.cant)["']?(?:\s+as\s+(\w+))?$/;

/**
 * Resolve `@import *.cant` references in instruction file content.
 *
 * @remarks
 * Scans each line for `@import` directives pointing to `.cant` files.
 * For each match, reads and parses the `.cant` file, converts its
 * definitions to markdown, and replaces the `@import` line with
 * the generated content.
 *
 * Lines that don't match the `.cant` import pattern are left unchanged.
 *
 * @param content - Raw instruction file content
 * @param projectRoot - Absolute path to the project root directory
 * @returns Resolved content, imported file list, and any errors
 *
 * @example
 * ```typescript
 * const result = resolveCantImports(
 *   '@import .cleo/agents/core-agent.cant',
 *   '/home/user/project',
 * );
 * console.log(result.resolvedContent);
 * // ## Agent: core-agent
 * // - **Model**: opus
 * // ...
 * ```
 *
 * @public
 */
export function resolveCantImports(content: string, projectRoot: string): ResolvedImports {
  const lines = content.split('\n');
  const resolvedLines: string[] = [];
  const importedFiles: string[] = [];
  const errors: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    const match = trimmed.match(CANT_IMPORT_PATTERN);

    if (!match) {
      resolvedLines.push(line);
      continue;
    }

    const importPath = match[1] ?? '';
    const absolutePath = resolveImportPath(importPath, projectRoot);

    if (!absolutePath) {
      errors.push(`Cannot resolve import path: ${importPath}`);
      resolvedLines.push(`<!-- CANT import error: cannot resolve ${importPath} -->`);
      continue;
    }

    if (!existsSync(absolutePath)) {
      errors.push(`File not found: ${absolutePath} (from @import ${importPath})`);
      resolvedLines.push(`<!-- CANT import error: file not found ${importPath} -->`);
      continue;
    }

    try {
      const cantContent = readFileSync(absolutePath, 'utf-8');
      const markdown = cantToMarkdown(cantContent);
      resolvedLines.push(markdown);
      importedFiles.push(absolutePath);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      errors.push(`Failed to parse ${importPath}: ${message}`);
      resolvedLines.push(`<!-- CANT import error: parse failure for ${importPath} -->`);
    }
  }

  return {
    resolvedContent: resolvedLines.join('\n'),
    importedFiles,
    errors,
  };
}

/**
 * Convert a `.cant` file's content to markdown equivalent.
 *
 * @remarks
 * Parses the frontmatter to determine the document kind,
 * then converts the body into structured markdown that
 * providers can consume (headings, bullet lists, code blocks).
 *
 * @param cantContent - Raw `.cant` file content
 * @returns Markdown representation of the `.cant` definitions
 *
 * @example
 * ```typescript
 * const md = cantToMarkdown(`---
 * kind: agent
 * version: 1
 * ---
 *
 * agent ops-lead:
 *   model: opus
 *   prompt: "Coordinate operations"
 * `);
 * // Returns markdown with ## Agent: ops-lead heading
 * ```
 *
 * @public
 */
export function cantToMarkdown(cantContent: string): string {
  const { kind, body } = parseFrontmatter(cantContent);

  switch (kind) {
    case 'agent':
      return agentToMarkdown(body);
    case 'skill':
      return skillToMarkdown(body);
    case 'hook':
      return hookToMarkdown(body);
    case 'workflow':
      return workflowToMarkdown(body);
    case 'pipeline':
      return pipelineToMarkdown(body);
    default:
      return `<!-- CANT: unknown kind "${kind}" -->\n\`\`\`cant\n${body}\n\`\`\``;
  }
}

/**
 * Resolve an import path relative to the project root.
 *
 * Handles:
 * - Relative paths: resolved against projectRoot
 * - Absolute paths: used as-is (but validated within project root)
 * - Bare paths: resolved to .cleo/agents/ or .cleo/skills/
 */
function resolveImportPath(importPath: string, projectRoot: string): string | null {
  if (!importPath) return null;

  // Security: prevent path traversal outside project root
  const resolved = isAbsolute(importPath) ? importPath : resolve(projectRoot, importPath);

  const normalizedResolved = resolve(resolved);
  const normalizedRoot = resolve(projectRoot);

  if (!normalizedResolved.startsWith(normalizedRoot)) {
    return null; // Path traversal attempt
  }

  return normalizedResolved;
}

/**
 * Parse frontmatter from a .cant file.
 *
 * Extracts the `kind:` value and separates the body content.
 */
function parseFrontmatter(content: string): { kind: string; body: string } {
  const fmMatch = content.match(/^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/);

  if (!fmMatch) {
    return { kind: 'unknown', body: content };
  }

  const frontmatter = fmMatch[1] ?? '';
  const body = (fmMatch[2] ?? '').trim();

  const kindMatch = frontmatter.match(/^kind:\s*(\w+)/m);
  const kind = kindMatch ? (kindMatch[1] ?? 'unknown') : 'unknown';

  return { kind, body };
}

/**
 * Convert a CANT agent body to markdown.
 */
function agentToMarkdown(body: string): string {
  const lines: string[] = [];
  const agentMatch = body.match(/^agent\s+([\w-]+):/m);
  const agentName = agentMatch ? (agentMatch[1] ?? 'unknown') : 'unknown';

  lines.push(`## Agent: ${agentName}`);
  lines.push('');

  // Extract properties
  const propertyLines = extractIndentedBlock(body, /^agent\s+[\w-]+:/m);
  let inPermissions = false;

  for (const propLine of propertyLines) {
    const trimmed = propLine.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    if (trimmed === 'permissions:') {
      inPermissions = true;
      lines.push('');
      lines.push('**Permissions**:');
      continue;
    }

    if (inPermissions) {
      // Permission line: "tasks: read, write"
      const permMatch = trimmed.match(/^([\w-]+):\s*(.+)$/);
      if (permMatch) {
        lines.push(`- ${capitalize(permMatch[1] ?? '')}: ${permMatch[2] ?? ''}`);
        continue;
      }
      // End of permissions block (non-indented or different construct)
      inPermissions = false;
    }

    // Regular property: "key: value"
    const propMatch = trimmed.match(/^([\w-]+):\s*(.+)$/);
    if (propMatch) {
      const key = propMatch[1] ?? '';
      const value = unquote(propMatch[2] ?? '');
      lines.push(`- **${capitalize(key)}**: ${formatMarkdownValue(value)}`);
    }
  }

  return lines.join('\n');
}

/**
 * Convert a CANT skill body to markdown.
 */
function skillToMarkdown(body: string): string {
  const lines: string[] = [];
  const skillMatch = body.match(/^skill\s+([\w-]+)/m);
  const skillName = skillMatch ? (skillMatch[1] ?? 'unknown') : 'unknown';

  lines.push(`## Skill: ${skillName}`);
  lines.push('');

  const propertyLines = extractIndentedBlock(body, /^skill\s+[\w-]+/m);
  for (const propLine of propertyLines) {
    const trimmed = propLine.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const propMatch = trimmed.match(/^([\w-]+):\s*(.+)$/);
    if (propMatch) {
      const key = propMatch[1] ?? '';
      const value = unquote(propMatch[2] ?? '');
      lines.push(`- **${capitalize(key)}**: ${formatMarkdownValue(value)}`);
    }
  }

  return lines.join('\n');
}

/**
 * Convert a CANT hook body to markdown.
 */
function hookToMarkdown(body: string): string {
  const lines: string[] = [];
  const hookMatch = body.match(/^on\s+(\w+):/m);
  const eventName = hookMatch ? (hookMatch[1] ?? 'unknown') : 'unknown';

  lines.push(`### On ${camelToSpaces(eventName)}`);
  lines.push('');

  const bodyLines = extractIndentedBlock(body, /^on\s+\w+:/m);
  let stepNum = 1;

  for (const bodyLine of bodyLines) {
    const trimmed = bodyLine.trim();
    if (!trimmed) continue;

    if (trimmed.startsWith('#')) {
      // Comment -> plain text
      lines.push(trimmed.replace(/^#\s*/, ''));
      continue;
    }

    if (trimmed.startsWith('/')) {
      // Directive -> numbered step
      lines.push(`${stepNum}. \`${trimmed}\``);
      stepNum++;
      continue;
    }

    lines.push(`${stepNum}. ${trimmed}`);
    stepNum++;
  }

  return lines.join('\n');
}

/**
 * Convert a CANT workflow body to markdown.
 */
function workflowToMarkdown(body: string): string {
  const lines: string[] = [];
  const wfMatch = body.match(/^workflow\s+([\w-]+)/m);
  const wfName = wfMatch ? (wfMatch[1] ?? 'unknown') : 'unknown';

  lines.push(`## Workflow: ${wfName}`);
  lines.push('');
  lines.push('```cant');
  lines.push(body);
  lines.push('```');

  return lines.join('\n');
}

/**
 * Convert a CANT pipeline body to markdown.
 */
function pipelineToMarkdown(body: string): string {
  const lines: string[] = [];
  const plMatch = body.match(/^pipeline\s+([\w-]+)/m);
  const plName = plMatch ? (plMatch[1] ?? 'unknown') : 'unknown';

  lines.push(`## Pipeline: ${plName}`);
  lines.push('');
  lines.push('```cant');
  lines.push(body);
  lines.push('```');

  return lines.join('\n');
}

/**
 * Extract indented lines following a block header.
 */
function extractIndentedBlock(body: string, headerPattern: RegExp): string[] {
  const lines = body.split('\n');
  const result: string[] = [];
  let found = false;

  for (const line of lines) {
    if (!found) {
      if (headerPattern.test(line)) {
        found = true;
      }
      continue;
    }

    // Indented line or blank line within block
    if (/^\s+/.test(line) || line.trim() === '') {
      result.push(line);
    } else {
      // Non-indented non-blank line -> block ended
      break;
    }
  }

  return result;
}

/**
 * Remove surrounding quotes from a string value.
 */
function unquote(value: string): string {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

/**
 * Format a value for markdown output.
 *
 * Arrays become comma-separated lists, strings are used as-is.
 */
function formatMarkdownValue(value: string): string {
  // Array notation: ["a", "b"] -> a, b
  if (value.startsWith('[') && value.endsWith(']')) {
    return value.slice(1, -1).replace(/"/g, '').replace(/'/g, '');
  }
  return value;
}

/**
 * Capitalize the first letter of a string.
 */
function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * Convert PascalCase to spaced words.
 *
 * "SessionStart" -> "Session Start"
 */
function camelToSpaces(s: string): string {
  return s.replace(/([a-z])([A-Z])/g, '$1 $2');
}
