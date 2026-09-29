/**
 * SKILL.md frontmatter reader — the metadata source of truth for canonical
 * skills (spec `skills-curation-and-automation` §3.1, owner decision D11157).
 *
 * Every canonical skill declares its catalogue metadata in its own SKILL.md:
 *
 * ```yaml
 * ---
 * name: ct-example            # MUST equal the directory name
 * description: ...            # <= 1024 characters
 * metadata:
 *   version: 1.2.0            # the ONE version; a top-level `version:`, if kept
 *                             # for older readers, must equal it
 *   tier: core                # core | on-demand | internal
 *   install: harness          # harness | internal
 *   lastReviewed: 2026-09-28
 *   stability: stable         # experimental | stable | deprecated
 * ---
 * ```
 *
 * The generated `packages/skills/skills/manifest.json` is derived from this
 * (`scripts/skills/generate-manifest.mjs`), and the arch gates read it.
 *
 * Deliberately a small line parser rather than a YAML dependency: the arch
 * gates run on a bare checkout (no `pnpm install`), and the frontmatter
 * grammar used by skills is a flat map plus one nested `metadata:` map and
 * folded/literal block scalars. Anything outside that grammar is reported as
 * an error rather than guessed at.
 *
 * @module scripts/skills/lib/skill-frontmatter
 * @task T12648
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { parseFrontmatter } from '../../../packages/skills/frontmatter.mjs';

// The rules themselves live in the published @cleocode/skills package so the
// runtime (`cleo skills validate`) applies exactly what gate 29 applies (T12655).
export {
  CATEGORY_FOR_TIER,
  DERIVED_TOP_LEVEL_KEYS,
  MAX_DESCRIPTION_LENGTH,
  MOVED_TO_METADATA_KEYS,
  parseFrontmatter,
  SKILL_INSTALL_MODES,
  SKILL_STABILITIES,
  SKILL_TIERS,
  TAG_PATTERN,
  TIER_NUMBER,
  validateFrontmatter,
} from '../../../packages/skills/frontmatter.mjs';

/** Repo-relative directory holding one sub-directory per canonical skill. */
export const SKILLS_DIR = 'packages/skills/skills';

/** Repo-relative path of the generated skills manifest. */
export const MANIFEST_PATH = 'packages/skills/skills/manifest.json';

/**
 * Every canonical skill directory name under `SKILLS_DIR`, sorted.
 *
 * A directory counts when it contains a `SKILL.md`; `_shared` and other
 * support directories without one are not skills.
 *
 * @param {string} root - Repository root.
 * @returns {string[]}
 */
export function listSkillDirs(root) {
  const base = join(root, SKILLS_DIR);
  return readdirSync(base)
    .filter((name) => {
      const dir = join(base, name);
      return statSync(dir).isDirectory() && existsSync(join(dir, 'SKILL.md'));
    })
    .sort();
}

/**
 * Read and parse one skill's frontmatter.
 *
 * @param {string} root - Repository root.
 * @param {string} name - Skill directory name.
 * @returns {ReturnType<typeof parseFrontmatter> & { name: string, path: string }}
 */
export function readSkillFrontmatter(root, name) {
  const path = `${SKILLS_DIR}/${name}/SKILL.md`;
  const parsed = parseFrontmatter(readFileSync(join(root, path), 'utf-8'));
  return { ...parsed, name, path };
}

/**
 * Every LOOM stage a skill may declare in `metadata.loomStage`, mapped to the
 * skill bound to it (spec `skills-curation-and-automation` §3.2.4).
 *
 * Pipeline stages come from `STAGE_SKILL_MAP` in
 * `packages/core/src/lifecycle/stage-guidance.ts`. Cross-cutting protocols
 * (contribution, artifact-publish, provenance) have no pipeline slot, so their
 * `.cant` protocol id — the file name, dashes as underscores — binds to the
 * protocol's `skillRef`. A pipeline binding wins over a protocol binding.
 *
 * @param {string} root - Repository root.
 * @returns {Map<string, string>} stage → bound skill name.
 * @task T12649
 */
export function loadLoomStages(root) {
  const stages = new Map();
  const cantDir = join(root, 'packages/core/src/validation/protocols/cant');
  if (existsSync(cantDir)) {
    for (const file of readdirSync(cantDir).filter((f) => f.endsWith('.cant'))) {
      const ref = /^skillRef:\s*([a-z][\w-]*)\s*$/m.exec(
        readFileSync(join(cantDir, file), 'utf-8'),
      );
      if (ref) stages.set(file.slice(0, -'.cant'.length).replace(/-/g, '_'), ref[1]);
    }
  }
  const guidancePath = join(root, 'packages/core/src/lifecycle/stage-guidance.ts');
  if (existsSync(guidancePath)) {
    const source = readFileSync(guidancePath, 'utf-8');
    const start = /\bSTAGE_SKILL_MAP\b[^=]*=\s*\{/.exec(source);
    if (start) {
      const from = start.index + start[0].length;
      const body = source.slice(from, source.indexOf('}', from));
      for (const m of body.matchAll(/([a-z_]+)\s*:\s*(['"`])([a-z][\w-]*)\2/g)) {
        stages.set(m[1], m[3]);
      }
    }
  }
  return stages;
}
