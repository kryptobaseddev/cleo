/**
 * Gate: every skill a spawn prompt or stage guidance names must resolve.
 *
 * `ct-lead` and several LOOM-stage skills are never installed to the data
 * dir, and `resolveSkillPath` / `findSkill` used to search only installed
 * locations — so tier-1 lead spawns printed "Skills not installed" and stage
 * guidance fell back to a stub. Install selection must not decide whether a
 * spawn prompt can read a protocol it names (T12646).
 *
 * The data dir here is the per-fork sandbox from `vitest.setup.ts`, pointed
 * at an EMPTY skills root, so only the bundled fallback can satisfy these
 * assertions.
 *
 * @task T12646
 */

import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  buildStageGuidance,
  STAGE_SKILL_MAP,
  TIER_0_SKILLS,
} from '../../lifecycle/stage-guidance.js';
import type { Stage } from '../../lifecycle/stages.js';
import { findSkill } from '../../skills/discovery.js';
import { resolveSkillPath } from '../../skills/skill-paths.js';
import { resolveBundledSkillsDir } from '../../skills/skill-root.js';
import { buildTierSkillExcerpts } from '../spawn-prompt.js';

const SPAWN_PROMPT_SOURCE = fileURLToPath(new URL('../spawn-prompt.ts', import.meta.url));

/** Skill names spawn-prompt.ts passes to a resolver as string literals. */
function spawnPromptSkillLiterals(): string[] {
  const source = readFileSync(SPAWN_PROMPT_SOURCE, 'utf-8');
  const names = new Set<string>();
  for (const m of source.matchAll(/(?:loadSkillExcerpt|resolveSkillPath)\(\s*'([a-z0-9-]+)'/g)) {
    names.add(m[1] as string);
  }
  return [...names];
}

let savedCleoHome: string | undefined;
let savedSource: string | undefined;
let emptyProject: string;

beforeAll(() => {
  savedCleoHome = process.env['CLEO_HOME'];
  savedSource = process.env['CLEO_SKILL_SOURCE'];
  // Empty data dir and an empty project: nothing is installed anywhere.
  process.env['CLEO_HOME'] = mkdtempSync(join(tmpdir(), 'skill-resolution-home-'));
  delete process.env['CLEO_SKILL_SOURCE'];
  emptyProject = mkdtempSync(join(tmpdir(), 'skill-resolution-project-'));
});

afterAll(() => {
  if (savedCleoHome === undefined) delete process.env['CLEO_HOME'];
  else process.env['CLEO_HOME'] = savedCleoHome;
  if (savedSource === undefined) delete process.env['CLEO_SKILL_SOURCE'];
  else process.env['CLEO_SKILL_SOURCE'] = savedSource;
});

describe('spawn-prompt / stage-guidance skill resolution (T12646)', () => {
  it('finds the bundled @cleocode/skills directory', () => {
    expect(resolveBundledSkillsDir()).not.toBeNull();
  });

  it('extracts the skill literals spawn-prompt.ts resolves', () => {
    // Guards the extractor itself: an empty list would make the gate vacuous.
    expect(spawnPromptSkillLiterals()).toEqual(
      expect.arrayContaining(['ct-cleo', 'ct-lead', 'ct-orchestrator']),
    );
  });

  it('every skill spawn-prompt.ts names resolves with nothing installed', () => {
    const unresolved = spawnPromptSkillLiterals().filter(
      (name) => resolveSkillPath(name, emptyProject) === null,
    );
    expect(unresolved).toEqual([]);
  });

  it('every stage-guidance skill resolves with nothing installed', () => {
    const names = [...new Set([...Object.values(STAGE_SKILL_MAP), ...TIER_0_SKILLS])];
    const unresolved = names.filter((name) => findSkill(name, emptyProject) === null);
    expect(unresolved).toEqual([]);
  });

  it('stage guidance loads real skill content for every stage', () => {
    const fallbacks = (Object.keys(STAGE_SKILL_MAP) as Stage[]).filter(
      (stage) => buildStageGuidance(stage, emptyProject).source !== 'skills',
    );
    expect(fallbacks).toEqual([]);
  });

  it('tier-1 lead and tier-2 excerpts carry their skills, not the not-installed notice', () => {
    const lead = buildTierSkillExcerpts(1, 'lead', emptyProject);
    expect(lead).not.toContain('Skills not installed');
    expect(lead).toContain('### ct-cleo');
    expect(lead).toContain('### ct-lead');

    const orchestrator = buildTierSkillExcerpts(2, 'orchestrator', emptyProject);
    expect(orchestrator).toContain('### ct-cleo');
    expect(orchestrator).toContain('### ct-orchestrator');
  });

  it('CLEO_SKILL_SOURCE=embedded still disables the bundled fallback', () => {
    process.env['CLEO_SKILL_SOURCE'] = 'embedded';
    try {
      expect(resolveSkillPath('ct-lead', emptyProject)).toBeNull();
    } finally {
      delete process.env['CLEO_SKILL_SOURCE'];
    }
  });
});
