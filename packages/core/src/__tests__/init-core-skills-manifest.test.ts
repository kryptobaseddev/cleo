/**
 * {@link initCoreSkills} installs exactly the skills the manifest declares
 * `metadata.install: harness` (T12653 · D11157).
 *
 * Before T12653 install read `packages/skills/skills.json` (tier <= 2), which
 * omitted ct-lead and six LOOM stage skills that spawn prompts and stage
 * guidance load, and installed the internal ct-grade. This test runs the real
 * selection against the real `@cleocode/skills` package; only CAAMP's
 * side-effecting install is stubbed, so no harness directory is touched.
 *
 * @task T12653
 */

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const installResolvedSkill = vi.fn(async () => ({ success: true }));

vi.mock('@cleocode/caamp', () => ({
  getInstalledProviders: () => [{ id: 'claude-code' }],
  installResolvedSkill,
  registerSkillLibraryFromPath: () => undefined,
}));

/** The real `@cleocode/skills` manifest. */
function readManifest(): { skills: Array<{ name: string; install?: string }> } {
  const req = createRequire(import.meta.url);
  const root = dirname(req.resolve('@cleocode/skills/package.json'));
  return JSON.parse(readFileSync(join(root, 'skills', 'manifest.json'), 'utf-8'));
}

describe('initCoreSkills installs from manifest metadata.install (T12653)', () => {
  beforeEach(() => {
    installResolvedSkill.mockClear();
  });

  it('installs every harness skill and no internal skill', async () => {
    const { initCoreSkills } = await import('../init.js');
    const created: string[] = [];
    const warnings: string[] = [];

    await initCoreSkills(created, warnings);

    const installed = installResolvedSkill.mock.calls
      .map(([resolved]) => (resolved as { skillName: string }).skillName)
      .sort();
    const manifest = readManifest();
    const harness = manifest.skills
      .filter((s) => s.install === 'harness')
      .map((s) => s.name)
      .sort();

    expect(warnings).toEqual([]);
    expect(installed).toEqual(harness);
    for (const name of [
      'ct-lead',
      'ct-adr-recorder',
      'ct-consensus-voter',
      'ct-ivt-looper',
      'ct-release-orchestrator',
      'ct-artifact-publisher',
      'ct-provenance-keeper',
    ]) {
      expect(installed).toContain(name);
    }
    expect(installed).not.toContain('ct-grade');
    expect(created).toContain(`skills: ${harness.length} core skills installed`);
  });

  it('installs each skill from its skills/<name> directory', async () => {
    const { initCoreSkills } = await import('../init.js');
    await initCoreSkills([], []);

    for (const [resolved] of installResolvedSkill.mock.calls) {
      const { localPath, skillName } = resolved as { localPath: string; skillName: string };
      expect(localPath.endsWith(join('skills', 'skills', skillName))).toBe(true);
    }
  });
});
