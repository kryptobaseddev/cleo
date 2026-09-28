/**
 * `~/.cleo` link audit/repair and the global hub it feeds (T12596).
 *
 * The defect: on macOS `~/.cleo` was a dotfiles-carried link to a Linux path
 * (`/home/<user>/.local/share/cleo`). It dangled, `existsSync` reported it
 * ABSENT, bootstrap's `symlink()` then failed with EEXIST, and the hub
 * reference `@~/.cleo/templates/CLEO-INJECTION.md` delivered nothing to every
 * harness. These tests run against a sandboxed HOME and CLEO_HOME.
 *
 * @task T12596
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
import { join, resolve } from 'node:path';
import { resolveInstructionDelivery } from '@cleocode/caamp';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type BootstrapContext, ensureCleoSymlink } from '../../bootstrap.js';
import {
  auditCleoLink,
  CANONICAL_HUB_TEMPLATE_REF,
  repairCleoLink,
  resolveGlobalHubContent,
  wouldBindRealHomeToTemp,
} from '../cleo-link.js';

const TEMPLATE = readFileSync(
  resolve(__dirname, '..', '..', '..', 'templates', 'CLEO-INJECTION.md'),
  'utf-8',
);
const ASK_RULE = '**Ask the owner.**';

let base: string;
let home: string;
let cleoHome: string;
let link: string;
const saved: Record<string, string | undefined> = {};

beforeEach(async () => {
  base = mkdtempSync(join(tmpdir(), 'cleo-link-'));
  home = join(base, 'home');
  cleoHome = join(home, 'Library', 'Application Support', 'cleo');
  link = join(home, '.cleo');
  mkdirSync(join(cleoHome, 'templates'), { recursive: true });
  writeFileSync(join(cleoHome, 'templates', 'CLEO-INJECTION.md'), TEMPLATE);
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

const opts = () => ({ path: link, canonicalTarget: cleoHome });

describe('auditCleoLink', () => {
  it('classifies a dangling link as dangling, not absent', () => {
    symlinkSync('/home/nobody/.local/share/cleo', link);
    expect(existsSync(link)).toBe(false); // the trap: existsSync follows the link
    const audit = auditCleoLink(opts());
    expect(audit.state).toBe('dangling');
    expect(audit.target).toBe('/home/nobody/.local/share/cleo');
    expect(audit.hubReferenceResolves).toBe(false);
    expect(audit.remedy).toBe('cleo doctor global-delivery --repair');
  });

  it('classifies canonical, foreign, directory, absent and other', () => {
    expect(auditCleoLink(opts()).state).toBe('absent');
    symlinkSync(cleoHome, link);
    expect(auditCleoLink(opts())).toMatchObject({ state: 'canonical', hubReferenceResolves: true });
    rmSync(link);
    const elsewhere = join(base, 'elsewhere');
    mkdirSync(elsewhere);
    symlinkSync(elsewhere, link);
    expect(auditCleoLink(opts()).state).toBe('foreign');
    rmSync(link);
    mkdirSync(link);
    expect(auditCleoLink(opts()).state).toBe('directory');
    rmSync(link, { recursive: true });
    writeFileSync(link, 'x');
    expect(auditCleoLink(opts())).toMatchObject({
      state: 'other',
      repairable: false,
      remedy: null,
    });
  });
});

describe('repairCleoLink', () => {
  it('relinks a dangling link and appends a receipt', async () => {
    symlinkSync('/home/nobody/.local/share/cleo', link);
    const { audit, receipt } = await repairCleoLink(opts());
    expect(audit).toMatchObject({ state: 'canonical', hubReferenceResolves: true });
    expect(receipt).toMatchObject({
      action: 'relinked',
      before: { state: 'dangling', target: '/home/nobody/.local/share/cleo' },
      after: { state: 'canonical' },
      preservedAt: null,
    });
    const log = readFileSync(receipt.receiptLog as string, 'utf-8')
      .trim()
      .split('\n');
    expect(JSON.parse(log.at(-1) as string).receiptId).toBe(receipt.receiptId);
  });

  it('dry run plans the receipt without touching disk', async () => {
    symlinkSync('/home/nobody/.local/share/cleo', link);
    const { receipt } = await repairCleoLink({ ...opts(), dryRun: true });
    expect(receipt.action).toBe('relinked');
    expect(receipt.receiptLog).toBeNull();
    expect(readlinkSync(link)).toBe('/home/nobody/.local/share/cleo');
  });

  it('preserves a live foreign link beside the new one (reversible)', async () => {
    const elsewhere = join(base, 'elsewhere');
    mkdirSync(elsewhere);
    symlinkSync(elsewhere, link);
    const { receipt } = await repairCleoLink(opts());
    expect(receipt.action).toBe('relinked');
    expect(lstatSync(receipt.preservedAt as string).isSymbolicLink()).toBe(true);
    expect(readlinkSync(receipt.preservedAt as string)).toBe(elsewhere);
    expect(auditCleoLink(opts()).state).toBe('canonical');
  });

  it('bootstrap-style repair (states filter) refuses a foreign link', async () => {
    const elsewhere = join(base, 'elsewhere');
    mkdirSync(elsewhere);
    symlinkSync(elsewhere, link);
    const { receipt } = await repairCleoLink({ ...opts(), states: ['absent', 'dangling'] });
    expect(receipt.action).toBe('refused');
    expect(readlinkSync(link)).toBe(elsewhere);
  });

  it('refuses a regular file', async () => {
    writeFileSync(link, 'x');
    const { receipt } = await repairCleoLink(opts());
    expect(receipt.action).toBe('refused');
    expect(readFileSync(link, 'utf-8')).toBe('x');
  });

  it('never binds a real (non-temp) ~/.cleo to a temp directory', () => {
    expect(wouldBindRealHomeToTemp('/Users/someone/.cleo', join(tmpdir(), 'x'))).toBe(true);
    expect(wouldBindRealHomeToTemp(join(tmpdir(), 'h', '.cleo'), join(tmpdir(), 'x'))).toBe(false);
  });
});

describe('global hub delivery after install (AC: the delivered reference exists on disk)', () => {
  it('bootstrap step 0.5 repairs a dangling link and the hub reference then delivers the protocol', async () => {
    symlinkSync('/home/nobody/.local/share/cleo', link);
    const ctx: BootstrapContext = { created: [], warnings: [], isDryRun: false };
    await ensureCleoSymlink(ctx);
    expect(ctx.warnings).toEqual([]);
    expect(ctx.created.join('\n')).toContain('relinked');

    const hub = resolveGlobalHubContent(TEMPLATE, opts());
    expect(hub).toMatchObject({ mode: 'reference', content: CANONICAL_HUB_TEMPLATE_REF });
    const delivery = await resolveInstructionDelivery(hub.content, home);
    expect(delivery.findings).toEqual([]);
    expect(delivery.content).toContain(ASK_RULE);
  });

  it('embeds the protocol when the reference cannot resolve, so the hub never delivers nothing', async () => {
    writeFileSync(link, 'not a link');
    const hub = resolveGlobalHubContent(TEMPLATE, opts());
    expect(hub.mode).toBe('embedded');
    expect(hub.content).toContain('cleo doctor global-delivery --repair');
    const delivery = await resolveInstructionDelivery(hub.content, home);
    expect(delivery.findings).toEqual([]);
    expect(delivery.content).toContain(ASK_RULE);
  });
});
