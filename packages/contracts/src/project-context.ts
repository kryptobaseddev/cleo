/**
 * Project context — canonical ecosystem detection types.
 *
 * Defines the shape of `.cleo/project-context.json` and the smaller hint
 * envelope consumed by release-flow / spawn-engine / codebase-map analyzers.
 *
 * Type-only: the detector implementation lives in `@cleocode/core/store/
 * project-detect.ts`. Centralising the types here lets any package (release,
 * studio, agents, …) reason about ecosystem signals without importing core.
 *
 * @adr ADR-013
 */

/** Detected project ecosystem. Matches the writer in `detectProjectType`. */
export type ProjectType =
  | 'node'
  | 'python'
  | 'rust'
  | 'go'
  | 'ruby'
  | 'java'
  | 'dotnet'
  | 'bash'
  | 'elixir'
  | 'php'
  | 'deno'
  | 'bun'
  | 'unknown';

/** Detected test framework. */
export type TestFramework =
  | 'jest'
  | 'vitest'
  | 'mocha'
  | 'pytest'
  | 'bats'
  | 'cargo'
  | 'go'
  | 'rspec'
  | 'junit'
  | 'playwright'
  | 'cypress'
  | 'ava'
  | 'uvu'
  | 'tap'
  | 'node:test'
  | 'deno'
  | 'bun'
  | 'custom'
  | 'unknown';

/** File-naming convention detected from source files. */
export type FileNamingConvention = 'kebab-case' | 'snake_case' | 'camelCase' | 'PascalCase';

/** Module import style. */
export type ImportStyle = 'esm' | 'commonjs' | 'mixed';

/**
 * Evidence execution configured per project.
 *
 * @task T12308
 */
export interface ProjectEvidenceContext {
  /**
   * Checkout that `git`/`gh` evidence tools must run in, relative to the CLEO
   * store root (an absolute path is also accepted).
   *
   * Needed only when the store root is not itself a git work tree AND parents
   * more than one repository — CLEO resolves a single nested checkout, and a
   * `commit:` atom whose SHA exists in exactly one sibling, without help.
   */
  gitRoot?: string;
  /**
   * Accept required CI green on a merged PR's merge commit as `testsPassed` /
   * `qaPassed` evidence (`ci:<pr>` atom, owner decision D11149). Only `true`
   * enables it.
   *
   * @task T12634
   */
  ciSatisfies?: boolean;
  /**
   * Which required checks attest each gate for `ci:<pr>`. Each list must be a
   * subset of the required-check list; a gate without a list refuses `ci:`.
   *
   * @task T12634
   */
  ciChecks?: { tests?: string[]; qa?: string[] };
}

/**
 * A required check named in `release.prRequiredWorkflows`, optionally pinned to
 * the GitHub App that must post it and (for a workflow) its workflow file, so a
 * same-named check from another app never counts (T12634).
 */
export interface RequiredCheckPin {
  /** Check-run (job) or workflow name. */
  name: string;
  /** GitHub App slug (e.g. `github-actions`) or numeric app id. */
  app?: string | number;
  /** Workflow file path (e.g. `.github/workflows/ci.yml`). */
  workflow?: string;
}

/** Release and evidence behavior configured per project. */
export interface ProjectReleaseContext {
  /** Branches whose reachable commits may satisfy `commit:` evidence atoms. */
  integrationBranches?: string[];
  /** Required successful checks for `pr:` / `ci:` evidence atoms; an entry may pin its app/workflow. */
  prRequiredWorkflows?: Array<string | RequiredCheckPin>;
}

/** Schema-compliant project context for LLM agent consumption. */
export interface ProjectContext {
  schemaVersion: string;
  detectedAt: string;
  projectTypes: ProjectType[];
  primaryType?: ProjectType;
  monorepo: boolean;
  testing?: {
    framework?: TestFramework;
    command?: string;
    testFilePatterns?: string[];
    directories?: {
      unit?: string;
      integration?: string;
    };
  };
  build?: {
    command?: string;
    outputDir?: string;
  };
  directories?: {
    source?: string;
    tests?: string;
    docs?: string;
  };
  conventions?: {
    fileNaming?: FileNamingConvention;
    importStyle?: ImportStyle;
    typeSystem?: string;
  };
  llmHints?: {
    preferredTestStyle?: string;
    typeSystem?: string;
    commonPatterns?: string[];
    avoidPatterns?: string[];
  };
  /** Lint command override (T12026). */
  lint?: {
    /** Command to run static analysis / lint checks. */
    command?: string;
  };
  /** Type-check command override (T12026). */
  typecheck?: {
    /** Command to run type checking. */
    command?: string;
  };
  /** Audit command override (T12026). */
  audit?: {
    /** Command to run dependency/module audit checks. */
    command?: string;
  };
  /** Security-scan command override (T12026). JSON key is `security-scan`. */
  'security-scan'?: {
    /** Command to run security vulnerability scanning. */
    command?: string;
  };
  /** Release and evidence behavior for this project. */
  release?: ProjectReleaseContext;
  /** Evidence execution overrides for this project (T12308). */
  evidence?: ProjectEvidenceContext;
}

/**
 * Narrow subset of {@link ProjectContext} consumed by the release engine's
 * workspace discovery and other ecosystem-aware flows. Avoid passing the
 * full {@link ProjectContext} when only the three discriminating fields are
 * needed.
 */
export interface EcosystemHint {
  primaryType?: ProjectType;
  projectTypes?: ProjectType[];
  monorepo?: boolean;
}
