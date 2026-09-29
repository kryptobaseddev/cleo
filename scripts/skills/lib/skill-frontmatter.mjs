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

/** Repo-relative directory holding one sub-directory per canonical skill. */
export const SKILLS_DIR = 'packages/skills/skills';

/** Repo-relative path of the generated skills manifest. */
export const MANIFEST_PATH = 'packages/skills/skills/manifest.json';

/** Allowed `metadata.tier` values — the skill's delivery class (D11157). */
export const SKILL_TIERS = /** @type {const} */ (['core', 'on-demand', 'internal']);

/** Allowed `metadata.install` values. */
export const SKILL_INSTALL_MODES = /** @type {const} */ (['harness', 'internal']);

/** Allowed `metadata.stability` values. */
export const SKILL_STABILITIES = /** @type {const} */ (['experimental', 'stable', 'deprecated']);

/**
 * Numeric tier written into manifest entries for existing numeric readers
 * (CAAMP catalogue, `packages/skills/index.js`), derived from the class.
 */
export const TIER_NUMBER = /** @type {const} */ ({ core: 0, 'on-demand': 1, internal: 3 });

/**
 * CAAMP catalogue `category` written into manifest entries, derived from the
 * class so the two cannot disagree (T12653).
 */
export const CATEGORY_FOR_TIER = /** @type {const} */ ({
  core: 'core',
  'on-demand': 'recommended',
  internal: 'meta',
});

/**
 * Top-level keys a SKILL.md may not declare, because the manifest derives
 * them from `metadata.tier` (T12648, T12653).
 */
export const DERIVED_TOP_LEVEL_KEYS = /** @type {const} */ (['tier', 'core', 'category']);

/**
 * Top-level keys that moved under `metadata:` (T12649). Each maps to its
 * `metadata.<key>` home.
 */
export const MOVED_TO_METADATA_KEYS = /** @type {const} */ (['loomStage']);

/** Maximum `description` length accepted by harness skill loaders. */
export const MAX_DESCRIPTION_LENGTH = 1024;

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
 * Parse the scalar on the right of `key:`.
 *
 * @param {string} raw - Text after the colon.
 * @returns {string} Unquoted scalar ('' for an empty value).
 */
function scalar(raw) {
  const v = raw.trim();
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
    return v.slice(1, -1);
  }
  return v;
}

/**
 * Parse SKILL.md text into its frontmatter.
 *
 * @param {string} text - Full SKILL.md content.
 * @returns {{
 *   ok: boolean,
 *   fields: Record<string, string>,
 *   metadata: Record<string, string>,
 *   metadataLists: Record<string, string[]>,
 *   lists: Record<string, string[]>,
 *   keys: string[],
 *   errors: string[],
 * }} `fields` holds top-level scalars (block scalars folded to one line;
 *   nested maps omitted), `lists` top-level block (`- item`) and inline
 *   (`[a, b]`) lists, `keys` every top-level key in order (duplicates
 *   included), `metadata` the nested `metadata:` map and `metadataLists`
 *   its nested lists (`metadata.covers`).
 */
export function parseFrontmatter(text) {
  const errors = [];
  // T12649: a CRLF checkout (Windows autocrlf) must parse identically.
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  if (lines[0] !== '---') {
    return {
      ok: false,
      fields: {},
      metadata: {},
      metadataLists: {},
      lists: {},
      keys: [],
      errors: ['no frontmatter block'],
    };
  }
  const end = lines.indexOf('---', 1);
  if (end === -1) {
    return {
      ok: false,
      fields: {},
      metadata: {},
      metadataLists: {},
      lists: {},
      keys: [],
      errors: ['unterminated frontmatter'],
    };
  }
  const body = lines.slice(1, end);
  /** @type {Record<string, string>} */
  const fields = {};
  /** @type {Record<string, string>} */
  const metadata = {};
  /** @type {Record<string, string[]>} */
  const lists = {};
  /** @type {Record<string, string[]>} */
  const metadataLists = {};
  const keys = [];

  for (let i = 0; i < body.length; i++) {
    const line = body[i];
    if (line.trim() === '' || line.trimStart().startsWith('#')) continue;
    if (/^\s/.test(line) || line.startsWith('- ')) continue; // continuation of a nested value
    const m = /^([A-Za-z][\w-]*):(.*)$/.exec(line);
    if (!m) {
      errors.push(`unparseable frontmatter line ${i + 2}: ${line}`);
      continue;
    }
    const [, key, rest] = m;
    keys.push(key);
    const value = rest.trim();

    if (key === 'metadata' && value === '') {
      // A blank line inside the block does not end it; the next unindented
      // key does (T12649).
      // A nested list (`  covers:` then `    - item`) is collected into
      // metadataLists (T12124).
      let listKey = null;
      for (let j = i + 1; j < body.length; j++) {
        if (body[j].trim() === '') continue;
        if (!/^\s+\S/.test(body[j])) break;
        const item = /^\s+-\s+(.*)$/.exec(body[j]);
        if (item && listKey) {
          metadataLists[listKey].push(scalar(item[1]));
          continue;
        }
        const mm = /^\s+([A-Za-z][\w-]*):(.*)$/.exec(body[j]);
        if (!mm) continue;
        listKey = null;
        if (mm[2].trim() === '') {
          listKey = mm[1];
          metadataLists[listKey] = [];
        } else {
          metadata[mm[1]] = scalar(mm[2]);
        }
      }
      continue;
    }
    if (value === '>' || value === '>-' || value === '|' || value === '|-') {
      const parts = [];
      for (let j = i + 1; j < body.length && (/^\s+\S/.test(body[j]) || body[j] === ''); j++) {
        parts.push(body[j].trim());
      }
      fields[key] = parts.filter(Boolean).join(' ');
      continue;
    }
    if (value === '') {
      // A block list (`key:` then `  - item` lines) — T12649.
      const items = [];
      for (let j = i + 1; j < body.length && /^\s+-\s/.test(body[j]); j++) {
        items.push(scalar(body[j].replace(/^\s+-\s+/, '')));
      }
      lists[key] = items;
    } else if (value.startsWith('[') && value.endsWith(']')) {
      lists[key] = value
        .slice(1, -1)
        .split(',')
        .map((s) => scalar(s))
        .filter(Boolean);
    }
    fields[key] = scalar(value);
  }

  return { ok: errors.length === 0, fields, metadata, metadataLists, lists, keys, errors };
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
 * Validate one skill's frontmatter against the SSoT contract.
 *
 * @param {ReturnType<typeof readSkillFrontmatter>} fm - Parsed frontmatter.
 * @param {{ loomStages?: Map<string, string> }} [ctx] - `loomStages` (from
 *   {@link loadLoomStages}) enables the `metadata.loomStage` binding check.
 * @returns {string[]} Human-readable problems (empty when valid).
 */
export function validateFrontmatter(fm, ctx = {}) {
  const problems = [...fm.errors];
  const seen = new Set();
  for (const k of fm.keys) {
    if (seen.has(k)) problems.push(`duplicate top-level key '${k}' (invalid YAML)`);
    seen.add(k);
  }
  if (fm.fields.name !== fm.name) {
    problems.push(`name '${fm.fields.name ?? ''}' does not equal its directory '${fm.name}'`);
  }
  const description = fm.fields.description ?? '';
  if (description === '') problems.push('description is missing');
  if (description.length > MAX_DESCRIPTION_LENGTH) {
    problems.push(`description is ${description.length} chars (max ${MAX_DESCRIPTION_LENGTH})`);
  }
  for (const key of DERIVED_TOP_LEVEL_KEYS) {
    if (key in fm.fields) {
      problems.push(
        `top-level ${key} is not allowed — it is derived from metadata.tier (core|on-demand|internal)`,
      );
    }
  }
  for (const key of MOVED_TO_METADATA_KEYS) {
    if (key in fm.fields) problems.push(`top-level ${key} moved — declare metadata.${key}`);
  }
  const md = fm.metadata;
  if (md.loomStage !== undefined && ctx.loomStages) {
    const owner = ctx.loomStages.get(md.loomStage);
    if (owner === undefined) {
      problems.push(
        `metadata.loomStage '${md.loomStage}' is not a STAGE_SKILL_MAP stage or a .cant protocol id`,
      );
    } else if (owner !== fm.name) {
      problems.push(
        `metadata.loomStage '${md.loomStage}' is bound to '${owner}', not '${fm.name}'`,
      );
    }
  }
  if (!md.version) problems.push('metadata.version is missing');
  else if (!/^\d+\.\d+\.\d+$/.test(md.version)) {
    problems.push(`metadata.version '${md.version}' is not X.Y.Z`);
  }
  if (fm.fields.version !== undefined && fm.fields.version !== md.version) {
    problems.push(
      `top-level version '${fm.fields.version}' disagrees with metadata.version '${md.version ?? ''}'`,
    );
  }
  if (!SKILL_TIERS.includes(md.tier)) {
    problems.push(`metadata.tier '${md.tier ?? ''}' must be one of ${SKILL_TIERS.join('|')}`);
  }
  if (!SKILL_INSTALL_MODES.includes(md.install)) {
    problems.push(
      `metadata.install '${md.install ?? ''}' must be one of ${SKILL_INSTALL_MODES.join('|')}`,
    );
  }
  if (md.tier === 'internal' && md.install === 'harness') {
    problems.push('metadata.tier internal cannot have metadata.install harness');
  }
  if (md.stability !== undefined && !SKILL_STABILITIES.includes(md.stability)) {
    problems.push(
      `metadata.stability '${md.stability}' must be one of ${SKILL_STABILITIES.join('|')}`,
    );
  }
  return problems;
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
