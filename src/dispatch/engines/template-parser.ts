/**
 * Template Parser Engine
 *
 * Native TypeScript implementation for parsing GitHub issue template YAML files
 * and producing structured JSON config. Both the MCP server and the Bash CLI
 * can consume the generated config at .cleo/issue-templates.json.
 *
 * Supports: parseIssueTemplates, getTemplateForSubcommand, generateTemplateConfig, validateLabels
 *
 * @task T4492
 */

import { readFileSync, readdirSync, existsSync } from 'fs';
import { join} from 'path';
import { parse as parseYaml } from 'yaml';
import { writeJsonFileAtomic, getDataPath } from '../../core/platform.js';
import { engineError, type EngineResult } from './_error.js';

/**
 * A single section/field within an issue template
 */
export interface TemplateSection {
  id: string;
  type: 'textarea' | 'dropdown' | 'input' | 'markdown' | 'checkboxes';
  label: string;
  required: boolean;
  options?: string[];  // For dropdown type
  placeholder?: string;
}

/**
 * A parsed issue template
 */
export interface IssueTemplate {
  filename: string;        // e.g., "bug_report.yml"
  subcommand: string;      // e.g., "bug" (derived from filename)
  name: string;            // e.g., "Bug Report"
  titlePrefix: string;     // e.g., "[Bug]: "
  labels: string[];        // e.g., ["bug", "triage"]
  sections: TemplateSection[];
}

/**
 * The full template config output
 */
export interface TemplateConfig {
  templates: IssueTemplate[];
  generatedAt: string;     // ISO timestamp
  sourceDir: string;       // Path to .github/ISSUE_TEMPLATE/
}

/**
 * Known filename suffixes to strip when deriving subcommand.
 * Pattern: strip _report, _request, _question, then take the first word.
 */
const SUFFIX_PATTERNS = ['_report', '_request', '_question'];

/**
 * Derive a subcommand name from a template filename.
 *
 * Examples:
 *   bug_report.yml     -> "bug"
 *   feature_request.yml -> "feature"
 *   help_question.yml   -> "help"
 */
function deriveSubcommand(filename: string): string {
  // Remove .yml / .yaml extension
  let stem = filename.replace(/\.ya?ml$/i, '');

  // Strip known suffixes
  for (const suffix of SUFFIX_PATTERNS) {
    if (stem.endsWith(suffix)) {
      stem = stem.slice(0, -suffix.length);
      break;
    }
  }

  // Take the first word (split on underscore, hyphen, or space)
  const firstWord = stem.split(/[_\-\s]/)[0];
  return firstWord.toLowerCase();
}

/**
 * Parse a single YAML template file into an IssueTemplate.
 */
function parseTemplateFile(templateDir: string, filename: string): IssueTemplate {
  const filePath = join(templateDir, filename);
  const raw = readFileSync(filePath, 'utf-8');
  const parsed = parseYaml(raw) as Record<string, unknown>;

  const name = typeof parsed.name === 'string' ? parsed.name : filename;
  const titlePrefix = typeof parsed.title === 'string' ? parsed.title : '';

  // Parse labels - can be an array of strings
  let labels: string[] = [];
  if (Array.isArray(parsed.labels)) {
    labels = parsed.labels.map((l: unknown) => String(l));
  }

  // Parse body sections
  const sections: TemplateSection[] = [];
  if (Array.isArray(parsed.body)) {
    for (const item of parsed.body) {
      if (typeof item !== 'object' || item === null) continue;

      const entry = item as Record<string, unknown>;
      const type = String(entry.type || 'unknown') as TemplateSection['type'];
      const attributes = (entry.attributes || {}) as Record<string, unknown>;
      const validations = (entry.validations || {}) as Record<string, unknown>;

      // For markdown type, use 'value' hash as a pseudo-id since they lack an id field
      const id = typeof entry.id === 'string'
        ? entry.id
        : (type === 'markdown' ? `markdown-${sections.length}` : `section-${sections.length}`);

      const label = typeof attributes.label === 'string'
        ? attributes.label
        : (type === 'markdown' ? 'Markdown' : '');

      const required = validations.required === true;

      const section: TemplateSection = {
        id,
        type,
        label,
        required,
      };

      // Add options for dropdown type
      if (type === 'dropdown' && Array.isArray(attributes.options)) {
        section.options = attributes.options.map((o: unknown) => String(o));
      }

      // Add options for checkboxes type
      if (type === 'checkboxes' && Array.isArray(attributes.options)) {
        section.options = (attributes.options as Array<Record<string, unknown>>).map(
          (o) => typeof o.label === 'string' ? o.label : String(o)
        );
      }

      // Add placeholder if present
      if (typeof attributes.placeholder === 'string') {
        section.placeholder = attributes.placeholder;
      }

      sections.push(section);
    }
  }

  return {
    filename,
    subcommand: deriveSubcommand(filename),
    name,
    titlePrefix,
    labels,
    sections,
  };
}

/**
 * Parse all templates from the repo's .github/ISSUE_TEMPLATE/ directory.
 *
 * Reads YAML files directly (live parse, no caching).
 * Excludes config.yml which is the GitHub template chooser config.
 */
export function parseIssueTemplates(projectRoot: string): EngineResult<TemplateConfig> {
  const templateDir = join(projectRoot, '.github', 'ISSUE_TEMPLATE');

  if (!existsSync(templateDir)) {
    return engineError('E_NOT_FOUND', `Issue template directory not found: ${templateDir}`);
  }

  let files: string[];
  try {
    files = readdirSync(templateDir)
      .filter((f) => /\.ya?ml$/i.test(f) && f !== 'config.yml');
  } catch (error: unknown) {
    return engineError('E_FILE_ERROR', `Failed to read template directory: ${(error as Error).message}`);
  }

  if (files.length === 0) {
    return engineError('E_NOT_FOUND', 'No issue template YAML files found (excluding config.yml)');
  }

  const templates: IssueTemplate[] = [];

  for (const file of files.sort()) {
    try {
      templates.push(parseTemplateFile(templateDir, file));
    } catch (error: unknown) {
      return engineError('E_PARSE_ERROR', `Failed to parse template ${file}: ${(error as Error).message}`, {
        details: { filename: file },
      });
    }
  }

  return {
    success: true,
    data: {
      templates,
      generatedAt: new Date().toISOString(),
      sourceDir: templateDir,
    },
  };
}

/**
 * Get template config for a specific subcommand (bug/feature/help).
 *
 * Performs a live parse and filters to the matching template.
 */
export function getTemplateForSubcommand(
  projectRoot: string,
  subcommand: string
): EngineResult<IssueTemplate> {
  const result = parseIssueTemplates(projectRoot);

  if (!result.success || !result.data) {
    return result.error
      ? { success: false, error: result.error }
      : engineError('E_PARSE_ERROR', 'Failed to parse issue templates');
  }

  const template = result.data.templates.find(
    (t) => t.subcommand === subcommand.toLowerCase()
  );

  if (!template) {
    const available = result.data.templates.map((t) => t.subcommand).join(', ');
    return engineError('E_NOT_FOUND', `No template found for subcommand '${subcommand}'. Available: ${available}`, {
      details: { available: result.data.templates.map((t) => t.subcommand) },
    });
  }

  return { success: true, data: template };
}

/**
 * Generate and cache the config as .cleo/issue-templates.json.
 *
 * Performs a live parse, then writes the result using writeJsonFileAtomic.
 */
export async function generateTemplateConfig(
  projectRoot: string
): Promise<EngineResult<TemplateConfig>> {
  const result = parseIssueTemplates(projectRoot);

  if (!result.success || !result.data) {
    return result.error
      ? { success: false, error: result.error }
      : engineError('E_PARSE_ERROR', 'Failed to parse issue templates');
  }

  const outputPath = getDataPath(projectRoot, 'issue-templates.json');

  try {
    writeJsonFileAtomic(outputPath, result.data);
  } catch (error: unknown) {
    return engineError('E_FILE_ERROR', `Failed to write template config: ${(error as Error).message}`, {
      details: { outputPath },
    });
  }

  return { success: true, data: result.data };
}

/**
 * Validate that labels exist on a GitHub repo.
 *
 * Compares the template labels against a list of known repo labels.
 * Returns which labels exist and which are missing.
 */
export function validateLabels(
  labels: string[],
  repoLabels: string[]
): EngineResult<{ existing: string[]; missing: string[] }> {
  const repoLabelSet = new Set(repoLabels.map((l) => l.toLowerCase()));

  const existing: string[] = [];
  const missing: string[] = [];

  for (const label of labels) {
    if (repoLabelSet.has(label.toLowerCase())) {
      existing.push(label);
    } else {
      missing.push(label);
    }
  }

  return {
    success: true,
    data: { existing, missing },
  };
}
