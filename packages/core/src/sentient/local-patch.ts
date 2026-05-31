/**
 * Local patch applier for the skill auto-improve loop.
 *
 * Sphere B path of the auto-improve flow: when a council pass produces a
 * patch targeting a `user`, `community`, or `agent-created` skill, this
 * module writes the patched files under `~/.cleo/skills/<name>/` and
 * records the patch row in `skill_patches`. Sphere A canonical skills
 * are explicitly OUT of scope — they MUST go through
 * `cleo skill propose-patch` (T9714) which opens a PR against the
 * cleocode repo. The write-guard at `upsertSkillRow` enforces the split.
 *
 * ## Why a separate module from skills-store?
 *
 * `skills-store.ts` is the typed Drizzle adapter for the registry table
 * (`skills`). This module owns filesystem mutations (file writes) +
 * tracking rows in the `skill_patches` table. Keeping them separate
 * makes the package-boundary mapping explicit:
 *
 *   - skills-store     → SDK runtime read/write of registry metadata
 *   - local-patch      → sentient-loop side-effect of an approved review
 *
 * ## Provenance contract
 *
 * All filesystem + DB writes run inside `withProvenance('background-review')`.
 * That tag:
 *
 *   1. Ensures the `skill_patches` row's audit story is reproducible.
 *   2. Trips the T9708 canonical write-guard if a caller mistakenly tries
 *      to apply a patch against a canonical row — the write to the
 *      `skills` row (e.g. bumping `lastUpdatedAt`) is refused, and we
 *      ALSO short-circuit at the top of {@link applyLocalSkillPatch}
 *      with a fast `E_CANONICAL_READ_ONLY` for diagnostic clarity.
 *
 * @task T9715
 * @epic T9563
 * @saga T9560
 * @architecture docs/architecture/SG-CLEO-SKILLS-architecture-v3.md §6-§7
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, normalize, relative, resolve, sep } from 'node:path';
import { eq } from 'drizzle-orm';
import { resolveSkillsRoot } from '../skills/skill-root.js';
import { skillPatches, skills as skillsTable } from '../store/schema/skills-schema.js';
import { E_CANONICAL_READ_ONLY, openSkillsDb } from '../store/skills-db.js';
import { withProvenance } from './skill-provenance.js';

// ---------------------------------------------------------------------------
// Argument + result types
// ---------------------------------------------------------------------------

/**
 * One patched file in an {@link ApplyLocalSkillPatchArgs} payload.
 *
 * `relativePath` is interpreted relative to the skill's root directory
 * (`<skillsRoot>/<skillName>/`). Path-traversal segments (`..`, absolute
 * paths) are rejected with `E_PATCH_PATH_TRAVERSAL`.
 */
export interface PatchedFile {
  /** Path of the file under the skill root (POSIX-style; e.g. `SKILL.md`). */
  readonly relativePath: string;
  /** Full file contents AFTER the patch is applied (UTF-8). */
  readonly contents: string;
}

/**
 * Input bag for {@link applyLocalSkillPatch}.
 */
export interface ApplyLocalSkillPatchArgs {
  /** Skill identifier — matches `skills.name`. */
  readonly skillName: string;
  /**
   * Unified diff bytes (stored verbatim in `skill_patches.diff` for
   * audit + revert). Producing the diff is the caller's responsibility;
   * this module only writes the resulting files.
   */
  readonly diff: string;
  /**
   * The full post-patch contents of every file the patch touches.
   * Empty arrays are rejected with `E_PATCH_EMPTY` — applying an
   * empty patch is almost always a bug at the call site.
   */
  readonly files: readonly PatchedFile[];
  /**
   * Optional foreign key (logical) to `skill_reviews.id` that produced
   * this patch. Populated by the daemon when an approved review flows
   * directly into a local apply.
   */
  readonly reviewId?: number;
  /**
   * Override the resolved user-skills root for testing. Production
   * callers leave this unset — the default is {@link resolveSkillsRoot}.
   */
  readonly skillsRootOverride?: string;
}

/**
 * Result envelope returned by {@link applyLocalSkillPatch}.
 */
export interface ApplyLocalSkillPatchResult {
  /** Server-assigned id of the `skill_patches` row that was inserted. */
  readonly patchId: number;
  /** ISO-8601 timestamp the patch was applied to disk (server-side `datetime('now')`). */
  readonly appliedAt: string;
  /** Absolute paths of every file the apply touched. */
  readonly writtenPaths: readonly string[];
  /** The resolved root the patch was written under (handy for logging). */
  readonly skillsRoot: string;
}

// ---------------------------------------------------------------------------
// Error codes
// ---------------------------------------------------------------------------

/** `files` was empty — patch payload is malformed. */
export const E_PATCH_EMPTY = 'E_PATCH_EMPTY';

/** A `relativePath` escaped the skill root via `..` or absolute path. */
export const E_PATCH_PATH_TRAVERSAL = 'E_PATCH_PATH_TRAVERSAL';

/** Target skill row in `skills.db` was not found — won't blindly create one. */
export const E_PATCH_SKILL_NOT_FOUND = 'E_PATCH_SKILL_NOT_FOUND';

// ---------------------------------------------------------------------------
// Apply
// ---------------------------------------------------------------------------

/**
 * Apply an auto-improve patch to a Sphere B skill under `~/.cleo/skills/`.
 *
 * The function:
 *
 *   1. Resolves the skills root (with the optional `skillsRootOverride`).
 *   2. Looks up the row in `skills.db`; if the row is missing or its
 *      `sourceType === 'canonical'`, it refuses immediately
 *      (`E_PATCH_SKILL_NOT_FOUND` or `E_CANONICAL_READ_ONLY`).
 *   3. Validates every `files[i].relativePath` against path traversal.
 *   4. Inside `withProvenance('background-review')`:
 *      a. Writes the files to `<skillsRoot>/<skillName>/<relativePath>`.
 *      b. Inserts a `skill_patches` row with `status='applied'`.
 *      c. Bumps `skills.lastUpdatedAt` so subsequent listings reflect
 *         the change.
 *
 * The write-guard at `upsertSkillRow` does NOT fire for `user`,
 * `community`, or `agent-created` rows — those are exactly the Sphere B
 * rows this function is allowed to mutate.
 *
 * @param args - See {@link ApplyLocalSkillPatchArgs}.
 * @returns The result envelope (patch id, applied-at, written paths).
 *
 * @example
 * ```typescript
 * const result = await applyLocalSkillPatch({
 *   skillName: 'my-user-skill',
 *   diff: '--- a/SKILL.md\n+++ b/SKILL.md\n@@ ...',
 *   files: [{ relativePath: 'SKILL.md', contents: '# updated\n' }],
 * });
 * console.log(`Applied ${result.patchId} → ${result.writtenPaths[0]}`);
 * ```
 *
 * @task T9715
 */
export async function applyLocalSkillPatch(
  args: ApplyLocalSkillPatchArgs,
): Promise<ApplyLocalSkillPatchResult> {
  if (args.files.length === 0) {
    const err: Error & { code?: string } = new Error(
      `${E_PATCH_EMPTY}: patch for skill='${args.skillName}' carries no files`,
    );
    err.code = E_PATCH_EMPTY;
    throw err;
  }

  const skillsRoot = args.skillsRootOverride ?? resolveSkillsRoot();
  const skillDir = join(skillsRoot, args.skillName);

  // Validate every path against traversal up-front so we never write a
  // partial patch.
  for (const file of args.files) {
    assertSafeRelativePath(skillDir, file.relativePath);
  }

  const db = await openSkillsDb();

  // Look up the target row — refuse if missing or canonical. The
  // canonical refusal is also enforced at the DB write site (T9708);
  // we short-circuit here for a clearer error message and to avoid
  // touching disk before the guard fires.
  const existing = db
    .select()
    .from(skillsTable)
    .where(eq(skillsTable.name, args.skillName))
    .limit(1)
    .all();
  const row = existing[0];
  if (!row) {
    const err: Error & { code?: string } = new Error(
      `${E_PATCH_SKILL_NOT_FOUND}: no skills.db row for name='${args.skillName}'`,
    );
    err.code = E_PATCH_SKILL_NOT_FOUND;
    throw err;
  }
  if (row.sourceType === 'canonical') {
    const err: Error & { code?: string } = new Error(
      `${E_CANONICAL_READ_ONLY}: refusing local-patch apply for canonical skill='${args.skillName}'. ` +
        'Use `cleo skill propose-patch` to open a PR against the cleocode repo instead.',
    );
    err.code = E_CANONICAL_READ_ONLY;
    throw err;
  }

  return withProvenance('background-review', async () => {
    const writtenPaths: string[] = [];
    for (const file of args.files) {
      const absPath = resolve(skillDir, file.relativePath);
      mkdirSync(dirname(absPath), { recursive: true });
      writeFileSync(absPath, file.contents, 'utf8');
      writtenPaths.push(absPath);
    }

    const insertValues: typeof skillPatches.$inferInsert = {
      skillName: args.skillName,
      diff: args.diff,
      status: 'applied',
      appliedAt: new Date().toISOString(),
      ...(args.reviewId !== undefined ? { reviewId: args.reviewId } : {}),
    };
    const inserted = db.insert(skillPatches).values(insertValues).returning().all();
    const patchRow = inserted[0];
    if (!patchRow) {
      /* c8 ignore next */
      throw new Error(
        `applyLocalSkillPatch: INSERT returned no rows for skill='${args.skillName}'`,
      );
    }

    // Bump lastUpdatedAt on the skills row. This is a Sphere B (non-canonical)
    // write so it flows through the guard without trouble.
    const now = new Date().toISOString();
    db.update(skillsTable)
      .set({ lastUpdatedAt: now })
      .where(eq(skillsTable.name, args.skillName))
      .run();

    return {
      patchId: patchRow.id,
      appliedAt: patchRow.appliedAt ?? now,
      writtenPaths,
      skillsRoot,
    };
  });
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Refuse path-traversal — `..` segments or absolute paths.
 *
 * Throws with `E_PATCH_PATH_TRAVERSAL` when the resolved absolute path
 * would land outside the skill directory. The resolve+relative dance is
 * intentional — we want to catch both literal `..` segments and tricks
 * like symlinks that resolve outside the dir.
 *
 * @internal
 */
function assertSafeRelativePath(skillDir: string, relativePath: string): void {
  if (relativePath.length === 0 || isAbsolute(relativePath)) {
    const err: Error & { code?: string } = new Error(
      `${E_PATCH_PATH_TRAVERSAL}: refusing absolute/empty path='${relativePath}'`,
    );
    err.code = E_PATCH_PATH_TRAVERSAL;
    throw err;
  }
  const normalised = normalize(relativePath);
  const resolved = resolve(skillDir, normalised);
  const rel = relative(skillDir, resolved);
  if (rel.length === 0 || rel.startsWith('..') || rel.split(sep).includes('..')) {
    const err: Error & { code?: string } = new Error(
      `${E_PATCH_PATH_TRAVERSAL}: path='${relativePath}' escapes skill dir`,
    );
    err.code = E_PATCH_PATH_TRAVERSAL;
    throw err;
  }
}
