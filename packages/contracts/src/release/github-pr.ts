/**
 * GitHub PR contracts — types describing the PR-creation surface used by
 * the release pipeline.
 *
 * The implementation lives in `@cleocode/core/release/github-pr.ts`. The
 * types live here so consumers (CLI, studio, downstream tools) can describe
 * / validate the same shapes without depending on core.
 *
 * @adr ADR-063
 */

import type { ReleaseChannel } from './channel.js';

/** Outcome of `detectBranchProtection`. */
export interface BranchProtectionResult {
  protected: boolean;
  detectionMethod: 'gh-api' | 'push-dry-run' | 'unknown';
  error?: string;
}

/** Input to `createPullRequest`. */
export interface PRCreateOptions {
  base: string;
  head: string;
  title: string;
  body: string;
  /**
   * Requested PR labels. Non-existent ones are filtered or auto-created by
   * the resolver; the engine never passes a bare list to `gh pr create`.
   */
  labels?: string[];
  version: string;
  epicId?: string;
  projectRoot?: string;
}

/** How a PR-create attempt resolved. */
export type PRMode = 'created' | 'manual' | 'skipped';

/** Outcome of `createPullRequest`. */
export interface PRResult {
  mode: PRMode;
  prUrl?: string;
  prNumber?: number;
  instructions?: string;
  error?: string;
}

/** Parsed `owner/repo` pair extracted from a git remote URL. */
export interface RepoIdentity {
  owner: string;
  repo: string;
}

/**
 * Names of the labels CLEO knows how to auto-create when they are missing
 * on a repo. Includes the universal `release` flag plus one label per npm
 * dist-tag channel.
 */
export type CleoKnownLabel = 'release' | ReleaseChannel;

/** Color + description used when CLEO auto-creates one of its known labels. */
export interface LabelDefinition {
  color: string;
  description: string;
}

/** Static palette of CLEO-known labels keyed by label name. */
export type CleoLabelPalette = Readonly<Record<CleoKnownLabel, LabelDefinition>>;

/** Outcome of {@link ensureCleoLabelsExist}. */
export interface LabelEnsureResult {
  /** Labels that exist on the repo after this call (pre-existed or auto-created). */
  ensured: string[];
  /** Labels that this call created. */
  created: string[];
  /** Labels that could not be ensured (unknown to CLEO, or `gh label create` failed). */
  missing: string[];
}

/** Outcome of {@link resolvePRLabels} — what to actually pass to `gh pr create`. */
export interface PRLabelResolution {
  /** Labels safe to pass to `gh pr create`. */
  labels: string[];
  /** Labels auto-created during resolution. */
  created: string[];
  /** Labels dropped because they could not be ensured. */
  missing: string[];
}
