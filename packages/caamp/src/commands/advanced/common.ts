/**
 * Shared helpers for advanced command input parsing and validation.
 */

import { readFile } from 'node:fs/promises';
import type { SkillBatchOperation } from '../../core/advanced/orchestration.js';
import { getInstalledProviders } from '../../core/registry/detection.js';
import { getAllProviders, getProvider } from '../../core/registry/providers.js';
import type { Provider, ProviderPriority } from '../../types.js';
import { LAFSCommandError } from './lafs.js';

const VALID_PRIORITIES = new Set<ProviderPriority>(['high', 'medium', 'low']);

/**
 * Options for resolving which providers to target in advanced commands.
 *
 * @remarks
 * Used by resolveProviders to determine the set of providers from CLI flags.
 *
 * @public
 */
export interface ProviderTargetOptions {
  /** When true, target all registry providers including undetected ones. */
  all?: boolean;
  /** Specific provider IDs or aliases to target. */
  agent?: string[];
}

/**
 * Parses and validates a provider priority tier string.
 *
 * @remarks
 * Throws a LAFSCommandError if the value is not one of the valid priorities (high, medium, low).
 *
 * @param value - The priority string to parse
 * @returns The validated ProviderPriority value
 *
 * @example
 * ```typescript
 * const tier = parsePriority("high"); // "high"
 * ```
 *
 * @public
 */
export function parsePriority(value: string): ProviderPriority {
  if (!VALID_PRIORITIES.has(value as ProviderPriority)) {
    throw new LAFSCommandError(
      'E_ADVANCED_VALIDATION_PRIORITY',
      `Invalid tier: ${value}`,
      'Use one of: high, medium, low.',
    );
  }
  return value as ProviderPriority;
}

/**
 * Resolves the set of target providers from CLI targeting options.
 *
 * @remarks
 * When `all` is true, returns all registry providers. When agent IDs are specified, resolves
 * and validates them. Otherwise falls back to auto-detected installed providers.
 *
 * @param options - The provider targeting options from the CLI
 * @returns An array of resolved Provider objects
 *
 * @example
 * ```typescript
 * const providers = resolveProviders({ all: true });
 * ```
 *
 * @public
 */
export function resolveProviders(options: ProviderTargetOptions): Provider[] {
  if (options.all) {
    return getAllProviders();
  }

  const targetAgents = options.agent ?? [];
  if (targetAgents.length === 0) {
    return getInstalledProviders();
  }

  const providers = targetAgents
    .map((id) => getProvider(id))
    .filter((provider): provider is Provider => provider !== undefined);

  if (providers.length !== targetAgents.length) {
    const found = new Set(providers.map((provider) => provider.id));
    const missing = targetAgents.filter((id) => !found.has(id));
    throw new LAFSCommandError(
      'E_ADVANCED_PROVIDER_NOT_FOUND',
      `Unknown provider(s): ${missing.join(', ')}`,
      'Check `caamp providers list` for valid provider IDs/aliases.',
    );
  }

  return providers;
}

/**
 * Reads and parses a JSON file from disk.
 *
 * @remarks
 * Throws a LAFSCommandError with a recovery suggestion if the file cannot be read or parsed.
 *
 * @param path - Absolute or relative path to the JSON file
 * @returns The parsed JSON value
 *
 * @example
 * ```typescript
 * const data = await readJsonFile("./operations.json");
 * ```
 *
 * @public
 */
export async function readJsonFile(path: string): Promise<unknown> {
  try {
    const raw = await readFile(path, 'utf-8');
    return JSON.parse(raw) as unknown;
  } catch (error) {
    throw new LAFSCommandError(
      'E_ADVANCED_INPUT_JSON',
      `Failed to read JSON file: ${path}`,
      'Confirm the path exists and contains valid JSON.',
      true,
      { reason: error instanceof Error ? error.message : String(error) },
    );
  }
}

/**
 * Reads and validates a JSON file containing skill batch operations.
 *
 * @remarks
 * Parses the file and validates each entry has required fields (sourcePath, skillName) with proper types.
 * Throws LAFSCommandError on any validation failure with specific error codes.
 *
 * @param path - Path to the JSON file containing an array of skill operations
 * @returns An array of validated SkillBatchOperation objects
 *
 * @example
 * ```typescript
 * const ops = await readSkillOperations("./skill-ops.json");
 * ```
 *
 * @public
 */
export async function readSkillOperations(path: string): Promise<SkillBatchOperation[]> {
  const value = await readJsonFile(path);
  if (!Array.isArray(value)) {
    throw new LAFSCommandError(
      'E_ADVANCED_VALIDATION_SKILL_ARRAY',
      `Skill operations file must be a JSON array: ${path}`,
      'Provide an array of objects with sourcePath and skillName fields.',
    );
  }

  const operations: SkillBatchOperation[] = [];
  for (const [index, item] of value.entries()) {
    if (!item || typeof item !== 'object') {
      throw new LAFSCommandError(
        'E_ADVANCED_VALIDATION_SKILL_ITEM',
        `Invalid skill operation at index ${index}`,
        'Each operation must be an object with sourcePath and skillName.',
      );
    }

    const obj = item as Record<string, unknown>;
    const sourcePath = obj.sourcePath;
    const skillName = obj.skillName;
    const isGlobal = obj.isGlobal;

    if (typeof sourcePath !== 'string' || sourcePath.length === 0) {
      throw new LAFSCommandError(
        'E_ADVANCED_VALIDATION_SKILL_SOURCE',
        `Invalid sourcePath at index ${index}`,
        'Set sourcePath to a non-empty string.',
      );
    }

    if (typeof skillName !== 'string' || skillName.length === 0) {
      throw new LAFSCommandError(
        'E_ADVANCED_VALIDATION_SKILL_NAME',
        `Invalid skillName at index ${index}`,
        'Set skillName to a non-empty string.',
      );
    }

    if (isGlobal !== undefined && typeof isGlobal !== 'boolean') {
      throw new LAFSCommandError(
        'E_ADVANCED_VALIDATION_SKILL_SCOPE',
        `Invalid isGlobal value at index ${index}`,
        'Set isGlobal to true or false when provided.',
      );
    }

    operations.push({
      sourcePath,
      skillName,
      ...(isGlobal !== undefined ? { isGlobal } : {}),
    });
  }

  return operations;
}

/**
 * Reads text input from either inline content or a file path, enforcing mutual exclusivity.
 *
 * @remarks
 * Throws LAFSCommandError if both inline content and a file path are provided simultaneously.
 * Returns undefined if neither is provided.
 *
 * @param inlineContent - Inline text content from the --content flag, or undefined
 * @param filePath - Path to a content file from the --content-file flag, or undefined
 * @returns The text content string, or undefined if no input was provided
 *
 * @example
 * ```typescript
 * const content = await readTextInput(undefined, "./content.txt");
 * ```
 *
 * @public
 */
export async function readTextInput(
  inlineContent: string | undefined,
  filePath: string | undefined,
): Promise<string | undefined> {
  if (inlineContent && filePath) {
    throw new LAFSCommandError(
      'E_ADVANCED_VALIDATION_INPUT_MODE',
      'Provide either inline content or a content file, not both.',
      'Use --content OR --content-file.',
    );
  }

  if (inlineContent) return inlineContent;
  if (!filePath) return undefined;

  try {
    return await readFile(filePath, 'utf-8');
  } catch (error) {
    throw new LAFSCommandError(
      'E_ADVANCED_INPUT_TEXT',
      `Failed to read content file: ${filePath}`,
      'Confirm the file exists and is readable.',
      true,
      { reason: error instanceof Error ? error.message : String(error) },
    );
  }
}
