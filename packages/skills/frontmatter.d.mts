/**
 * Types for `@cleocode/skills/frontmatter.mjs` — the SKILL.md frontmatter
 * rules shared by gate 29 and `cleo skills validate` (T12655).
 */

/** Tag-like text the Agent Skills standard rejects. */
export declare const TAG_PATTERN: RegExp;
/** Allowed `metadata.tier` values. */
export declare const SKILL_TIERS: readonly ['core', 'on-demand', 'internal'];
/** Allowed `metadata.install` values. */
export declare const SKILL_INSTALL_MODES: readonly ['harness', 'internal'];
/** Allowed `metadata.stability` values. */
export declare const SKILL_STABILITIES: readonly ['experimental', 'stable', 'deprecated'];
/** Numeric tier written into manifest entries. */
export declare const TIER_NUMBER: { readonly core: 0; readonly 'on-demand': 1; readonly internal: 3 };
/** CAAMP catalogue `category` derived from the tier. */
export declare const CATEGORY_FOR_TIER: {
  readonly core: 'core';
  readonly 'on-demand': 'recommended';
  readonly internal: 'meta';
};
/** Top-level keys a SKILL.md may not declare (derived from `metadata.tier`). */
export declare const DERIVED_TOP_LEVEL_KEYS: readonly ['tier', 'core', 'category'];
/** Top-level keys that moved under `metadata:`. */
export declare const MOVED_TO_METADATA_KEYS: readonly ['loomStage'];
/** Maximum `description` length accepted by harness skill loaders. */
export declare const MAX_DESCRIPTION_LENGTH: 1024;

/** Parsed SKILL.md frontmatter. */
export interface ParsedFrontmatter {
  /** No parse errors. */
  ok: boolean;
  /** Top-level scalars (block scalars folded to one line). */
  fields: Record<string, string>;
  /** The nested `metadata:` map. */
  metadata: Record<string, string>;
  /** Lists nested under `metadata:` (e.g. `covers`). */
  metadataLists: Record<string, string[]>;
  /** Top-level block and inline lists. */
  lists: Record<string, string[]>;
  /** Every top-level key in order, duplicates included. */
  keys: string[];
  /** Parse errors. */
  errors: string[];
}

/** Parse SKILL.md text into its frontmatter. */
export declare function parseFrontmatter(text: string): ParsedFrontmatter;

/**
 * Validate one bundled skill's frontmatter against the CLEO contract.
 *
 * @param fm - Parsed frontmatter plus `name`, the skill's directory name.
 * @param ctx - `loomStages` enables the `metadata.loomStage` binding check.
 * @returns Human-readable problems (empty when valid).
 */
export declare function validateFrontmatter(
  fm: ParsedFrontmatter & { name: string },
  ctx?: { loomStages?: Map<string, string> },
): string[];
