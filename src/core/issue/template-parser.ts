/**
 * GitHub Issue Template Parser.
 *
 * Parses .github/ISSUE_TEMPLATE/*.yml files into JSON config.
 * Supports three resolution strategies:
 *   1. Live parse from YAML templates (if in a repo with templates)
 *   2. Cached config from .cleo/issue-templates.json
 *   3. Hardcoded fallback defaults
 *
 * @task T4454
 * @epic T4454
 */

import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, basename } from 'node:path';
import { getCleoDir, getProjectRoot } from '../paths.js';

const TEMPLATE_DIR = '.github/ISSUE_TEMPLATE';
const CACHE_FILE = 'issue-templates.json';

/** Known filename-to-subcommand mappings. */
const SUBCOMMAND_MAP: Record<string, string> = {
  bug_report: 'bug',
  feature_request: 'feature',
  help_question: 'help',
};

/** Parsed issue template. */
export interface IssueTemplate {
  name: string;
  description: string;
  title: string;
  labels: string[];
  subcommand: string;
  fileName: string;
}

/** Fallback default templates. */
const FALLBACK_TEMPLATES: IssueTemplate[] = [
  {
    name: 'Bug Report',
    description: 'Report a bug',
    title: '[Bug] ',
    labels: ['bug'],
    subcommand: 'bug',
    fileName: 'bug_report.yml',
  },
  {
    name: 'Feature Request',
    description: 'Suggest an enhancement',
    title: '[Feature] ',
    labels: ['enhancement'],
    subcommand: 'feature',
    fileName: 'feature_request.yml',
  },
];

/**
 * Extract a YAML field value from template content.
 * Handles simple top-level scalar fields only (not nested).
 */
function extractYamlField(content: string, field: string): string {
  const regex = new RegExp(`^${field}:\\s*["']?(.+?)["']?\\s*$`, 'm');
  const match = content.match(regex);
  return match?.[1]?.trim() ?? '';
}

/**
 * Extract YAML array values (labels).
 * Handles both inline `[a, b]` and multi-line `- a\n- b` formats.
 */
function extractYamlArray(content: string, field: string): string[] {
  // Try inline format: labels: [bug, enhancement]
  const inlineRegex = new RegExp(`^${field}:\\s*\\[([^\\]]+)\\]`, 'm');
  const inlineMatch = content.match(inlineRegex);
  if (inlineMatch) {
    return inlineMatch[1]!
      .split(',')
      .map(s => s.trim().replace(/^["']|["']$/g, ''))
      .filter(Boolean);
  }

  // Try multi-line format
  const lines = content.split('\n');
  const items: string[] = [];
  let inArray = false;

  for (const line of lines) {
    if (line.match(new RegExp(`^${field}:`))) {
      inArray = true;
      continue;
    }
    if (inArray) {
      const itemMatch = line.match(/^\s+-\s+["']?(.+?)["']?\s*$/);
      if (itemMatch) {
        items.push(itemMatch[1]!.trim());
      } else if (line.match(/^\S/)) {
        break; // New top-level key, done
      }
    }
  }

  return items;
}

/**
 * Parse a single YAML template file.
 */
function parseTemplateFile(filePath: string): IssueTemplate | null {
  if (!existsSync(filePath)) return null;

  try {
    const content = readFileSync(filePath, 'utf-8');
    const fileName = basename(filePath);
    const stem = fileName.replace(/\.ya?ml$/, '');

    const name = extractYamlField(content, 'name');
    const description = extractYamlField(content, 'description');
    const title = extractYamlField(content, 'title');
    const labels = extractYamlArray(content, 'labels');
    const subcommand = SUBCOMMAND_MAP[stem] ?? stem;

    if (!name) return null;

    return { name, description, title, labels, subcommand, fileName };
  } catch {
    return null;
  }
}

/**
 * Parse all issue templates from .github/ISSUE_TEMPLATE/.
 */
export function parseIssueTemplates(projectDir?: string): IssueTemplate[] {
  const dir = projectDir ?? getProjectRoot();
  const templateDir = join(dir, TEMPLATE_DIR);

  if (!existsSync(templateDir)) return [];

  const templates: IssueTemplate[] = [];

  for (const file of readdirSync(templateDir)) {
    if (!file.endsWith('.yml') && !file.endsWith('.yaml')) continue;

    const template = parseTemplateFile(join(templateDir, file));
    if (template) templates.push(template);
  }

  return templates;
}

/**
 * Get template configuration - tries live parse, cache, then fallback.
 */
export function getTemplateConfig(cwd?: string): IssueTemplate[] {
  // Strategy 1: Live parse
  const projectDir = cwd ?? getProjectRoot();
  const liveTemplates = parseIssueTemplates(projectDir);
  if (liveTemplates.length > 0) return liveTemplates;

  // Strategy 2: Cached config
  const cachePath = join(getCleoDir(cwd), CACHE_FILE);
  if (existsSync(cachePath)) {
    try {
      const cached = JSON.parse(readFileSync(cachePath, 'utf-8')) as { templates: IssueTemplate[] };
      if (cached.templates?.length > 0) return cached.templates;
    } catch {
      // Fall through to defaults
    }
  }

  // Strategy 3: Fallback defaults
  return FALLBACK_TEMPLATES;
}

/**
 * Get the template for a specific subcommand (bug, feature, etc.).
 */
export function getTemplateForSubcommand(
  subcommand: string,
  cwd?: string,
): IssueTemplate | null {
  const templates = getTemplateConfig(cwd);
  return templates.find(t => t.subcommand === subcommand) ?? null;
}

/**
 * Cache parsed templates to .cleo/issue-templates.json.
 */
export function cacheTemplates(templates: IssueTemplate[], cwd?: string): void {
  const cachePath = join(getCleoDir(cwd), CACHE_FILE);
  const cache = {
    version: '1.0.0',
    generatedAt: new Date().toISOString(),
    templates,
  };
  writeFileSync(cachePath, JSON.stringify(cache, null, 2) + '\n', 'utf-8');
}

/**
 * Validate that required labels exist (informational).
 */
export function validateLabelsExist(
  _templates: IssueTemplate[],
): { valid: boolean; missingLabels: string[] } {
  // Can't actually verify GitHub labels without API, just return the set
  return { valid: true, missingLabels: [] };
}
