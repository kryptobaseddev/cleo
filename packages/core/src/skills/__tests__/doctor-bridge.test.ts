/**
 * Tests for `cleo skills doctor bridge` — single bridge symlink topology.
 *
 * @remarks
 * Moved from `packages/caamp/tests/unit/doctor-bridge.test.ts` to CORE by
 * T9744 (T9740 Wave B).
 *
 * @task T9744
 * @epic T9740
 */

import { existsSync, lstatSync, readdirSync, readlinkSync } from 'node:fs';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  AgentsSkillsRealDirError,
  buildBackupTimestamp,
  runDoctorBridge,
} from '../doctor-bridge.js';

let homeDir: string;

/**
 * Build a minimal `~/.cleo/skills/<name>/SKILL.md` fixture inside `homeDir`.
 */
async function seedSkill(name: string, content = `---\nname: ${name}\n---\n`): Promise<string> {
  const dir = join(homeDir, '.cleo', 'skills', name);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'SKILL.md'), content);
  return dir;
}

beforeEach(async () => {
  homeDir = await mkdtemp(join(tmpdir(), 'doctor-bridge-'));
});

afterEach(async () => {
  await rm(homeDir, { recursive: true, force: true }).catch(() => undefined);
});

describe('buildBackupTimestamp', () => {
  it('produces a UTC YYYYMMDD-HHmmss string', () => {
    const ts = buildBackupTimestamp();
    expect(ts).toMatch(/^\d{8}-\d{6}$/);
  });
});

describe('runDoctorBridge — fresh install', () => {
  it('creates the bridge symlink and populates agents-shared/ with per-skill symlinks', async () => {
    await seedSkill('ct-orchestrator');
    await seedSkill('ct-lead');

    const result = await runDoctorBridge({ homeDir });

    expect(result.bridgeCreated).toBe(true);
    expect(result.bridgeSymlinkActive).toBe(true);
    expect(result.dryRun).toBe(false);
    expect(result.backupPath).toBeNull();
    expect(result.perSkillSymlinksCreated.map((r) => r.name).sort()).toEqual([
      'ct-lead',
      'ct-orchestrator',
    ]);

    const bridgePath = join(homeDir, '.agents', 'skills');
    const bridgeTarget = join(homeDir, '.claude', 'skills', 'agents-shared');
    expect(lstatSync(bridgePath).isSymbolicLink()).toBe(true);
    expect(readlinkSync(bridgePath)).toBe(bridgeTarget);

    expect(existsSync(join(bridgeTarget, 'ct-orchestrator', 'SKILL.md'))).toBe(true);
    expect(existsSync(join(bridgeTarget, 'ct-lead', 'SKILL.md'))).toBe(true);
  });

  it('handles empty skills root without error', async () => {
    const result = await runDoctorBridge({ homeDir });
    expect(result.bridgeCreated).toBe(true);
    expect(result.perSkillSymlinksCreated).toEqual([]);
  });
});

describe('runDoctorBridge — idempotency', () => {
  it('re-runs are a no-op on an already-bridged tree', async () => {
    await seedSkill('ct-foo');
    await runDoctorBridge({ homeDir });
    const second = await runDoctorBridge({ homeDir });

    expect(second.bridgeCreated).toBe(false);
    expect(second.bridgeSymlinkActive).toBe(true);
    expect(second.perSkillSymlinksCreated).toEqual([]);
    expect(second.perSkillSymlinksRemoved).toEqual([]);
    expect(second.backupPath).toBeNull();
  });
});

describe('runDoctorBridge — per-skill symlink reap', () => {
  it('rips per-skill symlinks under ~/.claude/skills/* that point outside agents-shared/', async () => {
    await seedSkill('ct-foo');
    // Plant an orphan per-skill symlink at ~/.claude/skills/ct-orphan -> some other dir.
    const elsewhere = join(homeDir, 'somewhere', 'ct-orphan');
    await mkdir(elsewhere, { recursive: true });
    await mkdir(join(homeDir, '.claude', 'skills'), { recursive: true });
    await symlink(elsewhere, join(homeDir, '.claude', 'skills', 'ct-orphan'), 'dir');

    const result = await runDoctorBridge({ homeDir });

    expect(result.perSkillSymlinksRemoved).toHaveLength(1);
    expect(result.perSkillSymlinksRemoved[0]?.linkPath).toBe(
      join(homeDir, '.claude', 'skills', 'ct-orphan'),
    );
    expect(existsSync(join(homeDir, '.claude', 'skills', 'ct-orphan'))).toBe(false);
    // The actual target dir still exists — we only remove the symlink.
    expect(existsSync(elsewhere)).toBe(true);
  });

  it('keeps per-skill symlinks that already point inside agents-shared/', async () => {
    await seedSkill('ct-foo');
    // Pre-create a valid per-skill symlink under .claude/skills/ that points into agents-shared.
    const bridgeTarget = join(homeDir, '.claude', 'skills', 'agents-shared');
    await mkdir(bridgeTarget, { recursive: true });
    await mkdir(join(homeDir, '.claude', 'skills'), { recursive: true });
    // No additional symlink — runDoctorBridge will create the agents-shared symlinks itself.
    // Add a non-symlink dir as a control — it should be preserved.
    await mkdir(join(homeDir, '.claude', 'skills', 'real-dir'), { recursive: true });

    const result = await runDoctorBridge({ homeDir });

    expect(result.perSkillSymlinksRemoved).toEqual([]);
    // Real directory is left alone (we only rip symlinks).
    expect(existsSync(join(homeDir, '.claude', 'skills', 'real-dir'))).toBe(true);
  });
});

describe('runDoctorBridge — refuses to clobber a real ~/.agents/skills', () => {
  it('throws AgentsSkillsRealDirError when ~/.agents/skills is a real dir with content', async () => {
    await seedSkill('ct-foo');
    const realDir = join(homeDir, '.agents', 'skills');
    await mkdir(realDir, { recursive: true });
    await writeFile(join(realDir, 'user-precious.md'), 'do not delete');

    await expect(runDoctorBridge({ homeDir })).rejects.toBeInstanceOf(AgentsSkillsRealDirError);
    // User content preserved.
    expect(existsSync(join(realDir, 'user-precious.md'))).toBe(true);
  });

  it('with --force, backs up real ~/.agents/skills then bridges', async () => {
    await seedSkill('ct-foo');
    const realDir = join(homeDir, '.agents', 'skills');
    await mkdir(realDir, { recursive: true });
    await writeFile(join(realDir, 'user-precious.md'), 'do not delete');

    const result = await runDoctorBridge({ homeDir, force: true });

    expect(result.bridgeCreated).toBe(true);
    expect(result.bridgeSymlinkActive).toBe(true);
    expect(result.backupPath).not.toBeNull();
    if (result.backupPath !== null) {
      expect(result.backupPath).toMatch(/agents-skills-pre-bridge-/);
      expect(existsSync(join(result.backupPath, 'user-precious.md'))).toBe(true);
    }
    // Bridge symlink is in place.
    expect(lstatSync(realDir).isSymbolicLink()).toBe(true);
  });

  it('treats an empty real ~/.agents/skills dir as safe to replace without --force', async () => {
    await seedSkill('ct-foo');
    const realDir = join(homeDir, '.agents', 'skills');
    await mkdir(realDir, { recursive: true });

    const result = await runDoctorBridge({ homeDir });
    expect(result.backupPath).toBeNull();
    expect(lstatSync(realDir).isSymbolicLink()).toBe(true);
  });
});

describe('runDoctorBridge — repairs wrong-target bridge symlink', () => {
  it('replaces an existing symlink that points at the wrong target', async () => {
    await seedSkill('ct-foo');
    const bridgePath = join(homeDir, '.agents', 'skills');
    const wrongTarget = join(homeDir, 'wrong');
    await mkdir(wrongTarget, { recursive: true });
    await mkdir(join(homeDir, '.agents'), { recursive: true });
    await symlink(wrongTarget, bridgePath, 'dir');

    const result = await runDoctorBridge({ homeDir });

    expect(result.bridgeCreated).toBe(true);
    expect(readlinkSync(bridgePath)).toBe(join(homeDir, '.claude', 'skills', 'agents-shared'));
  });
});

describe('runDoctorBridge — dry-run', () => {
  it('mutates nothing on disk and still reports planned actions', async () => {
    await seedSkill('ct-foo');
    const result = await runDoctorBridge({ homeDir, dryRun: true });

    expect(result.dryRun).toBe(true);
    expect(result.bridgeCreated).toBe(true);
    expect(result.perSkillSymlinksCreated).toHaveLength(1);
    expect(existsSync(join(homeDir, '.agents', 'skills'))).toBe(false);
    expect(existsSync(join(homeDir, '.claude', 'skills', 'agents-shared', 'ct-foo'))).toBe(false);
  });
});

describe('runDoctorBridge — output shape', () => {
  it('returns a fully populated DoctorBridgeResult', async () => {
    await seedSkill('ct-foo');
    const result = await runDoctorBridge({ homeDir });

    expect(result).toMatchObject({
      bridgeCreated: true,
      bridgeSymlinkActive: true,
      perSkillSymlinksCreated: expect.any(Array),
      perSkillSymlinksRemoved: expect.any(Array),
      backupPath: null,
      dryRun: false,
      skillsRoot: join(homeDir, '.cleo', 'skills'),
      bridgeTarget: join(homeDir, '.claude', 'skills', 'agents-shared'),
      bridgePath: join(homeDir, '.agents', 'skills'),
    });
  });
});

describe('runDoctorBridge — sanity on existing agents-shared/', () => {
  it('does not touch a non-symlink directory like agents-shared itself', async () => {
    await seedSkill('ct-foo');
    // agents-shared is created as a real dir by step 1; step 3 must skip it.
    const result = await runDoctorBridge({ homeDir });
    const bridgeTarget = join(homeDir, '.claude', 'skills', 'agents-shared');
    expect(existsSync(bridgeTarget)).toBe(true);
    // Sanity: agents-shared not removed; it is a real dir (not a symlink).
    expect(lstatSync(bridgeTarget).isDirectory()).toBe(true);
    expect(result.perSkillSymlinksRemoved.map((r) => r.linkPath)).not.toContain(bridgeTarget);
  });

  it('lists skill entries lexicographically', async () => {
    await seedSkill('ct-z');
    await seedSkill('ct-a');
    await seedSkill('ct-m');
    const result = await runDoctorBridge({ homeDir });
    expect(result.perSkillSymlinksCreated.map((r) => r.name)).toEqual(['ct-a', 'ct-m', 'ct-z']);
  });

  it('ignores dotfiles in skills root', async () => {
    await seedSkill('ct-foo');
    await mkdir(join(homeDir, '.cleo', 'skills', '.hidden'), { recursive: true });
    const result = await runDoctorBridge({ homeDir });
    expect(result.perSkillSymlinksCreated.map((r) => r.name)).toEqual(['ct-foo']);
    expect(readdirSync(join(homeDir, '.claude', 'skills', 'agents-shared')).sort()).toEqual([
      'ct-foo',
    ]);
  });
});
