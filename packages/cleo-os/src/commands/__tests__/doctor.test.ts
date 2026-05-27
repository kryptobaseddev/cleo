/**
 * Tests for CleoOS doctor subprocess root handling.
 *
 * The doctor command shells out to `cleo admin smoke --provider <id>`. When run
 * via `pnpm --filter @cleocode/cleo-os exec`, Node starts inside
 * `packages/cleo-os`, but `INIT_CWD` still points at the caller's project root.
 *
 * @packageDocumentation
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveSmokeExecOptions, resolveSmokeProjectRoot } from '../doctor.js';

const ORIGINAL_CLEO_ROOT = process.env['CLEO_ROOT'];
const ORIGINAL_INIT_CWD = process.env['INIT_CWD'];

describe('resolveSmokeExecOptions', () => {
  afterEach(() => {
    if (ORIGINAL_CLEO_ROOT === undefined) {
      delete process.env['CLEO_ROOT'];
    } else {
      process.env['CLEO_ROOT'] = ORIGINAL_CLEO_ROOT;
    }

    if (ORIGINAL_INIT_CWD === undefined) {
      delete process.env['INIT_CWD'];
    } else {
      process.env['INIT_CWD'] = ORIGINAL_INIT_CWD;
    }
  });

  it('prefers explicit CLEO_ROOT over INIT_CWD', async () => {
    const explicitRoot = await mkdtemp(join(tmpdir(), 'cleo-os-explicit-root-'));
    const initRoot = await mkdtemp(join(tmpdir(), 'cleo-os-init-root-'));
    await mkdir(join(explicitRoot, '.cleo'), { recursive: true });
    await mkdir(join(initRoot, '.cleo'), { recursive: true });
    await writeFile(join(explicitRoot, 'AGENTS.md'), '', 'utf-8');
    await writeFile(join(initRoot, 'AGENTS.md'), '', 'utf-8');
    process.env['CLEO_ROOT'] = explicitRoot;
    process.env['INIT_CWD'] = initRoot;

    try {
      const options = resolveSmokeExecOptions();

      expect(options.cwd).toBe(explicitRoot);
      expect(options.env['CLEO_ROOT']).toBe(explicitRoot);
    } finally {
      await rm(explicitRoot, { recursive: true, force: true });
      await rm(initRoot, { recursive: true, force: true });
    }
  });

  it('uses INIT_CWD when package execution changes process.cwd()', async () => {
    const callerRoot = await mkdtemp(join(tmpdir(), 'cleo-os-caller-root-'));
    await mkdir(join(callerRoot, '.cleo'), { recursive: true });
    await writeFile(join(callerRoot, 'AGENTS.md'), '', 'utf-8');
    delete process.env['CLEO_ROOT'];
    process.env['INIT_CWD'] = callerRoot;

    try {
      const options = resolveSmokeExecOptions();

      expect(options.cwd).toBe(callerRoot);
      expect(options.env['CLEO_ROOT']).toBe(callerRoot);
    } finally {
      await rm(callerRoot, { recursive: true, force: true });
    }
  });
});

describe('resolveSmokeProjectRoot', () => {
  it('walks up from a package directory to the nearest CLEO project root', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cleo-os-doctor-root-'));
    const nested = join(root, 'packages', 'cleo-os');
    await mkdir(join(root, '.cleo'), { recursive: true });
    await writeFile(join(root, 'AGENTS.md'), '', 'utf-8');
    await mkdir(nested, { recursive: true });

    try {
      expect(resolveSmokeProjectRoot(nested)).toBe(root);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('skips nested package runtime state when a marked project root exists above it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cleo-os-doctor-nested-'));
    const nested = join(root, 'packages', 'cleo-os');
    await mkdir(join(root, '.cleo'), { recursive: true });
    await mkdir(join(nested, '.cleo'), { recursive: true });
    await writeFile(join(root, 'AGENTS.md'), '', 'utf-8');

    try {
      expect(resolveSmokeProjectRoot(nested)).toBe(root);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
