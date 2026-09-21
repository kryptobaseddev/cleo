/**
 * Tests for CleoOS doctor subprocess root handling.
 *
 * The doctor command shells out to `cleo admin smoke --provider <id>`. When run
 * via `pnpm --filter @cleocode/cleo-os exec`, Node starts inside
 * `packages/cleo-os`, but `INIT_CWD` still points at the caller's project root.
 *
 * @packageDocumentation
 */

import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProviderMatrix } from '../../registry/provider-matrix.js';
import {
  renderDoctorReport,
  renderProviderMatrix,
  resolveSmokeExecOptions,
  resolveSmokeProjectRoot,
  runDoctor,
} from '../doctor.js';

vi.mock('node:child_process', () => ({
  execFile: vi.fn(() => {
    throw new Error('Unexpected provider subprocess in source diagnostics');
  }),
}));

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

describe('provider verification rendering', () => {
  it('labels source hints and every independent stage without asserting installation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cleo-provider-render-'));
    try {
      await mkdir(join(root, 'codex'));
      await writeFile(join(root, 'codex', 'spawn.ts'), '// stub');
      const rows = await new ProviderMatrix(root).getMatrix();
      const text = renderProviderMatrix(rows);
      expect(text).toContain('Source directories: 1');
      expect(text).toContain('Spawn source files: 1');
      expect(text).toContain(
        'external-cli: declared=unverified, installed=unverified, delivery=unverified, workflow=unverified, lifecycle=unverified',
      );
      expect(text).toContain(
        'programmatic-spawn: declared=unverified, installed=unverified, delivery=unverified, workflow=unverified, lifecycle=unverified',
      );
      expect(text).not.toContain('Installed:');
      expect(text).not.toContain('providers ready');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('does not promote smoke success to live repair or lifecycle certification', async () => {
    const rows = await new ProviderMatrix(
      join(tmpdir(), 'absent-provider-render-fixture'),
    ).getMatrix();
    const text = renderDoctorReport({
      providerRows: rows,
      agents: [],
      seedCount: 0,
      userCount: 0,
      policyResults: [],
      smokeResults: [{ providerId: 'codex', passed: true, message: 'PASS' }],
      issueCount: 0,
    });
    expect(text).toContain('provider verification incomplete');
    expect(text).toContain('not live repair or lifecycle certification');
    expect(text).toContain('workflow=unverified');
    expect(text).toContain('lifecycle=unverified');
    expect(text).not.toContain('Result: PASS');
  });

  it('keeps failed source diagnostics visible in compact provider output', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cleo-provider-render-failure-'));
    try {
      await writeFile(join(root, 'codex'), 'not a directory');
      const rows = await new ProviderMatrix(root).getMatrix();
      const text = renderProviderMatrix(rows);
      expect(text).toContain('codex: source=failed');
      expect(text).toContain(`Source diagnostic: Expected directory at ${join(root, 'codex')}`);
      expect(text).toContain('installed=unverified');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

it('does not launch provider smoke from source directory hints', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cleo-provider-no-launch-'));
  try {
    await mkdir(join(root, 'codex'));
    await writeFile(join(root, 'codex', 'spawn.ts'), '// source only');
    const rows = await new ProviderMatrix(root).getMatrix();
    const matrix = vi.spyOn(ProviderMatrix.prototype, 'getMatrix').mockResolvedValue(rows);
    try {
      const report = await runDoctor();
      expect(report.smokeResults).toEqual([]);
      expect(execFile).not.toHaveBeenCalled();
    } finally {
      matrix.mockRestore();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it('counts and explains a failed capability independently of source absence', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cleo-provider-failed-capability-'));
  try {
    const rows = await new ProviderMatrix(root).getMatrix();
    const row = rows[0];
    if (!row) throw new Error('Expected canonical provider row');
    row.externalCli = {
      ...row.externalCli,
      levels: {
        ...row.externalCli.levels,
        lifecycle: { status: 'failed', reason: 'Observed child survived teardown', evidence: [] },
      },
    };
    const matrix = vi.spyOn(ProviderMatrix.prototype, 'getMatrix').mockResolvedValue(rows);
    try {
      const report = await runDoctor();
      expect(report.issueCount).toBe(1);
      const text = renderDoctorReport(report);
      expect(text).toContain('lifecycle=failed');
      expect(text).toContain('Observed child survived teardown');
      expect(text).toContain('Result: FAIL (1 issue)');
    } finally {
      matrix.mockRestore();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
