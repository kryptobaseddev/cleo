/**
 * `repairGlobalDelivery` failing MID-LOOP (T12596 round-2 review).
 *
 * One skill entry can be neither linked nor copied (link creation and the copy
 * both throw, as on a read-only or link-less filesystem). The run must:
 * - have written an `intent` receipt listing EVERY planned entry with its
 *   previous target before the first entry changed;
 * - restore the failing entry's previous link;
 * - append a `failed` receipt and rethrow.
 *
 * `symlinkSync` / `cpSync` from `node:fs` fail only for the chosen entry; the
 * restore's own `symlinkSync(previousTarget, …)` goes through.
 *
 * @task T12596
 */

import * as realFs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const control = vi.hoisted(() => ({ failCanonical: '', failCopy: true }));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    symlinkSync: vi.fn((target: string, path: string, type?: 'dir' | 'file' | 'junction') => {
      if (control.failCanonical !== '' && target === control.failCanonical) {
        throw Object.assign(new Error('EPERM: operation not permitted, symlink'), {
          code: 'EPERM',
        });
      }
      return actual.symlinkSync(target, path, type);
    }),
    cpSync: vi.fn((src: string, dest: string, opts?: realFs.CopySyncOptions) => {
      if (control.failCopy && control.failCanonical !== '' && src === control.failCanonical) {
        throw Object.assign(new Error('EROFS: read-only file system, copy'), { code: 'EROFS' });
      }
      return actual.cpSync(src, dest, opts);
    }),
  };
});

const { repairGlobalDelivery, discoverHarnessSkillDirs } = await import('../global-delivery.js');

let base: string;
let home: string;
let cleoHome: string;

beforeEach(() => {
  base = realFs.mkdtempSync(join(tmpdir(), 'global-delivery-fail-'));
  home = join(base, 'home');
  cleoHome = join(base, 'data', 'cleo');
  for (const name of ['ct-a', 'ct-b', 'ct-c']) {
    realFs.mkdirSync(join(cleoHome, 'skills', name), { recursive: true });
    realFs.writeFileSync(join(cleoHome, 'skills', name, 'SKILL.md'), `# ${name}\n`);
  }
  realFs.mkdirSync(join(cleoHome, 'templates'), { recursive: true });
  realFs.writeFileSync(join(cleoHome, 'templates', 'CLEO-INJECTION.md'), '# CLEO Protocol\n');
  realFs.mkdirSync(home, { recursive: true });
  realFs.symlinkSync(cleoHome, join(home, '.cleo'));
  control.failCanonical = '';
  control.failCopy = true;
});

afterEach(() => {
  control.failCanonical = '';
  realFs.rmSync(base, { recursive: true, force: true });
});

function harness(dir: string): string {
  const d = join(home, dir);
  realFs.mkdirSync(d, { recursive: true });
  for (const name of ['ct-a', 'ct-b', 'ct-c']) {
    realFs.symlinkSync(`/home/nobody/.cleo/skills/${name}`, join(d, name));
  }
  return d;
}

describe('repairGlobalDelivery mid-loop failure', () => {
  it('records every planned previous target BEFORE mutating, restores the failing link, logs failed', async () => {
    const dir = harness('.claude/skills');
    control.failCanonical = join(cleoHome, 'skills', 'ct-b');
    const auditDir = join(base, 'audit');

    await expect(
      repairGlobalDelivery({
        home,
        path: join(home, '.cleo'),
        canonicalTarget: cleoHome,
        skillsRoot: join(cleoHome, 'skills'),
        skillDirs: [dir],
        hubPath: join(home, '.agents', 'AGENTS.md'),
        auditDir,
      }),
    ).rejects.toThrow(/EROFS/);

    const lines = realFs
      .readFileSync(join(auditDir, 'global-delivery.jsonl'), 'utf-8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
    expect(lines.map((l) => l.phase)).toEqual(['intent', 'failed']);
    // The intent line names every entry and its previous target.
    expect(
      lines[0].planned.map((p: { path: string; previousTarget: string }) => [
        p.path,
        p.previousTarget,
      ]),
    ).toEqual(
      ['ct-a', 'ct-b', 'ct-c'].map((n) => [join(dir, n), `/home/nobody/.cleo/skills/${n}`]),
    );
    // Earlier entries were repaired; the failing one has its previous link back.
    expect(realFs.readlinkSync(join(dir, 'ct-a'))).toBe(join(cleoHome, 'skills', 'ct-a'));
    expect(realFs.readlinkSync(join(dir, 'ct-b'))).toBe('/home/nobody/.cleo/skills/ct-b');
    expect(lines[1].skills.map((s: { path: string }) => s.path)).toEqual([join(dir, 'ct-a')]);
    // No staging copy is left behind.
    expect(realFs.readdirSync(dir).filter((n) => n.includes('cleo-staging'))).toEqual([]);
  });

  it('copies through a staging sibling when only the link fails', async () => {
    const dir = harness('.claude/skills');
    const failing = join(cleoHome, 'skills', 'ct-a');
    control.failCanonical = failing;
    control.failCopy = false; // only the link fails for ct-a

    const { receipt } = await repairGlobalDelivery({
      home,
      path: join(home, '.cleo'),
      canonicalTarget: cleoHome,
      skillsRoot: join(cleoHome, 'skills'),
      skillDirs: [dir],
      hubPath: join(home, '.agents', 'AGENTS.md'),
      auditDir: join(base, 'audit'),
    });
    expect(receipt.skills.find((s) => s.path === join(dir, 'ct-a'))?.action).toBe('copy');
    expect(realFs.lstatSync(join(dir, 'ct-a')).isDirectory()).toBe(true);
    expect(realFs.readFileSync(join(dir, 'ct-a', 'SKILL.md'), 'utf-8')).toBe('# ct-a\n');
    expect(receipt.phase).toBe('completed');
  });
});

describe('discoverHarnessSkillDirs', () => {
  it('scans ~/.config/opencode/skills even when XDG_CONFIG_HOME points elsewhere', async () => {
    const saved = process.env['XDG_CONFIG_HOME'];
    process.env['XDG_CONFIG_HOME'] = join(base, 'elsewhere-config');
    try {
      realFs.mkdirSync(join(home, '.config', 'opencode', 'skills'), { recursive: true });
      const dirs = await discoverHarnessSkillDirs(home);
      expect(dirs).toContain(join(home, '.config', 'opencode', 'skills'));
    } finally {
      if (saved === undefined) delete process.env['XDG_CONFIG_HOME'];
      else process.env['XDG_CONFIG_HOME'] = saved;
    }
  });
});
