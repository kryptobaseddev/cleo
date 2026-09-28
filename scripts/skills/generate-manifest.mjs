#!/usr/bin/env node
/**
 * Generate `packages/skills/skills/manifest.json` from SKILL.md frontmatter.
 *
 * ## Why (T12648 · spec `skills-curation-and-automation` §3.1 · D11157)
 *
 * The skills audit found seven metadata surfaces disagreeing: the same skill
 * carried three different versions, tiers differed between files, the
 * manifest omitted a skill that existed and `skills.json` listed one (`loom`)
 * that did not. A hand-edited index drifts because nothing ties it to the
 * thing it describes. Here the SKILL.md frontmatter is the one source, and
 * the manifest is derived from it.
 *
 * ## What the frontmatter owns
 *
 * For every skill directory (one with a SKILL.md) the generator writes these
 * manifest fields from frontmatter, replacing whatever was there:
 * `name`, `version` (metadata.version), `description`, `path`, `tier`
 * (numeric, derived from metadata.tier for existing numeric readers),
 * `deliveryTier` (metadata.tier), `install` (metadata.install), `status`
 * (`deprecated` when metadata.stability is deprecated, else `active`) and
 * `loomStage` (when the frontmatter declares one).
 *
 * Curated routing data that has no frontmatter home yet (`capabilities`,
 * `constraints`, `references`, `token_budget`, `tags`, `adrRefs`, `protocol`
 * and the top-level `dispatch_matrix`) is carried over unchanged. Entries for
 * directories that no longer exist are dropped, and every directory without
 * an entry gains one, so the entry set always equals the directory set.
 *
 * ## Modes
 *
 *   node scripts/skills/generate-manifest.mjs           # rewrite the manifest
 *   node scripts/skills/generate-manifest.mjs --check   # exit 1 on drift
 *
 * The frontmatter must validate first (`validateFrontmatter`); an invalid
 * skill is reported and nothing is written.
 *
 * @task T12648
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { isMain } from '../lib/is-main.mjs';
import {
  listSkillDirs,
  MANIFEST_PATH,
  readSkillFrontmatter,
  SKILLS_DIR,
  TIER_NUMBER,
  validateFrontmatter,
} from './lib/skill-frontmatter.mjs';

/**
 * Build the manifest object the frontmatter implies.
 *
 * @param {string} root - Repository root.
 * @returns {{ manifest: object | null, problems: { skill: string, problem: string }[] }}
 *   `manifest` is null when any frontmatter is invalid.
 */
export function buildManifest(root) {
  const current = JSON.parse(readFileSync(join(root, MANIFEST_PATH), 'utf-8'));
  const existing = new Map((current.skills ?? []).map((s) => [s.name, s]));
  const problems = [];
  const skills = [];

  for (const name of listSkillDirs(root)) {
    const fm = readSkillFrontmatter(root, name);
    for (const problem of validateFrontmatter(fm)) problems.push({ skill: name, problem });
    const md = fm.metadata;
    const prior = existing.get(name) ?? {};
    const {
      name: _n,
      version: _v,
      description: _d,
      path: _p,
      tier: _t,
      deliveryTier: _dt,
      install: _i,
      status: _s,
      loomStage: _l,
      ...curated
    } = prior;
    const entry = {
      name,
      version: md.version,
      description: fm.fields.description,
      path: `skills/${name}`,
      tier: TIER_NUMBER[md.tier],
      deliveryTier: md.tier,
      install: md.install,
      status: md.stability === 'deprecated' ? 'deprecated' : 'active',
    };
    const loomStage = fm.fields.loomStage ?? _l;
    if (loomStage) entry.loomStage = loomStage;
    skills.push({ ...entry, ...curated });
  }

  if (problems.length > 0) return { manifest: null, problems };

  const { skills: _old, _meta = {}, ...rest } = current;
  const manifest = {
    ...rest,
    _meta: {
      ..._meta,
      totalSkills: skills.length,
      generator:
        'scripts/skills/generate-manifest.mjs — derived from SKILL.md frontmatter; do not hand-edit identity fields (T12648)',
    },
    skills,
  };
  // Keep `$schema` first for readers that sniff it.
  const ordered = '$schema' in manifest ? { $schema: manifest.$schema, ...manifest } : manifest;
  return { manifest: ordered, problems };
}

/**
 * Serialise a manifest exactly as the generator writes it.
 *
 * @param {object} manifest - Manifest object.
 * @returns {string}
 */
export function serialiseManifest(manifest) {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

/**
 * Compare the committed manifest with the generated one.
 *
 * @param {string} root - Repository root.
 * @returns {{ problems: { skill: string, problem: string }[], drift: string[] }}
 *   `drift` names each skill whose committed entry differs, plus
 *   `<manifest>` when anything outside the entries (order, counts, format) does.
 */
export function checkManifest(root) {
  const { manifest, problems } = buildManifest(root);
  if (!manifest) return { problems, drift: [] };
  const committedText = readFileSync(join(root, MANIFEST_PATH), 'utf-8');
  const expectedText = serialiseManifest(manifest);
  if (committedText === expectedText) return { problems, drift: [] };

  const committed = JSON.parse(committedText);
  const byName = new Map((committed.skills ?? []).map((s) => [s.name, s]));
  const drift = [];
  for (const s of manifest.skills) {
    const c = byName.get(s.name);
    if (!c)
      drift.push(`${s.name}: missing from manifest (directory ${SKILLS_DIR}/${s.name} exists)`);
    else if (JSON.stringify(c) !== JSON.stringify(s))
      drift.push(`${s.name}: entry differs from frontmatter`);
    byName.delete(s.name);
  }
  for (const name of byName.keys())
    drift.push(`${name}: listed but no ${SKILLS_DIR}/${name}/SKILL.md`);
  if (drift.length === 0) drift.push('<manifest>: formatting, ordering or _meta differs');
  return { problems, drift };
}

if (isMain(import.meta.url)) {
  const root = process.cwd();
  const check = process.argv.includes('--check');
  if (check) {
    const { problems, drift } = checkManifest(root);
    for (const p of problems) process.stderr.write(`  ✗ ${p.skill}: ${p.problem}\n`);
    for (const d of drift) process.stderr.write(`  ✗ ${d}\n`);
    if (problems.length + drift.length > 0) {
      process.stderr.write(
        `${MANIFEST_PATH} is out of date with SKILL.md frontmatter. ` +
          'Run: node scripts/skills/generate-manifest.mjs\n',
      );
      process.exit(1);
    }
    process.stdout.write(`${MANIFEST_PATH} matches SKILL.md frontmatter.\n`);
    process.exit(0);
  }
  const { manifest, problems } = buildManifest(root);
  if (!manifest) {
    for (const p of problems) process.stderr.write(`  ✗ ${p.skill}: ${p.problem}\n`);
    process.stderr.write('Frontmatter is invalid; manifest not written.\n');
    process.exit(1);
  }
  writeFileSync(join(root, MANIFEST_PATH), serialiseManifest(manifest));
  process.stdout.write(`Wrote ${MANIFEST_PATH} (${manifest.skills.length} skills).\n`);
}
