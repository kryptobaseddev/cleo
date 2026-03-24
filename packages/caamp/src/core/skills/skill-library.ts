/**
 * SkillLibrary interface - SDK standard contract for skill libraries.
 *
 * Any directory or module that conforms to this interface can be registered
 * with CAAMP as a skill library. Both project-bundled libraries and
 * marketplace-installed skills go through this contract.
 */

// ── Types ───────────────────────────────────────────────────────────

/**
 * A single skill entry in a library catalog.
 *
 * @public
 */
export interface SkillLibraryEntry {
  /** Skill name (e.g. `"ct-research-agent"`). */
  name: string;
  /** Human-readable description. */
  description: string;
  /** Semantic version string. */
  version: string;
  /** Relative path within the skills library. */
  path: string;
  /** File references used by the skill. */
  references: string[];
  /** Whether this is a core skill. */
  core: boolean;
  /** Skill category tier. */
  category: "core" | "recommended" | "specialist" | "composition" | "meta";
  /** Numeric tier (0-3). */
  tier: number;
  /** Associated protocol name, or `null`. */
  protocol: string | null;
  /** Direct dependency skill names. */
  dependencies: string[];
  /** Shared resource names this skill uses. */
  sharedResources: string[];
  /** Compatible agent/context types. */
  compatibility: string[];
  /** SPDX license identifier. */
  license: string;
  /** Arbitrary metadata. */
  metadata: Record<string, unknown>;
}

/**
 * Validation result from skill frontmatter validation.
 *
 * @public
 */
export interface SkillLibraryValidationResult {
  /** Whether the skill passed validation (no error-level issues). */
  valid: boolean;
  /** Individual validation issues. */
  issues: SkillLibraryValidationIssue[];
}

/**
 * A single validation issue.
 *
 * @public
 */
export interface SkillLibraryValidationIssue {
  /** Severity level. */
  level: "error" | "warn";
  /** Field that triggered the issue. */
  field: string;
  /** Human-readable message. */
  message: string;
}

/**
 * Profile definition for grouped skill installation.
 *
 * @public
 */
export interface SkillLibraryProfile {
  /** Profile name (e.g. `"minimal"`, `"core"`, `"recommended"`, `"full"`). */
  name: string;
  /** Human-readable description. */
  description: string;
  /** Name of parent profile to extend. */
  extends?: string;
  /** Skill names included in this profile. */
  skills: string[];
  /** Whether to include _shared resources. */
  includeShared?: boolean;
  /** Protocol names to include. */
  includeProtocols: string[];
}

/**
 * Dispatch matrix for task routing to skills.
 *
 * @public
 */
export interface SkillLibraryDispatchMatrix {
  /** Task type to skill mapping. */
  by_task_type: Record<string, string>;
  /** Keyword to skill mapping. */
  by_keyword: Record<string, string>;
  /** Protocol to skill mapping. */
  by_protocol: Record<string, string>;
}

/**
 * Skill entry within the library manifest.
 *
 * @public
 */
export interface SkillLibraryManifestSkill {
  /** Skill name. */
  name: string;
  /** Version. */
  version: string;
  /** Description. */
  description: string;
  /** Path within library. */
  path: string;
  /** Tags. */
  tags: string[];
  /** Status. */
  status: string;
  /** Tier. */
  tier: number;
  /** Token budget. */
  token_budget: number;
  /** References. */
  references: string[];
  /** Capabilities. */
  capabilities: {
    inputs: string[];
    outputs: string[];
    dependencies: string[];
    dispatch_triggers: string[];
    compatible_subagent_types: string[];
    chains_to: string[];
    dispatch_keywords: {
      primary: string[];
      secondary: string[];
    };
  };
  /** Constraints. */
  constraints: {
    max_context_tokens: number;
    requires_session: boolean;
    requires_epic: boolean;
  };
}

/**
 * Full manifest structure for a skill library.
 *
 * @public
 */
export interface SkillLibraryManifest {
  /** JSON schema reference. */
  $schema: string;
  /** Metadata. */
  _meta: Record<string, unknown>;
  /** Dispatch matrix for skill routing. */
  dispatch_matrix: SkillLibraryDispatchMatrix;
  /** Manifest skill entries. */
  skills: SkillLibraryManifestSkill[];
}

// ── Interface ───────────────────────────────────────────────────────

/**
 * Standard interface for a skill library.
 *
 * Any directory or module providing skills must implement this contract.
 * CAAMP uses it to discover, resolve, and install skills from any source.
 *
 * @public
 */
export interface SkillLibrary {
  /** Library version string. */
  readonly version: string;
  /** Absolute path to the library root directory. */
  readonly libraryRoot: string;
  /** All skill entries in the catalog. */
  readonly skills: SkillLibraryEntry[];
  /** The parsed manifest. */
  readonly manifest: SkillLibraryManifest;

  // ── Skill lookup ────────────────────────────────────────────────

  /** List all skill names. */
  listSkills(): string[];
  /** Get skill metadata by name. */
  getSkill(name: string): SkillLibraryEntry | undefined;
  /** Resolve absolute path to a skill's SKILL.md file. */
  getSkillPath(name: string): string;
  /** Resolve absolute path to a skill's directory. */
  getSkillDir(name: string): string;
  /** Read a skill's SKILL.md content as a string. */
  readSkillContent(name: string): string;

  // ── Category & dependency ───────────────────────────────────────

  /** Get all skills where `core === true`. */
  getCoreSkills(): SkillLibraryEntry[];
  /** Get skills filtered by category. */
  getSkillsByCategory(category: SkillLibraryEntry["category"]): SkillLibraryEntry[];
  /** Get direct dependency names for a skill. */
  getSkillDependencies(name: string): string[];
  /** Resolve full dependency tree for a set of skill names (includes transitive deps). */
  resolveDependencyTree(names: string[]): string[];

  // ── Profile-based selection ─────────────────────────────────────

  /** List available profile names. */
  listProfiles(): string[];
  /** Get a profile definition by name. */
  getProfile(name: string): SkillLibraryProfile | undefined;
  /** Resolve a profile to its full skill list (follows extends, resolves deps). */
  resolveProfile(name: string): string[];

  // ── Shared resources ────────────────────────────────────────────

  /** List available shared resource names. */
  listSharedResources(): string[];
  /** Get absolute path to a shared resource file. */
  getSharedResourcePath(name: string): string | undefined;
  /** Read a shared resource file content. */
  readSharedResource(name: string): string | undefined;

  // ── Protocols ───────────────────────────────────────────────────

  /** List available protocol names. */
  listProtocols(): string[];
  /** Get absolute path to a protocol file. */
  getProtocolPath(name: string): string | undefined;
  /** Read a protocol file content. */
  readProtocol(name: string): string | undefined;

  // ── Validation ──────────────────────────────────────────────────

  /** Validate a single skill's frontmatter. */
  validateSkillFrontmatter(name: string): SkillLibraryValidationResult;
  /** Validate all skills. */
  validateAll(): Map<string, SkillLibraryValidationResult>;

  // ── Dispatch ────────────────────────────────────────────────────

  /** Get the dispatch matrix from the manifest. */
  getDispatchMatrix(): SkillLibraryDispatchMatrix;
}
