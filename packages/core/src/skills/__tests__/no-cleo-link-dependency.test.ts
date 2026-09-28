/**
 * No runtime skill read depends on `~/.cleo` (T12603).
 *
 * HOME is a temp dir whose `~/.cleo` is ABSENT or DANGLING (a Linux target,
 * as dotfiles carried it to macOS); the real data lives in CLEO_HOME. Skill
 * listing, the skills doctor, the bridge doctor and the federation store must
 * all work, and the federation store must still read an index an older
 * release left at `~/.cleo/federation.json`.
 *
 * @task T12603
 */

import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { toolsSkillList } from '../../engine/engine-ops.js';
import { closeSkillsDb, resetSkillsDbState } from '../../store/skills-db.js';
import { diagnoseSkillStore } from '../doctor.js';
import { runDoctorBridge } from '../doctor-bridge.js';
import {
  addFederationPeer,
  getFederationIndexPath,
  getLegacyFederationIndexPath,
  readFederationIndex,
} from '../federation-store.js';
import { resolveSkillsRoot } from '../skill-root.js';

let base: string;
let home: string;
let cleoHome: string;
const saved: Record<string, string | undefined> = {};

function seedSkill(name: string): void {
  const dir = join(cleoHome, 'skills', name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: ${name}\n---\n# ${name}\n`,
  );
}

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'no-cleo-link-'));
  home = join(base, 'home');
  cleoHome = join(base, 'data', 'cleo');
  mkdirSync(home, { recursive: true });
  for (const k of ['HOME', 'USERPROFILE', 'CLEO_HOME']) saved[k] = process.env[k];
  process.env['HOME'] = home;
  process.env['USERPROFILE'] = home;
  process.env['CLEO_HOME'] = cleoHome;
  resetSkillsDbState();
  seedSkill('ct-cleo');
});

afterEach(() => {
  closeSkillsDb();
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(base, { recursive: true, force: true });
});

describe.each([
  ['absent', () => {}],
  ['dangling', () => symlinkSync('/home/nobody/.local/share/cleo', join(home, '.cleo'))],
])('~/.cleo %s', (_state, arrange) => {
  beforeEach(() => arrange());

  it('skills resolve from <cleoHome>/skills and `skills list` finds them', async () => {
    expect(resolveSkillsRoot()).toBe(join(cleoHome, 'skills'));
    const listed = await toolsSkillList();
    expect(listed.success).toBe(true);
    expect(listed.data?.skills.map((s) => s.name)).toContain('ct-cleo');
  });

  it('the skills doctor reports the canonical root as present and preferred', async () => {
    const report = await diagnoseSkillStore({ dbPathOverride: join(base, 'skills.db') });
    expect(report.canonicalRoot).toMatchObject({
      path: join(cleoHome, 'skills'),
      exists: true,
      isPreferredSsot: true,
      entryCount: 1,
    });
  });

  it('the bridge doctor plans per-skill links from the real root', async () => {
    const result = await runDoctorBridge({ dryRun: true });
    expect(result.perSkillSymlinksCreated).toEqual([
      expect.objectContaining({ name: 'ct-cleo', target: join(cleoHome, 'skills', 'ct-cleo') }),
    ]);
  });

  it('the federation store reads and writes under <cleoHome>', () => {
    expect(getFederationIndexPath()).toBe(join(cleoHome, 'federation.json'));
    expect(readFederationIndex().entries).toEqual([]);
    addFederationPeer('https://peer.example', 'verified');
    expect(readFederationIndex().entries.map((e) => e.url)).toEqual(['https://peer.example/']);
  });
});

describe('legacy ~/.cleo/federation.json read-through', () => {
  it('reads an index an older release left at ~/.cleo until the next write moves it', () => {
    mkdirSync(join(home, '.cleo'), { recursive: true });
    writeFileSync(
      getLegacyFederationIndexPath(),
      JSON.stringify({
        version: 1,
        entries: [
          { url: 'https://old.example/', trust: 'verified', addedAt: '2026-01-01T00:00:00Z' },
        ],
      }),
    );
    expect(readFederationIndex().entries.map((e) => e.url)).toEqual(['https://old.example/']);
    addFederationPeer('https://new.example', 'unverified');
    const canonical = readFederationIndex(getFederationIndexPath());
    expect(canonical.entries.map((e) => e.url).sort()).toEqual([
      'https://new.example/',
      'https://old.example/',
    ]);
  });
});
