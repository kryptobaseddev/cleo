/**
 * Marker-based instruction file injection
 *
 * Injects content blocks between CAAMP markers in instruction files
 * (CLAUDE.md, AGENTS.md, GEMINI.md).
 */

import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { InjectionCheckResult, InjectionStatus, Provider } from "../../types.js";
import { getProvider } from "../registry/providers.js";
import { buildInjectionContent, type InjectionTemplate } from "./templates.js";

const MARKER_START = "<!-- CAAMP:START -->";
const MARKER_END = "<!-- CAAMP:END -->";
const MARKER_PATTERN = /<!-- CAAMP:START -->[\s\S]*?<!-- CAAMP:END -->/g;
const MARKER_PATTERN_SINGLE = /<!-- CAAMP:START -->[\s\S]*?<!-- CAAMP:END -->/;

/**
 * Check the status of a CAAMP injection block in an instruction file.
 *
 * Returns the injection status:
 * - `"missing"` - File does not exist
 * - `"none"` - File exists but has no CAAMP markers
 * - `"current"` - CAAMP block exists and matches expected content (or no expected content given)
 * - `"outdated"` - CAAMP block exists but differs from expected content
 *
 * @param filePath - Absolute path to the instruction file
 * @param expectedContent - Optional expected content to compare against
 * @returns The injection status
 *
 * @remarks
 * Does not modify the file. Safe to call repeatedly for status checks.
 *
 * @example
 * ```typescript
 * const status = await checkInjection("/project/CLAUDE.md", expectedContent);
 * if (status === "outdated") {
 *   console.log("CAAMP injection needs updating");
 * }
 * ```
 *
 * @public
 */
export async function checkInjection(
  filePath: string,
  expectedContent?: string,
): Promise<InjectionStatus> {
  if (!existsSync(filePath)) return "missing";

  const content = await readFile(filePath, "utf-8");

  if (!MARKER_PATTERN_SINGLE.test(content)) return "none";

  if (expectedContent) {
    const blockContent = extractBlock(content);
    if (blockContent && blockContent.trim() === expectedContent.trim()) {
      return "current";
    }
    return "outdated";
  }

  return "current";
}

/** Extract the content between CAAMP markers */
function extractBlock(content: string): string | null {
  const match = content.match(MARKER_PATTERN_SINGLE);
  if (!match) return null;

  return match[0]
    .replace(MARKER_START, "")
    .replace(MARKER_END, "")
    .trim();
}

/** Build the injection block */
function buildBlock(content: string): string {
  return `${MARKER_START}\n${content}\n${MARKER_END}`;
}

/**
 * Inject content into an instruction file between CAAMP markers.
 *
 * Behavior depends on the file state:
 * - File does not exist: creates the file with the injection block → `"created"`
 * - File exists without markers: prepends the injection block → `"added"`
 * - File exists with multiple markers (duplicates): consolidates into single block → `"consolidated"`
 * - File exists with markers, content differs: replaces the block → `"updated"`
 * - File exists with markers, content matches: no-op → `"intact"`
 *
 * This function is **idempotent** — calling it multiple times with the same
 * content will not modify the file after the first write.
 *
 * @param filePath - Absolute path to the instruction file
 * @param content - Content to inject between CAAMP markers
 * @returns Action taken: `"created"`, `"added"`, `"consolidated"`, `"updated"`, or `"intact"`
 *
 * @remarks
 * Handles duplicate marker consolidation automatically. When multiple CAAMP
 * blocks are detected (from manual edits or bugs), they are merged into one.
 *
 * @example
 * ```typescript
 * const action = await inject("/project/CLAUDE.md", "## My Config\nSome content");
 * console.log(`File ${action}`); // "created" on first call, "intact" on subsequent
 * ```
 *
 * @public
 */
export async function inject(
  filePath: string,
  content: string,
): Promise<"created" | "added" | "consolidated" | "updated" | "intact"> {
  const block = buildBlock(content);

  // Ensure parent directory exists
  await mkdir(dirname(filePath), { recursive: true });

  if (!existsSync(filePath)) {
    // Create new file with injection block
    await writeFile(filePath, `${block}\n`, "utf-8");
    return "created";
  }

  const existing = await readFile(filePath, "utf-8");

  // Find all CAAMP blocks in the file
  const matches = existing.match(MARKER_PATTERN);

  if (matches && matches.length > 0) {
    // Check if there are multiple duplicate blocks
    if (matches.length > 1) {
      // Consolidate all blocks into a single clean block
      const updated = existing
        .replace(MARKER_PATTERN, "")
        .replace(/^\n{2,}/, "\n")
        .trim();
      
      // Write the clean content with a single block
      const finalContent = updated 
        ? `${block}\n\n${updated}`
        : `${block}\n`;
      await writeFile(filePath, finalContent, "utf-8");
      return "consolidated";
    }

    // Check if existing content already matches (idempotency)
    const existingBlock = extractBlock(existing);
    if (existingBlock !== null && existingBlock.trim() === content.trim()) {
      return "intact";
    }

    // Replace existing block with new content
    const updated = existing.replace(MARKER_PATTERN_SINGLE, block);
    await writeFile(filePath, updated, "utf-8");
    return "updated";
  }

  // Prepend block to existing content
  const updated = `${block}\n\n${existing}`;
  await writeFile(filePath, updated, "utf-8");
  return "added";
}

/**
 * Remove the CAAMP injection block from an instruction file.
 *
 * If removing the block would leave the file empty, the file is deleted entirely.
 *
 * @param filePath - Absolute path to the instruction file
 * @returns `true` if a CAAMP block was found and removed, `false` otherwise
 *
 * @remarks
 * Cleans up any leftover blank lines after removing the block. If the file
 * would be entirely empty after removal, the file itself is deleted.
 *
 * @example
 * ```typescript
 * const removed = await removeInjection("/project/CLAUDE.md");
 * ```
 *
 * @public
 */
export async function removeInjection(filePath: string): Promise<boolean> {
  if (!existsSync(filePath)) return false;

  const content = await readFile(filePath, "utf-8");
  if (!MARKER_PATTERN.test(content)) return false;

  const cleaned = content
    .replace(MARKER_PATTERN, "")
    .replace(/^\n{2,}/, "\n")
    .trim();

  if (!cleaned) {
    // File would be empty - remove it entirely
    const { rm } = await import("node:fs/promises");
    await rm(filePath);
  } else {
    await writeFile(filePath, `${cleaned}\n`, "utf-8");
  }

  return true;
}

/**
 * Check injection status across all providers' instruction files.
 *
 * Deduplicates by file path since multiple providers may share the same
 * instruction file (e.g. many providers use `AGENTS.md`).
 *
 * @param providers - Array of providers to check
 * @param projectDir - Absolute path to the project directory
 * @param scope - Whether to check project or global instruction files
 * @param expectedContent - Optional expected content to compare against
 * @returns Array of injection check results, one per unique instruction file
 *
 * @remarks
 * Multiple providers may share the same instruction file (e.g. many use
 * `AGENTS.md`). This function deduplicates to avoid redundant file reads.
 *
 * @example
 * ```typescript
 * const results = await checkAllInjections(providers, "/project", "project", expected);
 * const outdated = results.filter(r => r.status === "outdated");
 * ```
 *
 * @public
 */
export async function checkAllInjections(
  providers: Provider[],
  projectDir: string,
  scope: "project" | "global",
  expectedContent?: string,
): Promise<InjectionCheckResult[]> {
  const results: InjectionCheckResult[] = [];
  const checked = new Set<string>();

  for (const provider of providers) {
    const filePath = scope === "global"
      ? join(provider.pathGlobal, provider.instructFile)
      : join(projectDir, provider.instructFile);

    // Skip duplicates (multiple providers share same instruction file)
    if (checked.has(filePath)) continue;
    checked.add(filePath);

    const status = await checkInjection(filePath, expectedContent);

    results.push({
      file: filePath,
      provider: provider.id,
      status,
      fileExists: existsSync(filePath),
    });
  }

  return results;
}

/**
 * Inject content into all providers' instruction files.
 *
 * Deduplicates by file path to avoid injecting the same file multiple times.
 *
 * @param providers - Array of providers to inject into
 * @param projectDir - Absolute path to the project directory
 * @param scope - Whether to target project or global instruction files
 * @param content - Content to inject between CAAMP markers
 * @returns Map of file path to action taken (`"created"`, `"added"`, `"consolidated"`, `"updated"`, or `"intact"`)
 *
 * @remarks
 * Providers sharing the same instruction file are only written once to avoid
 * conflicting concurrent writes.
 *
 * @example
 * ```typescript
 * const results = await injectAll(providers, "/project", "project", content);
 * for (const [file, action] of results) {
 *   console.log(`${file}: ${action}`);
 * }
 * ```
 *
 * @public
 */
export async function injectAll(
  providers: Provider[],
  projectDir: string,
  scope: "project" | "global",
  content: string,
): Promise<Map<string, "created" | "added" | "consolidated" | "updated" | "intact">> {
  const results = new Map<string, "created" | "added" | "consolidated" | "updated" | "intact">();
  const injected = new Set<string>();

  for (const provider of providers) {
    const filePath = scope === "global"
      ? join(provider.pathGlobal, provider.instructFile)
      : join(projectDir, provider.instructFile);

    // Skip duplicates
    if (injected.has(filePath)) continue;
    injected.add(filePath);

    const action = await inject(filePath, content);
    results.set(filePath, action);
  }

  return results;
}

// ── Provider Instruction File API ─────────────────────────────────

/**
 * Options for ensuring a provider instruction file.
 *
 * @public
 */
export interface EnsureProviderInstructionFileOptions {
  /** `\@` references to inject (e.g. `["\@AGENTS.md"]`). */
  references: string[];
  /** Optional inline content blocks. @defaultValue `undefined` */
  content?: string[];
  /** Whether this is a global or project-level file. @defaultValue `"project"` */
  scope?: "project" | "global";
}

/**
 * Result of ensuring a provider instruction file.
 *
 * @public
 */
export interface EnsureProviderInstructionFileResult {
  /** Absolute path to the instruction file. */
  filePath: string;
  /** Instruction file name from the provider registry. */
  instructFile: string;
  /** Action taken. */
  action: "created" | "added" | "consolidated" | "updated" | "intact";
  /** Provider ID. */
  providerId: string;
}

/**
 * Ensure a provider's instruction file exists with the correct CAAMP block.
 *
 * This is the canonical API for adapters and external packages to manage
 * provider instruction files. Instead of directly creating/modifying
 * CLAUDE.md, GEMINI.md, etc., callers should use this function to
 * delegate instruction file management to CAAMP.
 *
 * The instruction file name is resolved from CAAMP's provider registry
 * (single source of truth), not hardcoded by the caller.
 *
 * @remarks
 * The instruction file name is resolved from CAAMP's provider registry
 * (single source of truth), not hardcoded by the caller.
 *
 * @param providerId - Provider ID from the registry (e.g. `"claude-code"`, `"gemini-cli"`)
 * @param projectDir - Absolute path to the project directory
 * @param options - References, content, and scope configuration
 * @returns Result with file path, action taken, and provider metadata
 * @throws Error if the provider ID is not found in the registry
 *
 * @example
 * ```typescript
 * const result = await ensureProviderInstructionFile("claude-code", "/project", {
 *   references: ["\@AGENTS.md"],
 * });
 * ```
 *
 * @public
 */
export async function ensureProviderInstructionFile(
  providerId: string,
  projectDir: string,
  options: EnsureProviderInstructionFileOptions,
): Promise<EnsureProviderInstructionFileResult> {
  const provider = getProvider(providerId);
  if (!provider) {
    throw new Error(`Unknown provider: "${providerId}". Check CAAMP provider registry.`);
  }

  const scope = options.scope ?? "project";
  const filePath = scope === "global"
    ? join(provider.pathGlobal, provider.instructFile)
    : join(projectDir, provider.instructFile);

  const template: InjectionTemplate = {
    references: options.references,
    content: options.content,
  };

  const injectionContent = buildInjectionContent(template);
  const action = await inject(filePath, injectionContent);

  return {
    filePath,
    instructFile: provider.instructFile,
    action,
    providerId: provider.id,
  };
}

/**
 * Ensure instruction files for multiple providers at once.
 *
 * Deduplicates by file path — providers sharing the same instruction file
 * (e.g. many providers use AGENTS.md) are only written once.
 *
 * @remarks
 * Providers sharing the same instruction file (e.g. many use `AGENTS.md`)
 * are only written once, avoiding duplicate blocks.
 *
 * @param providerIds - Array of provider IDs from the registry
 * @param projectDir - Absolute path to the project directory
 * @param options - References, content, and scope configuration
 * @returns Array of results, one per unique instruction file
 * @throws Error if any provider ID is not found in the registry
 *
 * @example
 * ```typescript
 * const results = await ensureAllProviderInstructionFiles(
 *   ["claude-code", "cursor", "gemini-cli"],
 *   "/project",
 *   { references: ["\@AGENTS.md"] },
 * );
 * ```
 *
 * @public
 */
export async function ensureAllProviderInstructionFiles(
  providerIds: string[],
  projectDir: string,
  options: EnsureProviderInstructionFileOptions,
): Promise<EnsureProviderInstructionFileResult[]> {
  const results: EnsureProviderInstructionFileResult[] = [];
  const processed = new Set<string>();

  for (const providerId of providerIds) {
    const provider = getProvider(providerId);
    if (!provider) {
      throw new Error(`Unknown provider: "${providerId}". Check CAAMP provider registry.`);
    }

    const scope = options.scope ?? "project";
    const filePath = scope === "global"
      ? join(provider.pathGlobal, provider.instructFile)
      : join(projectDir, provider.instructFile);

    // Skip duplicates (multiple providers may share the same instruction file)
    if (processed.has(filePath)) continue;
    processed.add(filePath);

    const template: InjectionTemplate = {
      references: options.references,
      content: options.content,
    };

    const injectionContent = buildInjectionContent(template);
    const action = await inject(filePath, injectionContent);

    results.push({
      filePath,
      instructFile: provider.instructFile,
      action,
      providerId: provider.id,
    });
  }

  return results;
}
