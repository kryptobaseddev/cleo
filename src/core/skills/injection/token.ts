/**
 * Token injection library for subagent templates.
 * Ports lib/skills/token-inject.sh.
 *
 * Implements strict token replacement with validation to prevent hallucination.
 * All tokens use {{TOKEN_NAME}} format.
 *
 * @epic T4454
 * @task T4521
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getProjectRoot } from '../../paths.js';

// ============================================================================
// Types
// ============================================================================

/** Token values map: TOKEN_NAME -> value. */
export type TokenValues = Record<string, string>;

/** Token definition from placeholders.json. */
interface PlaceholderDef {
  token: string;
  description?: string;
  pattern?: string;
  default?: string;
}

/** Placeholders.json schema. */
interface PlaceholdersConfig {
  required?: PlaceholderDef[];
  context?: PlaceholderDef[];
  taskCommands?: { tokens: PlaceholderDef[] };
  taskContext?: { tokens: PlaceholderDef[] };
  skillSpecific?: { tokens: PlaceholderDef[] };
}

// ============================================================================
// Required Tokens
// ============================================================================

const REQUIRED_TOKENS = ['TASK_ID', 'DATE', 'TOPIC_SLUG'];

/** Validation patterns for required tokens. */
const TOKEN_PATTERNS: Record<string, RegExp> = {
  TASK_ID: /^T\d+$/,
  DATE: /^\d{4}-\d{2}-\d{2}$/,
  TOPIC_SLUG: /^[a-zA-Z0-9_-]+$/,
  EPIC_ID: /^T\d+$/,
  PARENT_ID: /^T\d+$/,
  SESSION_ID: /^session[-_]\d{8}[-_]\d{6}[-_][a-f0-9]+$/,
};

// ============================================================================
// Default Values
// ============================================================================

/** CLEO command defaults. */
const CLEO_DEFAULTS: TokenValues = {
  TASK_SHOW_CMD: 'cleo show',
  TASK_FOCUS_CMD: 'cleo focus set',
  TASK_FOCUS_SHOW_CMD: 'cleo focus show',
  TASK_COMPLETE_CMD: 'cleo complete',
  TASK_LINK_CMD: 'cleo research link',
  TASK_LIST_CMD: 'cleo list',
  TASK_FIND_CMD: 'cleo find',
  TASK_ADD_CMD: 'cleo add',
  TASK_EXISTS_CMD: 'cleo exists',
  TASK_PHASE_CMD: 'cleo phase show',
  TASK_TREE_CMD: 'cleo list --tree',
  SESSION_LIST_CMD: 'cleo session list',
  SESSION_START_CMD: 'cleo session start',
  SESSION_END_CMD: 'cleo session end',
  SESSION_GC_CMD: 'cleo session gc',
  RESEARCH_LIST_CMD: 'cleo research list',
  RESEARCH_SHOW_CMD: 'cleo research show',
  RESEARCH_PENDING_CMD: 'cleo research pending',
  RESEARCH_INJECT_CMD: 'cleo research inject',
  DASH_CMD: 'cleo dash',
  OUTPUT_DIR: '.cleo/agent-outputs',
  MANIFEST_PATH: '.cleo/agent-outputs/MANIFEST.jsonl',
};

// ============================================================================
// Token Loading
// ============================================================================

/**
 * Load token definitions from placeholders.json.
 * @task T4521
 */
export function loadPlaceholders(cwd?: string): PlaceholdersConfig | null {
  const projectRoot = getProjectRoot(cwd);
  const path = join(projectRoot, 'skills', '_shared', 'placeholders.json');

  if (!existsSync(path)) return null;

  try {
    return JSON.parse(readFileSync(path, 'utf-8'));
  } catch {
    return null;
  }
}

/**
 * Build the full default values map (merging placeholders.json with hardcoded defaults).
 * @task T4521
 */
export function buildDefaults(cwd?: string): TokenValues {
  const defaults = { ...CLEO_DEFAULTS };

  const config = loadPlaceholders(cwd);
  if (config) {
    // Merge defaults from all sections
    const sections = [
      config.context,
      config.taskCommands?.tokens,
      config.taskContext?.tokens,
      config.skillSpecific?.tokens,
    ];

    for (const section of sections) {
      if (!Array.isArray(section)) continue;
      for (const def of section) {
        if (def.default !== undefined && def.default !== '') {
          defaults[def.token] = def.default;
        }
      }
    }
  }

  return defaults;
}

// ============================================================================
// Token Validation
// ============================================================================

/**
 * Validate a single token value against its pattern.
 * @task T4521
 */
export function validateTokenValue(
  token: string,
  value: string,
): { valid: boolean; error?: string } {
  const pattern = TOKEN_PATTERNS[token];
  if (!pattern) return { valid: true }; // No pattern = always valid

  if (!value) {
    return { valid: false, error: `Token ${token} is empty` };
  }

  if (!pattern.test(value)) {
    return { valid: false, error: `Token ${token} value "${value}" does not match pattern ${pattern}` };
  }

  return { valid: true };
}

/**
 * Validate all required tokens are present and valid.
 * @task T4521
 */
export function validateRequired(
  values: TokenValues,
): { valid: boolean; missing: string[]; invalid: Array<{ token: string; error: string }> } {
  const missing: string[] = [];
  const invalid: Array<{ token: string; error: string }> = [];

  for (const token of REQUIRED_TOKENS) {
    const value = values[token];
    if (!value) {
      missing.push(token);
      continue;
    }

    const result = validateTokenValue(token, value);
    if (!result.valid) {
      invalid.push({ token, error: result.error! });
    }
  }

  return {
    valid: missing.length === 0 && invalid.length === 0,
    missing,
    invalid,
  };
}

/**
 * Validate all tokens in a values map (required + optional).
 * @task T4521
 */
export function validateAllTokens(
  values: TokenValues,
): { valid: boolean; errors: Array<{ token: string; error: string }> } {
  const errors: Array<{ token: string; error: string }> = [];

  for (const [token, value] of Object.entries(values)) {
    if (!value) continue; // Empty optional tokens are ok
    const result = validateTokenValue(token, value);
    if (!result.valid) {
      errors.push({ token, error: result.error! });
    }
  }

  return { valid: errors.length === 0, errors };
}

// ============================================================================
// Token Injection
// ============================================================================

/**
 * Inject token values into a template string.
 * Replaces all {{TOKEN_NAME}} patterns with corresponding values.
 * Unresolved tokens are left as-is (for debugging).
 * @task T4521
 */
export function injectTokens(template: string, values: TokenValues): string {
  // Merge with defaults (explicit values override defaults)
  const merged = { ...CLEO_DEFAULTS, ...values };

  return template.replace(/\{\{(\w+)\}\}/g, (match, token: string) => {
    const value = merged[token];
    if (value !== undefined && value !== '') {
      return value;
    }
    // Return the token as-is if not resolved (helps debugging)
    return match;
  });
}

/**
 * Check if a template has unresolved tokens after injection.
 * @task T4521
 */
export function hasUnresolvedTokens(content: string): string[] {
  const matches = content.match(/\{\{(\w+)\}\}/g) ?? [];
  return [...new Set(matches.map(m => m.replace(/\{\{|\}\}/g, '')))];
}

/**
 * Load a skill template and inject tokens.
 * @task T4521
 */
export function loadAndInject(
  templatePath: string,
  values: TokenValues,
): { content: string; unresolvedTokens: string[] } {
  if (!existsSync(templatePath)) {
    throw new Error(`Template not found: ${templatePath}`);
  }

  const template = readFileSync(templatePath, 'utf-8');
  const content = injectTokens(template, values);
  const unresolvedTokens = hasUnresolvedTokens(content);

  return { content, unresolvedTokens };
}
