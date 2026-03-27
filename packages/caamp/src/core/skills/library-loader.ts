/**
 * Library loader - loads a SkillLibrary from a directory or module.
 *
 * Two strategies:
 * 1. loadLibraryFromModule() - for libraries with an index.js exporting SkillLibrary
 * 2. buildLibraryFromFiles() - for plain directories with the right file structure
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { basename, dirname, join } from 'node:path';
import type {
  SkillLibrary,
  SkillLibraryDispatchMatrix,
  SkillLibraryEntry,
  SkillLibraryManifest,
  SkillLibraryProfile,
  SkillLibraryValidationIssue,
  SkillLibraryValidationResult,
} from './skill-library.js';

const require = createRequire(import.meta.url);

/**
 * Load a SkillLibrary from a module (index.js) at the given root directory.
 *
 * @remarks
 * Uses `createRequire()` for CJS modules or dynamic `import()` for ESM.
 * Validates that the loaded module implements the SkillLibrary interface
 * by checking for required properties and methods.
 *
 * @param root - Absolute path to the library root (must contain index.js or package.json with main)
 * @returns A validated SkillLibrary instance
 * @throws If the module cannot be loaded or does not implement SkillLibrary
 *
 * @example
 * ```typescript
 * const library = loadLibraryFromModule("/home/user/.agents/libraries/ct-skills");
 * console.log(`Loaded v${library.version} with ${library.listSkills().length} skills`);
 * ```
 *
 * @public
 */
export function loadLibraryFromModule(root: string): SkillLibrary {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let mod: any;

  try {
    mod = require(root);
  } catch {
    throw new Error(`Failed to load skill library module from ${root}`);
  }

  // Validate required properties
  const requiredMethods = [
    'listSkills',
    'getSkill',
    'getSkillPath',
    'getSkillDir',
    'readSkillContent',
    'getCoreSkills',
    'getSkillsByCategory',
    'getSkillDependencies',
    'resolveDependencyTree',
    'listProfiles',
    'getProfile',
    'resolveProfile',
    'listSharedResources',
    'getSharedResourcePath',
    'readSharedResource',
    'listProtocols',
    'getProtocolPath',
    'readProtocol',
    'validateSkillFrontmatter',
    'validateAll',
    'getDispatchMatrix',
  ];

  for (const method of requiredMethods) {
    if (typeof mod[method] !== 'function') {
      throw new Error(`Skill library at ${root} does not implement required method: ${method}`);
    }
  }

  if (!mod.version || typeof mod.version !== 'string') {
    throw new Error(`Skill library at ${root} is missing 'version' property`);
  }

  if (!mod.libraryRoot || typeof mod.libraryRoot !== 'string') {
    throw new Error(`Skill library at ${root} is missing 'libraryRoot' property`);
  }

  return mod as SkillLibrary;
}

/**
 * Build a SkillLibrary from raw files in a directory.
 *
 * @remarks
 * Constructs a full SkillLibrary implementation by reading:
 * - `skills.json` for catalog entries
 * - `skills/manifest.json` for dispatch matrix
 * - `profiles/*.json` for profile definitions
 * - `skills/<name>/SKILL.md` for skill content
 * - `skills/_shared/*.md` for shared resources
 * - `protocols/*.md` or `skills/protocols/*.md` for protocol files
 *
 * @param root - Absolute path to the library root directory
 * @returns A SkillLibrary instance backed by filesystem reads
 * @throws If skills.json is not found at the root
 *
 * @example
 * ```typescript
 * const library = buildLibraryFromFiles("/home/user/.agents/libraries/ct-skills");
 * const coreSkills = library.getCoreSkills();
 * console.log(`Core skills: ${coreSkills.map(s => s.name).join(", ")}`);
 * ```
 *
 * @public
 */
export function buildLibraryFromFiles(root: string): SkillLibrary {
  const catalogPath = join(root, 'skills.json');
  if (!existsSync(catalogPath)) {
    throw new Error(`No skills.json found at ${root}`);
  }

  const catalogData = JSON.parse(readFileSync(catalogPath, 'utf-8'));
  const entries: SkillLibraryEntry[] = catalogData.skills ?? [];
  const version: string = catalogData.version ?? '0.0.0';

  // Load manifest
  const manifestPath = join(root, 'skills', 'manifest.json');
  let manifest: SkillLibraryManifest;
  if (existsSync(manifestPath)) {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
  } else {
    manifest = {
      $schema: '',
      _meta: {},
      dispatch_matrix: { by_task_type: {}, by_keyword: {}, by_protocol: {} },
      skills: [],
    };
  }

  // Load profiles
  const profilesDir = join(root, 'profiles');
  const profiles = new Map<string, SkillLibraryProfile>();
  if (existsSync(profilesDir)) {
    for (const file of readdirSync(profilesDir)) {
      if (!file.endsWith('.json')) continue;
      try {
        const profile: SkillLibraryProfile = JSON.parse(
          readFileSync(join(profilesDir, file), 'utf-8'),
        );
        profiles.set(profile.name, profile);
      } catch {
        // Skip invalid profiles
      }
    }
  }

  // Build skill lookup map
  const skillMap = new Map<string, SkillLibraryEntry>();
  for (const entry of entries) {
    skillMap.set(entry.name, entry);
  }

  // ── Helper functions ──────────────────────────────────────────────

  function getSkillDir(name: string): string {
    const entry = skillMap.get(name);
    if (entry) {
      return dirname(join(root, entry.path));
    }
    return join(root, 'skills', name);
  }

  function resolveDeps(names: string[], visited = new Set<string>()): string[] {
    const result: string[] = [];
    for (const name of names) {
      if (visited.has(name)) continue;
      visited.add(name);

      const entry = skillMap.get(name);
      if (entry && entry.dependencies.length > 0) {
        result.push(...resolveDeps(entry.dependencies, visited));
      }
      result.push(name);
    }
    return result;
  }

  function resolveProfileByName(name: string, visited = new Set<string>()): string[] {
    if (visited.has(name)) return [];
    visited.add(name);

    const profile = profiles.get(name);
    if (!profile) return [];

    let skills: string[] = [];
    if (profile.extends) {
      skills = resolveProfileByName(profile.extends, visited);
    }
    skills.push(...profile.skills);

    // Resolve dependencies for all skills
    return resolveDeps([...new Set(skills)]);
  }

  function discoverFiles(dir: string, ext: string): string[] {
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .filter((f) => f.endsWith(ext))
      .map((f) => basename(f, ext));
  }

  // ── Build the library object ──────────────────────────────────────

  const library: SkillLibrary = {
    version,
    libraryRoot: root,
    skills: entries,
    manifest,

    listSkills(): string[] {
      return entries.map((e) => e.name);
    },

    getSkill(name: string): SkillLibraryEntry | undefined {
      return skillMap.get(name);
    },

    getSkillPath(name: string): string {
      const entry = skillMap.get(name);
      if (entry) {
        return join(root, entry.path);
      }
      return join(root, 'skills', name, 'SKILL.md');
    },

    getSkillDir,

    readSkillContent(name: string): string {
      const skillPath = library.getSkillPath(name);
      if (!existsSync(skillPath)) {
        throw new Error(`Skill content not found: ${skillPath}`);
      }
      return readFileSync(skillPath, 'utf-8');
    },

    getCoreSkills(): SkillLibraryEntry[] {
      return entries.filter((e) => e.core);
    },

    getSkillsByCategory(category: SkillLibraryEntry['category']): SkillLibraryEntry[] {
      return entries.filter((e) => e.category === category);
    },

    getSkillDependencies(name: string): string[] {
      return skillMap.get(name)?.dependencies ?? [];
    },

    resolveDependencyTree(names: string[]): string[] {
      return resolveDeps(names);
    },

    listProfiles(): string[] {
      return [...profiles.keys()];
    },

    getProfile(name: string): SkillLibraryProfile | undefined {
      return profiles.get(name);
    },

    resolveProfile(name: string): string[] {
      return resolveProfileByName(name);
    },

    listSharedResources(): string[] {
      return discoverFiles(join(root, 'skills', '_shared'), '.md');
    },

    getSharedResourcePath(name: string): string | undefined {
      const resourcePath = join(root, 'skills', '_shared', `${name}.md`);
      return existsSync(resourcePath) ? resourcePath : undefined;
    },

    readSharedResource(name: string): string | undefined {
      const resourcePath = library.getSharedResourcePath(name);
      if (!resourcePath) return undefined;
      return readFileSync(resourcePath, 'utf-8');
    },

    listProtocols(): string[] {
      // Check root protocols/ first (ct-skills layout), fall back to skills/protocols/
      const rootProtocols = discoverFiles(join(root, 'protocols'), '.md');
      if (rootProtocols.length > 0) return rootProtocols;
      return discoverFiles(join(root, 'skills', 'protocols'), '.md');
    },

    getProtocolPath(name: string): string | undefined {
      // Check root protocols/ first, fall back to skills/protocols/
      const rootPath = join(root, 'protocols', `${name}.md`);
      if (existsSync(rootPath)) return rootPath;
      const skillsPath = join(root, 'skills', 'protocols', `${name}.md`);
      return existsSync(skillsPath) ? skillsPath : undefined;
    },

    readProtocol(name: string): string | undefined {
      const protocolPath = library.getProtocolPath(name);
      if (!protocolPath) return undefined;
      return readFileSync(protocolPath, 'utf-8');
    },

    validateSkillFrontmatter(name: string): SkillLibraryValidationResult {
      const entry = skillMap.get(name);
      if (!entry) {
        return {
          valid: false,
          issues: [{ level: 'error', field: 'name', message: `Skill not found: ${name}` }],
        };
      }

      const issues: SkillLibraryValidationIssue[] = [];

      if (!entry.name) {
        issues.push({ level: 'error', field: 'name', message: 'Missing name' });
      }
      if (!entry.description) {
        issues.push({ level: 'error', field: 'description', message: 'Missing description' });
      }
      if (!entry.version) {
        issues.push({ level: 'warn', field: 'version', message: 'Missing version' });
      }

      // Check SKILL.md exists
      const skillPath = join(root, entry.path);
      if (!existsSync(skillPath)) {
        issues.push({
          level: 'error',
          field: 'path',
          message: `SKILL.md not found at ${entry.path}`,
        });
      }

      return {
        valid: !issues.some((i) => i.level === 'error'),
        issues,
      };
    },

    validateAll(): Map<string, SkillLibraryValidationResult> {
      const results = new Map<string, SkillLibraryValidationResult>();
      for (const entry of entries) {
        results.set(entry.name, library.validateSkillFrontmatter(entry.name));
      }
      return results;
    },

    getDispatchMatrix(): SkillLibraryDispatchMatrix {
      return manifest.dispatch_matrix;
    },
  };

  return library;
}
