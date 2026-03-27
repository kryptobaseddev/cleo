/**
 * Skill catalog - registry pattern for pluggable skill libraries.
 *
 * Projects MUST register their skill library via registerSkillLibrary() or
 * registerSkillLibraryFromPath(). CAAMP no longer auto-discovers from
 * ~/.agents/skill-library/ - explicit registration is required.
 *
 * All public functions delegate to the registered SkillLibrary instance.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { buildLibraryFromFiles, loadLibraryFromModule } from './library-loader.js';
import type {
  SkillLibrary,
  SkillLibraryDispatchMatrix,
  SkillLibraryEntry,
  SkillLibraryManifest,
  SkillLibraryProfile,
  SkillLibraryValidationResult,
} from './skill-library.js';

// ── Registry ────────────────────────────────────────────────────────

let _library: SkillLibrary | null = null;

/**
 * Registers a SkillLibrary instance directly as the active catalog.
 *
 * @remarks
 * Replaces any previously registered library. This is the programmatic
 * registration path for when you already have a constructed SkillLibrary
 * instance. For path-based registration, use {@link registerSkillLibraryFromPath}.
 *
 * @param library - A SkillLibrary implementation to use as the catalog
 *
 * @example
 * ```typescript
 * const library = buildLibraryFromFiles("/path/to/skills");
 * registerSkillLibrary(library);
 * ```
 *
 * @public
 */
export function registerSkillLibrary(library: SkillLibrary): void {
  _library = library;
}

/**
 * Registers a skill library by loading it from a directory path.
 *
 * @remarks
 * Tries two strategies in order: first attempts module-based loading if
 * the directory contains an `index.js`, then falls back to file-based
 * loading from raw files like `skills.json`. Replaces any previously
 * registered library on success.
 *
 * @param root - Absolute path to the skill library root directory
 * @throws Error if the library cannot be loaded from the given path
 *
 * @example
 * ```typescript
 * registerSkillLibraryFromPath("/home/user/.agents/skill-library");
 * const skills = listSkills();
 * ```
 *
 * @public
 */
export function registerSkillLibraryFromPath(root: string): void {
  // Try module-based loading first (has index.js)
  const indexPath = join(root, 'index.js');
  if (existsSync(indexPath)) {
    _library = loadLibraryFromModule(root);
    return;
  }

  // Fall back to file-based loading (has skills.json)
  _library = buildLibraryFromFiles(root);
}

/**
 * Clears the registered skill library instance.
 *
 * @remarks
 * Resets the internal library reference to null. Primarily intended for
 * test isolation to ensure a clean state between test cases.
 *
 * @example
 * ```typescript
 * clearRegisteredLibrary();
 * // isCatalogAvailable() will now return false unless auto-discovery succeeds
 * ```
 *
 * @public
 */
export function clearRegisteredLibrary(): void {
  _library = null;
}

// ── Auto-discovery ──────────────────────────────────────────────────

/**
 * Attempt to discover a skill library from well-known locations.
 *
 * Discovery order:
 * 1. CAAMP_SKILL_LIBRARY env var (path to library root)
 */
function discoverLibrary(): SkillLibrary | null {
  // 1. Environment variable
  const envPath = process.env['CAAMP_SKILL_LIBRARY'];
  if (envPath && existsSync(envPath)) {
    try {
      const indexPath = join(envPath, 'index.js');
      if (existsSync(indexPath)) {
        return loadLibraryFromModule(envPath);
      }
      if (existsSync(join(envPath, 'skills.json'))) {
        return buildLibraryFromFiles(envPath);
      }
    } catch {
      // Fall through
    }
  }

  return null;
}

// ── Internal accessor ───────────────────────────────────────────────

function getLibrary(): SkillLibrary {
  if (!_library) {
    const discovered = discoverLibrary();
    if (discovered) {
      _library = discovered;
    }
  }

  if (!_library) {
    throw new Error(
      'No skill library registered. Register one with registerSkillLibraryFromPath() ' +
        'or set the CAAMP_SKILL_LIBRARY environment variable.',
    );
  }

  return _library;
}

// ── Public API (delegates to registered library) ────────────────────

/**
 * Checks whether a skill library is available for use.
 *
 * @remarks
 * Returns true if a library has been explicitly registered or can be
 * auto-discovered via the `CAAMP_SKILL_LIBRARY` environment variable.
 * Does not throw on failure; catches any errors from discovery and
 * returns false instead.
 *
 * @returns True if a skill library is registered or discoverable, false otherwise
 *
 * @example
 * ```typescript
 * if (isCatalogAvailable()) {
 *   const skills = listSkills();
 * }
 * ```
 *
 * @public
 */
export function isCatalogAvailable(): boolean {
  try {
    getLibrary();
    return true;
  } catch {
    return false;
  }
}

/**
 * Returns all skill entries from the catalog.
 *
 * @remarks
 * Delegates to the registered skill library's `skills` property.
 * Throws if no library is registered or discoverable.
 *
 * @returns An array of all skill library entries
 *
 * @example
 * ```typescript
 * const allSkills = getSkills();
 * console.log(`Found ${allSkills.length} skills`);
 * ```
 *
 * @public
 */
export function getSkills(): SkillLibraryEntry[] {
  return getLibrary().skills;
}

/**
 * Returns the parsed skill library manifest.
 *
 * @remarks
 * The manifest contains library metadata, version info, and the dispatch
 * matrix. Delegates to the registered library instance.
 *
 * @returns The skill library manifest object
 *
 * @example
 * ```typescript
 * const manifest = getManifest();
 * console.log(manifest.version);
 * ```
 *
 * @public
 */
export function getManifest(): SkillLibraryManifest {
  return getLibrary().manifest;
}

/**
 * Lists all available skill names in the catalog.
 *
 * @remarks
 * Returns the names of all registered skills. Useful for discovery
 * and enumeration without loading full skill metadata.
 *
 * @returns An array of skill name strings
 *
 * @example
 * ```typescript
 * const names = listSkills();
 * // e.g., ["ct-orchestrator", "ct-dev-workflow", "ct-validator"]
 * ```
 *
 * @public
 */
export function listSkills(): string[] {
  return getLibrary().listSkills();
}

/**
 * Gets skill metadata by name from the catalog.
 *
 * @remarks
 * Looks up a skill by its unique name in the registered library.
 * Returns undefined if no skill with the given name exists.
 *
 * @param name - The unique skill name to look up
 * @returns The skill entry if found, or undefined
 *
 * @example
 * ```typescript
 * const skill = getSkill("ct-orchestrator");
 * if (skill) {
 *   console.log(skill.category);
 * }
 * ```
 *
 * @public
 */
export function getSkill(name: string): SkillLibraryEntry | undefined {
  return getLibrary().getSkill(name);
}

/**
 * Resolves the absolute path to a skill's SKILL.md file.
 *
 * @remarks
 * Combines the library root with the skill's relative path to produce
 * the absolute filesystem path to the SKILL.md file.
 *
 * @param name - The unique skill name to resolve
 * @returns The absolute path to the skill's SKILL.md file
 *
 * @example
 * ```typescript
 * const path = getSkillPath("ct-orchestrator");
 * // e.g., "/home/user/.agents/skill-library/skills/ct-orchestrator/SKILL.md"
 * ```
 *
 * @public
 */
export function getSkillPath(name: string): string {
  return getLibrary().getSkillPath(name);
}

/**
 * Resolves the absolute path to a skill's directory.
 *
 * @remarks
 * Returns the parent directory of the skill's SKILL.md file,
 * which may contain additional resources referenced by the skill.
 *
 * @param name - The unique skill name to resolve
 * @returns The absolute path to the skill's directory
 *
 * @example
 * ```typescript
 * const dir = getSkillDir("ct-orchestrator");
 * // e.g., "/home/user/.agents/skill-library/skills/ct-orchestrator"
 * ```
 *
 * @public
 */
export function getSkillDir(name: string): string {
  return getLibrary().getSkillDir(name);
}

/**
 * Reads a skill's SKILL.md content as a string.
 *
 * @remarks
 * Reads the full content of the skill's SKILL.md file from disk.
 * Throws if the skill does not exist or the file cannot be read.
 *
 * @param name - The unique skill name to read
 * @returns The full text content of the skill's SKILL.md file
 *
 * @example
 * ```typescript
 * const content = readSkillContent("ct-orchestrator");
 * console.log(content.substring(0, 100));
 * ```
 *
 * @public
 */
export function readSkillContent(name: string): string {
  return getLibrary().readSkillContent(name);
}

/**
 * Returns all skills marked as core in the catalog.
 *
 * @remarks
 * Filters the skill list to only include entries where `core` is true.
 * Core skills are foundational capabilities that most agents need.
 *
 * @returns An array of core skill entries
 *
 * @example
 * ```typescript
 * const coreSkills = getCoreSkills();
 * console.log(`${coreSkills.length} core skills available`);
 * ```
 *
 * @public
 */
export function getCoreSkills(): SkillLibraryEntry[] {
  return getLibrary().getCoreSkills();
}

/**
 * Returns skills filtered by category.
 *
 * @remarks
 * Filters the skill list to only include entries matching the specified
 * category. Categories organize skills by their functional purpose.
 *
 * @param category - The category to filter by
 * @returns An array of skill entries in the specified category
 *
 * @example
 * ```typescript
 * const planningSkills = getSkillsByCategory("planning");
 * ```
 *
 * @public
 */
export function getSkillsByCategory(category: SkillLibraryEntry['category']): SkillLibraryEntry[] {
  return getLibrary().getSkillsByCategory(category);
}

/**
 * Gets the direct dependency names for a skill.
 *
 * @remarks
 * Returns only the immediate dependencies, not transitive ones.
 * Use {@link resolveDependencyTree} for the full transitive closure.
 *
 * @param name - The unique skill name to query dependencies for
 * @returns An array of direct dependency skill names
 *
 * @example
 * ```typescript
 * const deps = getSkillDependencies("ct-task-executor");
 * // e.g., ["ct-orchestrator"]
 * ```
 *
 * @public
 */
export function getSkillDependencies(name: string): string[] {
  return getLibrary().getSkillDependencies(name);
}

/**
 * Resolves the full dependency tree for a set of skill names.
 *
 * @remarks
 * Performs transitive dependency resolution, returning all skills that
 * must be installed for the given set of skills to function correctly.
 * Handles circular dependencies gracefully.
 *
 * @param names - The skill names to resolve dependencies for
 * @returns A deduplicated array of all required skill names including transitive dependencies
 *
 * @example
 * ```typescript
 * const allDeps = resolveDependencyTree(["ct-task-executor", "ct-validator"]);
 * // includes all transitive dependencies
 * ```
 *
 * @public
 */
export function resolveDependencyTree(names: string[]): string[] {
  return getLibrary().resolveDependencyTree(names);
}

/**
 * Lists all available profile names in the catalog.
 *
 * @remarks
 * Profiles are named collections of skills that can be installed together.
 * Returns just the profile names; use {@link getProfile} for full details.
 *
 * @returns An array of profile name strings
 *
 * @example
 * ```typescript
 * const profiles = listProfiles();
 * // e.g., ["default", "minimal", "full"]
 * ```
 *
 * @public
 */
export function listProfiles(): string[] {
  return getLibrary().listProfiles();
}

/**
 * Gets a profile definition by name from the catalog.
 *
 * @remarks
 * Returns the full profile definition including its skill list and
 * any `extends` references. Returns undefined if no profile with
 * the given name exists.
 *
 * @param name - The unique profile name to look up
 * @returns The profile definition if found, or undefined
 *
 * @example
 * ```typescript
 * const profile = getProfile("default");
 * if (profile) {
 *   console.log(profile.skills);
 * }
 * ```
 *
 * @public
 */
export function getProfile(name: string): SkillLibraryProfile | undefined {
  return getLibrary().getProfile(name);
}

/**
 * Resolves a profile to its full skill list including inherited skills.
 *
 * @remarks
 * Follows `extends` chains and resolves all transitive dependencies,
 * returning the complete list of skills needed for the profile.
 *
 * @param name - The profile name to resolve
 * @returns A deduplicated array of all skill names required by the profile
 *
 * @example
 * ```typescript
 * const skills = resolveProfile("default");
 * // includes all skills from extended profiles and their dependencies
 * ```
 *
 * @public
 */
export function resolveProfile(name: string): string[] {
  return getLibrary().resolveProfile(name);
}

/**
 * Lists all available shared resource names in the catalog.
 *
 * @remarks
 * Shared resources are files in the `_shared` directory that multiple
 * skills can reference. Returns just the resource names.
 *
 * @returns An array of shared resource name strings
 *
 * @example
 * ```typescript
 * const resources = listSharedResources();
 * // e.g., ["testing-framework-config.md", "error-handling.md"]
 * ```
 *
 * @public
 */
export function listSharedResources(): string[] {
  return getLibrary().listSharedResources();
}

/**
 * Gets the absolute path to a shared resource file.
 *
 * @remarks
 * Resolves the filesystem path for a shared resource by name.
 * Returns undefined if the resource does not exist.
 *
 * @param name - The shared resource name to resolve
 * @returns The absolute path to the resource file, or undefined if not found
 *
 * @example
 * ```typescript
 * const path = getSharedResourcePath("testing-framework-config.md");
 * ```
 *
 * @public
 */
export function getSharedResourcePath(name: string): string | undefined {
  return getLibrary().getSharedResourcePath(name);
}

/**
 * Reads a shared resource file's content as a string.
 *
 * @remarks
 * Reads the full content of a shared resource file from disk.
 * Returns undefined if the resource does not exist.
 *
 * @param name - The shared resource name to read
 * @returns The text content of the resource, or undefined if not found
 *
 * @example
 * ```typescript
 * const content = readSharedResource("testing-framework-config.md");
 * if (content) {
 *   console.log(content);
 * }
 * ```
 *
 * @public
 */
export function readSharedResource(name: string): string | undefined {
  return getLibrary().readSharedResource(name);
}

/**
 * Lists all available protocol names in the catalog.
 *
 * @remarks
 * Protocols define standardized interaction patterns for agent workflows.
 * Returns just the protocol names; use {@link readProtocol} for content.
 *
 * @returns An array of protocol name strings
 *
 * @example
 * ```typescript
 * const protocols = listProtocols();
 * // e.g., ["research", "implementation", "contribution"]
 * ```
 *
 * @public
 */
export function listProtocols(): string[] {
  return getLibrary().listProtocols();
}

/**
 * Gets the absolute path to a protocol file.
 *
 * @remarks
 * Resolves the filesystem path for a protocol by name.
 * Returns undefined if the protocol does not exist.
 *
 * @param name - The protocol name to resolve
 * @returns The absolute path to the protocol file, or undefined if not found
 *
 * @example
 * ```typescript
 * const path = getProtocolPath("research");
 * ```
 *
 * @public
 */
export function getProtocolPath(name: string): string | undefined {
  return getLibrary().getProtocolPath(name);
}

/**
 * Reads a protocol file's content as a string.
 *
 * @remarks
 * Reads the full content of a protocol file from disk.
 * Returns undefined if the protocol does not exist.
 *
 * @param name - The protocol name to read
 * @returns The text content of the protocol, or undefined if not found
 *
 * @example
 * ```typescript
 * const content = readProtocol("research");
 * if (content) {
 *   console.log(content);
 * }
 * ```
 *
 * @public
 */
export function readProtocol(name: string): string | undefined {
  return getLibrary().readProtocol(name);
}

/**
 * Validates a single skill's frontmatter against the schema.
 *
 * @remarks
 * Checks that the skill's SKILL.md file has valid YAML frontmatter
 * with all required fields. Returns a validation result with any errors.
 *
 * @param name - The skill name to validate
 * @returns A validation result indicating success or listing errors
 *
 * @example
 * ```typescript
 * const result = validateSkillFrontmatter("ct-orchestrator");
 * if (!result.valid) {
 *   console.error(result.errors);
 * }
 * ```
 *
 * @public
 */
export function validateSkillFrontmatter(name: string): SkillLibraryValidationResult {
  return getLibrary().validateSkillFrontmatter(name);
}

/**
 * Validates all skills in the catalog and returns results per skill.
 *
 * @remarks
 * Runs frontmatter validation on every skill in the library.
 * Returns a map keyed by skill name with validation results for each.
 *
 * @returns A map of skill names to their validation results
 *
 * @example
 * ```typescript
 * const results = validateAll();
 * for (const [name, result] of results) {
 *   if (!result.valid) console.error(`${name}: invalid`);
 * }
 * ```
 *
 * @public
 */
export function validateAll(): Map<string, SkillLibraryValidationResult> {
  return getLibrary().validateAll();
}

/**
 * Gets the dispatch matrix from the skill library manifest.
 *
 * @remarks
 * The dispatch matrix maps protocol types to their corresponding skills,
 * enabling the orchestrator to route tasks to the correct executor.
 *
 * @returns The dispatch matrix object from the manifest
 *
 * @example
 * ```typescript
 * const matrix = getDispatchMatrix();
 * console.log(matrix);
 * ```
 *
 * @public
 */
export function getDispatchMatrix(): SkillLibraryDispatchMatrix {
  return getLibrary().getDispatchMatrix();
}

/**
 * Returns the skill library version string.
 *
 * @remarks
 * The version follows semver and corresponds to the version declared
 * in the library's manifest file.
 *
 * @returns The library version string
 *
 * @example
 * ```typescript
 * const version = getVersion();
 * // e.g., "1.0.0"
 * ```
 *
 * @public
 */
export function getVersion(): string {
  return getLibrary().version;
}

/**
 * Returns the absolute path to the skill library root directory.
 *
 * @remarks
 * This is the base directory from which all skill paths are resolved.
 * Set during library registration.
 *
 * @returns The absolute path to the library root
 *
 * @example
 * ```typescript
 * const root = getLibraryRoot();
 * // e.g., "/home/user/.agents/skill-library"
 * ```
 *
 * @public
 */
export function getLibraryRoot(): string {
  return getLibrary().libraryRoot;
}
