/**
 * Global delivery audit/repair (T12596 · T12598).
 *
 * Reproduces the layout measured on macOS 2026-09-28: `~/.cleo` a dangling
 * link to a Linux path, and every harness `ct-*` skill a link to
 * `~/.cleo/skills/<name>` — so no harness loaded any CLEO skill. Runs in a
 * sandboxed HOME / CLEO_HOME.
 *
 * @task T12598
 */

import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getCleoHome } from '../../paths.js';
import { resolveSkillsRoot } from '../../skills/skill-root.js';
import {
  auditGlobalDelivery,
  repairGlobalDelivery,
  routesThroughCleoLink,
} from '../global-delivery.js';

let home: string;
let cleoHome: string;
let base: string;
const saved: Record<string, string | undefined> = {};

function layout(opts: { linkState: 'dangling' | 'canonical' }) {
  const skillsRoot = join(cleoHome, 'skills');
  for (const name of ['ct-cleo', 'ct-orchestrator']) {
    mkdirSync(join(skillsRoot, name), { recursive: true });
    writeFileSync(join(skillsRoot, name, 'SKILL.md'), `# ${name}\n`);
  }
  mkdirSync(join(cleoHome, 'templates'), { recursive: true });
  writeFileSync(join(cleoHome, 'templates', 'CLEO-INJECTION.md'), '# CLEO Protocol\n');
  symlinkSync(
    opts.linkState === 'dangling' ? '/home/nobody/.local/share/cleo' : cleoHome,
    join(home, '.cleo'),
  );
  const harness = [join(home, '.claude', 'skills'), join(home, '.agents', 'skills')];
  for (const dir of harness) {
    mkdirSync(dir, { recursive: true });
    for (const name of ['ct-cleo', 'ct-orchestrator', 'ct-gone']) {
      symlinkSync(join(home, '.cleo', 'skills', name), join(dir, name));
    }
  }
  // A non-CLEO link owned by another tool: must never be reported or touched.
  mkdirSync(join(home, '.agents', 'skills', 'other-tool'), { recursive: true });
  symlinkSync('../../.agents/skills/other-tool', join(home, '.claude', 'skills', 'other-tool'));
  mkdirSync(join(home, '.agents'), { recursive: true });
  writeFileSync(
    join(home, '.agents', 'AGENTS.md'),
    '<!-- CAAMP:START -->\n@~/.cleo/templates/CLEO-INJECTION.md\n<!-- CAAMP:END -->\n',
  );
  return {
    home,
    path: join(home, '.cleo'),
    canonicalTarget: cleoHome,
    skillsRoot,
    skillDirs: harness,
    hubPath: join(home, '.agents', 'AGENTS.md'),
  };
}

beforeEach(async () => {
  base = mkdtempSync(join(tmpdir(), 'global-delivery-'));
  home = join(base, 'home');
  cleoHome = join(home, 'Library', 'Application Support', 'cleo');
  mkdirSync(home, { recursive: true });
  for (const k of ['HOME', 'USERPROFILE', 'CLEO_HOME']) saved[k] = process.env[k];
  process.env['HOME'] = home;
  process.env['USERPROFILE'] = home;
  process.env['CLEO_HOME'] = cleoHome;
  const { _resetPlatformPathsCache } = await import('../platform-paths.js');
  _resetPlatformPathsCache();
});

afterEach(async () => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  const { _resetPlatformPathsCache } = await import('../platform-paths.js');
  _resetPlatformPathsCache();
  rmSync(base, { recursive: true, force: true });
});

describe('install targets resolve through the platform data dir (T12598 AC1)', () => {
  it('resolveSkillsRoot is <cleoHome>/skills, never ~/.cleo/skills', () => {
    expect(resolveSkillsRoot()).toBe(join(getCleoHome(), 'skills'));
    expect(resolveSkillsRoot()).not.toContain(`${path.sep}.cleo${path.sep}skills`);
  });
});

describe('path shapes (macOS, Linux, Windows)', () => {
  it.each([
    [
      'macOS',
      path.posix,
      '/Users/u/.claude/skills',
      '/Users/u/.cleo/skills/ct-cleo',
      '/Users/u/.cleo',
      true,
    ],
    [
      'macOS physical',
      path.posix,
      '/Users/u/.claude/skills',
      '/Users/u/Library/Application Support/cleo/skills/ct-cleo',
      '/Users/u/.cleo',
      false,
    ],
    [
      'Linux relative',
      path.posix,
      '/home/u/.agents/skills',
      '../../.cleo/skills/ct-cleo',
      '/home/u/.cleo',
      true,
    ],
    [
      'Linux physical',
      path.posix,
      '/home/u/.agents/skills',
      '/home/u/.local/share/cleo/skills/ct-cleo',
      '/home/u/.cleo',
      false,
    ],
    [
      'Linux lookalike',
      path.posix,
      '/home/u/.agents/skills',
      '/home/u/.cleo-old/skills/ct-cleo',
      '/home/u/.cleo',
      false,
    ],
    [
      'Windows',
      path.win32,
      'C:\\Users\\U\\.claude\\skills',
      'C:\\Users\\U\\.cleo\\skills\\ct-cleo',
      'C:\\Users\\u\\.cleo',
      true,
    ],
    [
      'Windows physical',
      path.win32,
      'C:\\Users\\U\\.claude\\skills',
      'C:\\Users\\U\\AppData\\Local\\cleo\\Data\\skills\\ct-cleo',
      'C:\\Users\\U\\.cleo',
      false,
    ],
  ])('%s: routesThroughCleoLink', (_label, api, dir, target, cleoLink, expected) => {
    expect(routesThroughCleoLink(target, dir, cleoLink, api)).toBe(expected);
  });
});

describe('macOS layout: dangling ~/.cleo + 96-style dangling skill links', () => {
  it('audit reports the link, the hub and every dangling skill; ignores other tools', async () => {
    const opts = layout({ linkState: 'dangling' });
    const audit = await auditGlobalDelivery(opts);
    expect(audit.link.state).toBe('dangling');
    expect(audit.hub.state).toBe('unresolved');
    expect(audit.skillCounts).toEqual({ ok: 0, dangling: 4, 'legacy-route': 0, orphan: 2 });
    expect(audit.skills.some((s) => s.name === 'other-tool')).toBe(false);
    expect(audit.healthy).toBe(false);
    expect(audit.remedy).toBe('cleo doctor global-delivery --repair');
  });

  it('dry run plans every repair and writes nothing', async () => {
    const opts = layout({ linkState: 'dangling' });
    const { receipt } = await repairGlobalDelivery({ ...opts, dryRun: true });
    expect(receipt.link.action).toBe('relinked');
    expect(receipt.skills.filter((s) => s.action === 'symlink')).toHaveLength(4);
    expect(receipt.receiptLog).toBeNull();
    expect(readlinkSync(opts.path)).toBe('/home/nobody/.local/share/cleo');
    expect(existsSync(join(opts.skillDirs[0] as string, 'ct-cleo'))).toBe(false);
  });

  it('repair makes the hub and every skill resolve, links to the PHYSICAL path, keeps orphans and other tools', async () => {
    const opts = layout({ linkState: 'dangling' });
    const { audit, receipt } = await repairGlobalDelivery(opts);
    expect(audit.healthy).toBe(true);
    expect(audit.hub.state).toBe('reference');
    for (const dir of opts.skillDirs) {
      const entry = join(dir, 'ct-cleo');
      expect(readFileSync(join(entry, 'SKILL.md'), 'utf-8')).toBe('# ct-cleo\n');
      if (lstatSync(entry).isSymbolicLink()) {
        expect(readlinkSync(entry)).toBe(join(opts.skillsRoot, 'ct-cleo'));
      }
      // Orphans (no canonical source) are reported, never deleted.
      expect(lstatSync(join(dir, 'ct-gone')).isSymbolicLink()).toBe(true);
    }
    expect(readlinkSync(join(home, '.claude', 'skills', 'other-tool'))).toBe(
      '../../.agents/skills/other-tool',
    );
    expect(receipt.skills.filter((s) => s.reason !== null)).toHaveLength(2);
    const logged = readFileSync(receipt.receiptLog as string, 'utf-8')
      .trim()
      .split('\n');
    expect(JSON.parse(logged.at(-1) as string).receiptId).toBe(receipt.receiptId);
  });
});

describe('Linux layout: healthy ~/.cleo, skills routed through it', () => {
  it('flags ~/.cleo-routed links as legacy-route and relinks them to the physical path', async () => {
    const opts = layout({ linkState: 'canonical' });
    const before = await auditGlobalDelivery(opts);
    expect(before.link.state).toBe('canonical');
    expect(before.skillCounts['legacy-route']).toBe(4);
    const { audit } = await repairGlobalDelivery(opts);
    expect(audit.skillCounts['legacy-route']).toBe(0);
    expect(audit.healthy).toBe(true);
    expect(readlinkSync(join(home, '.agents', 'skills', 'ct-orchestrator'))).toBe(
      join(opts.skillsRoot, 'ct-orchestrator'),
    );
  });
});

describe('managed instruction blocks are hashed against the current template (T14304)', () => {
  it('reports a 2.24.8 block, and --repair rewrites only the block until the hashes match', async () => {
    const { getProvider, resetRegistry } = await import('@cleocode/caamp');
    resetRegistry();
    const paths = layout({ linkState: 'canonical' });
    writeFileSync(
      join(cleoHome, 'templates', 'CLEO-INJECTION.md'),
      '# CLEO Protocol\n\nVersion: 2.25.5 | CLI-only dispatch\n',
    );
    const claudeMd = join(home, '.claude', 'CLAUDE.md');
    const before = '# My own notes\nKeep me exactly.\n\n';
    const after = '\n## Trailing user rule\nAlso mine.\n';
    // An inlined copy of an older template: stamps and body both from 2.24.8.
    const stale = [
      '<!-- CAAMP:START -->',
      `<!-- CAAMP:SOURCE ${encodeURIComponent(join(cleoHome, 'templates', 'CLEO-INJECTION.md'))} ${'0'.repeat(64)} -->`,
      '# CLEO Protocol',
      '',
      'Version: 2.24.8 | CLI-only dispatch',
      '<!-- CAAMP:END -->',
    ].join('\n');
    writeFileSync(claudeMd, `${before}${stale}${after}`);
    const claude = getProvider('claude-code');
    if (!claude) throw new Error('claude-code provider missing');
    const opts = { ...paths, instructionTargets: { providers: [claude], baseDir: home } };

    const audit = await auditGlobalDelivery(opts);
    const file = audit.instructions?.files.find((f) => f.path === claudeMd);
    expect(file?.state).toBe('stale');
    expect(file?.blockSha256).not.toBe(file?.expectedSha256);
    expect(audit.healthy).toBe(false);

    const { audit: repaired, receipt } = await repairGlobalDelivery(opts);
    expect(receipt.instructions?.status).toBe('synced');
    const fixed = repaired.instructions?.files.find((f) => f.path === claudeMd);
    expect(fixed?.state).toBe('current');
    expect(fixed?.blockSha256).toBe(fixed?.expectedSha256);
    const content = readFileSync(claudeMd, 'utf8');
    expect(content).toContain('Version: 2.25.5');
    expect(content).not.toContain('Version: 2.24.8');
    // Every byte outside the managed block is unchanged.
    expect(content.startsWith(before)).toBe(true);
    expect(content.endsWith(after)).toBe(true);
    resetRegistry();
  });
});
