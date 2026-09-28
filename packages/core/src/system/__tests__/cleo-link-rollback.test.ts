/**
 * `repairCleoLink` when link creation throws AFTER the preserve-rename
 * (T12596 review, MEDIUM): the previous `~/.cleo` entry must be put back, and
 * the receipt log must hold an `intent` line written before anything moved
 * plus a `rolled-back` line — so a crash can never leave the user's data at
 * `.preserved-*` with no record of where it went.
 *
 * `symlink` from `node:fs/promises` is forced to throw (as on Windows without
 * Developer Mode or admin) only while `failSymlink` is set; the rollback's own
 * `symlink` for a dangling link goes through the real implementation.
 *
 * @task T12596
 */

import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const control = vi.hoisted(() => ({ failSymlink: false }));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    symlink: vi.fn(async (...args: Parameters<typeof actual.symlink>) => {
      if (control.failSymlink) {
        control.failSymlink = false; // only the repair's link creation fails
        throw Object.assign(new Error('EPERM: operation not permitted, symlink'), {
          code: 'EPERM',
        });
      }
      return actual.symlink(...args);
    }),
  };
});

const { CleoLinkRepairError, repairCleoLink } = await import('../cleo-link.js');

let base: string;
let link: string;
let cleoHome: string;

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'cleo-link-rollback-'));
  link = join(base, 'home', '.cleo');
  cleoHome = join(base, 'home', 'Library', 'Application Support', 'cleo');
  mkdirSync(join(base, 'home'), { recursive: true });
  control.failSymlink = true;
});

afterEach(() => {
  control.failSymlink = false;
  rmSync(base, { recursive: true, force: true });
});

function phases(): string[] {
  return readFileSync(join(cleoHome, 'audit', 'cleo-link-repairs.jsonl'), 'utf-8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l).phase as string);
}

async function repairExpectingFailure() {
  const err = await repairCleoLink({ path: link, canonicalTarget: cleoHome }).catch(
    (e: Error) => e,
  );
  expect(err).toBeInstanceOf(CleoLinkRepairError);
  return err as InstanceType<typeof CleoLinkRepairError>;
}

describe('repairCleoLink rollback when link creation throws after the rename', () => {
  it('restores a real DIRECTORY with its contents and leaves no .preserved-* behind', async () => {
    mkdirSync(link);
    writeFileSync(join(link, 'user-data.txt'), 'keep me');
    const err = await repairExpectingFailure();
    expect(err.code).toBe('E_CLEO_LINK_REPAIR_FAILED');
    expect(lstatSync(link).isDirectory()).toBe(true);
    expect(readFileSync(join(link, 'user-data.txt'), 'utf-8')).toBe('keep me');
    expect(readdirSync(join(base, 'home')).filter((n) => n.includes('.preserved-'))).toEqual([]);
    expect(phases()).toEqual(['intent', 'rolled-back']);
    expect(err.receipt.preservedAt).not.toBeNull();
  });

  it('restores a live FOREIGN link with its original target', async () => {
    const elsewhere = join(base, 'elsewhere');
    mkdirSync(elsewhere);
    symlinkSync(elsewhere, link);
    await repairExpectingFailure();
    expect(readlinkSync(link)).toBe(elsewhere);
    expect(phases()).toEqual(['intent', 'rolled-back']);
  });

  it('restores a DANGLING link with its original target', async () => {
    symlinkSync('/home/nobody/.local/share/cleo', link);
    await repairExpectingFailure();
    expect(readlinkSync(link)).toBe('/home/nobody/.local/share/cleo');
    expect(existsSync(link)).toBe(false);
    expect(phases()).toEqual(['intent', 'rolled-back']);
  });

  it('writes the intent line BEFORE the entry moves (it names where the entry goes)', async () => {
    mkdirSync(link);
    const err = await repairExpectingFailure();
    const intent = JSON.parse(
      readFileSync(join(cleoHome, 'audit', 'cleo-link-repairs.jsonl'), 'utf-8').split(
        '\n',
      )[0] as string,
    );
    expect(intent.phase).toBe('intent');
    expect(intent.preservedAt).toBe(err.receipt.preservedAt);
    expect(intent.before.state).toBe('directory');
  });
});
