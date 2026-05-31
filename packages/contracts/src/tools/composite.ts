/**
 * Composite meta-tool contracts — typed I/O shapes for repo-structure
 * velocity-multiplier tools (T11484 · DHQ-027/032 · E-CORE-SELF-TOOLING).
 *
 * A **composite tool** COMPOSES atomic primitives (`@cleocode/contracts/tools/
 * atomic` — fs/shell/search) plus repo-structure knowledge into one guarded,
 * deterministic, multi-step operation that runs WITHOUT an LLM and returns a
 * typed result. Per the TOOL-vs-SKILL discriminator (T11456 epic), that makes
 * these TOOLs (typed return, no agent reasoning), NOT skills (`packages/skills`
 * markdown capabilities).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * PLACEMENT STATUS (read before implementing the runtime)
 * ─────────────────────────────────────────────────────────────────────────────
 * These are the CONTRACTS ONLY. The runtime implementations are intentionally
 * DEFERRED to epic **T11456** (TOOLS canonical structure), because a composite
 * tool cannot be CORRECTLY placed/named/registered until T11456 lands:
 *
 *   - The atomic-tool boundary (`ATOMIC_TOOL_BOUNDARY` in `boundary.ts`, CI
 *     Gate 11) restricts `packages/core/src/tools/` to ATOMIC, STATELESS
 *     primitives (the 5 `TOOL_CLASSES`: fs/shell/search/net/notebook). These
 *     composites are multi-step and repo-structure-aware — NOT atomic primitives
 *     — so that home is wrong for them.
 *   - `packages/skills/` (the boundary's `skillsHome`) holds agent-facing
 *     SKILL.md markdown, not executable TS — also wrong.
 *   - T11456 defines the missing structure these tools NEED: a closed
 *     `ToolCategory` enum (it reserves `vcs`/`workflow`/`agent` — the categories
 *     these compose), strict `<scope>_<category>_<operation>` naming, a
 *     `ToolDescriptor` zod schema, and a `ToolRegistry` with project>global>core
 *     precedence. Authoring the runtime + a category BEFORE that epic would
 *     force a placement T11456 must then rework.
 *
 * Shipping the contracts now is the sound, additive, non-blocked unit: it pins
 * the I/O shape (and enumerates every breakage/wiring class each tool owns) so
 * the T11456 registry has a stable surface to register against. Types-only — no
 * runtime logic (CI Gate 10 `contracts-purity`).
 *
 * @epic T11480
 * @task T11484
 * @see T11456 — TOOLS canonical structure (runtime home + registry + naming)
 */

// ---------------------------------------------------------------------------
// module-relocation (DHQ-032)
// ---------------------------------------------------------------------------

/**
 * The seven breakage classes a module relocation MUST repair atomically. A
 * naive `git mv` fixes none of these; leaving any one unrepaired is a red build.
 * The runtime asserts each class is handled and reports per-class edit counts.
 */
export const MODULE_RELOCATION_BREAKAGE_CLASSES = [
  /** Relative-import depth (`../` vs `../../`) of the moved file's own imports. */
  'relative-import-depth',
  /** Barrel (`index.ts`) re-exports that referenced the old path. */
  'barrels',
  /** `.js`-suffixed specifiers AND dynamic `import()` specifiers. */
  'js-form-and-dynamic-import',
  /** The mirrored `__tests__/` directory for the moved module. */
  'mirror-test-dirs',
  /** `deprecations.yml` entries that pointed at the old path. */
  'deprecations-yml',
  /** Doc comments / `@see` / `@module` references to the old path. */
  'doc-comments',
  /** Cross-package importers that consumed the module via its package path. */
  'cross-package-importers',
] as const;

/** One of the {@link MODULE_RELOCATION_BREAKAGE_CLASSES}. */
export type ModuleRelocationBreakageClass = (typeof MODULE_RELOCATION_BREAKAGE_CLASSES)[number];

/** Input for the `module-relocation` composite tool. */
export interface ModuleRelocationInput {
  /** Absolute (or repo-root-relative) path of the module to move. */
  readonly fromPath: string;
  /** Destination path for the module. */
  readonly toPath: string;
  /** Repository root the operation is scoped to. */
  readonly repoRoot: string;
  /**
   * Leave a re-export shim at {@link ModuleRelocationInput.fromPath} that
   * re-exports from the new location (for a deprecation cycle) instead of
   * rewriting every importer. Defaults to `false` (rewrite importers).
   */
  readonly leaveShim?: boolean;
  /** Preview the edit plan without writing. Defaults to `false`. */
  readonly dryRun?: boolean;
}

/** Per-class summary of the edits a relocation made (or would make). */
export interface ModuleRelocationClassReport {
  /** Which breakage class this entry summarises. */
  readonly class: ModuleRelocationBreakageClass;
  /** Repo-relative files edited for this class. */
  readonly files: readonly string[];
  /** Total number of edits applied across {@link ModuleRelocationClassReport.files}. */
  readonly edits: number;
}

/** Result of a `module-relocation` run. */
export interface ModuleRelocationResult {
  /** The module's new path. */
  readonly toPath: string;
  /** Whether a re-export shim was left at the old path. */
  readonly shimLeft: boolean;
  /** Whether this was a dry-run (no writes performed). */
  readonly dryRun: boolean;
  /** Per-breakage-class edit report (one entry per class, even when empty). */
  readonly classes: readonly ModuleRelocationClassReport[];
  /** Total repo-relative files touched across every class. */
  readonly filesTouched: readonly string[];
}

// ---------------------------------------------------------------------------
// add-workspace-package (DHQ-027)
// ---------------------------------------------------------------------------

/**
 * The six wiring points a new workspace leaf MUST be threaded through. Missing
 * any one yields a package that does not build, is not type-resolved, or is
 * accidentally published. The runtime wires all six and reports each.
 */
export const ADD_WORKSPACE_PACKAGE_WIRING_POINTS = [
  /** `dependencies` / `devDependencies` of consuming packages. */
  'deps',
  /** The three `tsconfig` references: root refs, build tsconfig, path mapping. */
  'tsconfig-refs',
  /** The `buildPkg(...)` entry in the root `build.mjs` topological wave plan. */
  'build-mjs-buildpkg',
  /** esbuild/tsc inline source-map wiring for the new leaf. */
  'inline-maps',
  /** The `BOUNDARY_REGISTRY` entry in `packages/contracts/src/boundary.ts`. */
  'boundary-entry',
  /** `private: true` + no published README (internal-leaf publish hygiene). */
  'private-no-readme',
] as const;

/** One of the {@link ADD_WORKSPACE_PACKAGE_WIRING_POINTS}. */
export type AddWorkspacePackageWiringPoint = (typeof ADD_WORKSPACE_PACKAGE_WIRING_POINTS)[number];

/** Input for the `add-workspace-package` composite tool. */
export interface AddWorkspacePackageInput {
  /** Scoped package name, e.g. `@cleocode/foo`. */
  readonly packageName: string;
  /** Directory under `packages/` to create (defaults to the unscoped name). */
  readonly dirName?: string;
  /** Repository root the operation is scoped to. */
  readonly repoRoot: string;
  /** Packages that should depend on the new leaf (wires the `deps` point). */
  readonly consumers?: readonly string[];
  /** Preview the wiring plan without writing. Defaults to `false`. */
  readonly dryRun?: boolean;
}

/** Per-point summary of how a wiring point was satisfied. */
export interface AddWorkspacePackageWiringReport {
  /** Which wiring point this entry summarises. */
  readonly point: AddWorkspacePackageWiringPoint;
  /** Repo-relative files created or edited for this point. */
  readonly files: readonly string[];
}

/** Result of an `add-workspace-package` run. */
export interface AddWorkspacePackageResult {
  /** The created package's name. */
  readonly packageName: string;
  /** Repo-relative directory of the new leaf. */
  readonly packageDir: string;
  /** Whether this was a dry-run (no writes performed). */
  readonly dryRun: boolean;
  /** Per-wiring-point report (one entry per point, even when empty). */
  readonly points: readonly AddWorkspacePackageWiringReport[];
}
