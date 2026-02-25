// --- Skill Entry (from skills.json) ---

export interface SkillEntry {
  name: string;
  description: string;
  version: string;
  path: string;
  references: string[];
  core: boolean;
  category: 'core' | 'recommended' | 'specialist' | 'composition' | 'meta';
  tier: number;
  protocol: string | null;
  dependencies: string[];
  sharedResources: string[];
  compatibility: string[];
  license: string;
  metadata: Record<string, unknown>;
}

// --- Manifest types ---

export interface ManifestSkill {
  name: string;
  version: string;
  description: string;
  path: string;
  tags: string[];
  status: string;
  tier: number;
  token_budget: number;
  references: string[];
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
  constraints: {
    max_context_tokens: number;
    requires_session: boolean;
    requires_epic: boolean;
  };
}

export interface DispatchMatrix {
  by_task_type: Record<string, string>;
  by_keyword: Record<string, string>;
  by_protocol: Record<string, string>;
}

export interface Manifest {
  $schema: string;
  _meta: Record<string, unknown>;
  dispatch_matrix: DispatchMatrix;
  skills: ManifestSkill[];
}

// --- Profile types ---

export interface ProfileDefinition {
  name: string;
  description: string;
  extends?: string;
  skills: string[];
  includeShared?: boolean;
  includeProtocols: string[];
}

// --- Validation types ---

export interface ValidationIssue {
  level: 'error' | 'warn';
  field: string;
  message: string;
}

export interface ValidationResult {
  valid: boolean;
  issues: ValidationIssue[];
}

// --- Existing exports (preserved) ---

/** All skill entries from skills.json */
export declare const skills: SkillEntry[];

/** Parsed manifest.json dispatch registry */
export declare const manifest: Manifest;

/** Parsed _shared/placeholders.json */
export declare const shared: Record<string, unknown>;

/** List all skill names */
export declare function listSkills(): string[];

/** Get skill metadata from skills.json by name */
export declare function getSkill(name: string): SkillEntry | undefined;

/** Resolve absolute path to a skill's SKILL.md file */
export declare function getSkillPath(name: string): string;

/** Resolve absolute path to a skill's directory */
export declare function getSkillDir(name: string): string;

/** Get the dispatch matrix from manifest.json */
export declare function getDispatchMatrix(): DispatchMatrix;

/** Read a skill's SKILL.md content as a string */
export declare function readSkillContent(name: string): string;

// --- New: Core & Dependency awareness ---

/** Get all skills where core === true */
export declare function getCoreSkills(): SkillEntry[];

/** Get skills filtered by category */
export declare function getSkillsByCategory(category: SkillEntry['category']): SkillEntry[];

/** Get direct dependency names for a skill */
export declare function getSkillDependencies(name: string): string[];

/** Resolve full dependency tree for a set of skill names (includes transitive deps) */
export declare function resolveDependencyTree(names: string[]): string[];

// --- New: Profile-based selection ---

/** List available profile names */
export declare function listProfiles(): string[];

/** Get a profile definition by name */
export declare function getProfile(name: string): ProfileDefinition | undefined;

/** Resolve a profile to its full skill list (follows extends, resolves deps) */
export declare function resolveProfile(name: string): string[];

// --- New: Shared resources ---

/** List available shared resource names (files in _shared/) */
export declare function listSharedResources(): string[];

/** Get absolute path to a shared resource file */
export declare function getSharedResourcePath(name: string): string | undefined;

/** Read a shared resource file content */
export declare function readSharedResource(name: string): string | undefined;

// --- New: Protocols ---

/** List available protocol names */
export declare function listProtocols(): string[];

/** Get absolute path to a protocol file */
export declare function getProtocolPath(name: string): string | undefined;

/** Read a protocol file content */
export declare function readProtocol(name: string): string | undefined;

// --- New: Validation ---

/** Validate a single skill's frontmatter */
export declare function validateSkillFrontmatter(name: string): ValidationResult;

/** Validate all skills, returns Map of name -> ValidationResult */
export declare function validateAll(): Map<string, ValidationResult>;

// --- New: Package metadata ---

/** Package version from package.json */
export declare const version: string;

/** Absolute path to the package root directory */
export declare const libraryRoot: string;
