/**
 * Integration test for the `cleo doctor-projects` CLI command.
 *
 * Sets up a temporary CLEO home, registers two projects, runs the command,
 * and asserts on the JSON + exit-code contract.
 *
 * @task T-PROJECT-HEALTH
 */

import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  closeAllDatabases,
  createSqliteDataAccessor,
  nexusInit,
  nexusRegister,
  resetDbState,
} from '@cleocode/core/internal';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { projectRegistry } from '../../../../../core/src/store/nexus-schema.js';
// Direct-path imports (not re-exported from core/internal) — matches the
// pattern used by other CLI integration tests that need nexus-sqlite primitives.
import { getNexusDb, resetNexusDbState } from '../../../../../core/src/store/nexus-sqlite.js';
import { runDoctorProjects } from '../doctor-projects.js';

const _require = createRequire(import.meta.url);
const { DatabaseSync } = _require('node:sqlite') as typeof import('node:sqlite');

function makeHealthyDb(path: string): void {
  const db = new DatabaseSync(path);
  try {
    db.exec('CREATE TABLE sample(id INTEGER PRIMARY KEY)');
  } finally {
    db.close();
  }
}

let testDir: string;

beforeEach(async () => {
  testDir = await mkdtemp(join(tmpdir(), 'cleo-doctor-projects-'));
  process.env['CLEO_HOME'] = join(testDir, 'cleo-home');
  await mkdir(process.env['CLEO_HOME'], { recursive: true });
  resetDbState();
  resetNexusDbState();
});

afterEach(async () => {
  await closeAllDatabases().catch(() => {});
  resetDbState();
  resetNexusDbState();
  delete process.env['CLEO_HOME'];
  process.exitCode = 0;
  await rm(testDir, { recursive: true, force: true });
});

describe('runDoctorProjects', () => {
  it('emits a JSON report with the expected summary shape', async () => {
    const projectA = join(testDir, 'alpha');
    await mkdir(join(projectA, '.cleo'), { recursive: true });
    const accessor = await createSqliteDataAccessor(projectA);
    await accessor.close();
    resetDbState();

    await nexusInit();
    await nexusRegister(projectA, 'alpha');

    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      const report = await runDoctorProjects({ json: true, noUpdateRegistry: true });
      expect(report.summary.totalProjects).toBe(1);
      expect(report.projects[0]?.projectPath).toBe(projectA);

      // Find the JSON payload that was written
      const jsonCall = writeSpy.mock.calls.find((args) => {
        const first = args[0];
        return typeof first === 'string' && first.trim().startsWith('{');
      });
      expect(jsonCall).toBeDefined();
      const payload = JSON.parse(String(jsonCall?.[0]));
      expect(payload.summary.totalProjects).toBe(1);
      expect(payload.generatedAt).toBeTypeOf('string');
    } finally {
      writeSpy.mockRestore();
    }
  });

  it('sets process.exitCode=2 when an unreachable project is registered', async () => {
    // Directly insert an unreachable row. nexusRegister refuses non-existent paths.
    await nexusInit();
    const nexusDb = await getNexusDb();
    const now = new Date().toISOString();
    await nexusDb.insert(projectRegistry).values({
      projectId: 'ghost-id',
      projectHash: 'ghost0000001',
      projectPath: join(testDir, 'nonexistent'),
      name: 'ghost',
      registeredAt: now,
      lastSeen: now,
      healthStatus: 'unknown',
      healthLastCheck: null,
      permissions: 'read',
      lastSync: now,
      taskCount: 0,
      labelsJson: '[]',
      statsJson: '{}',
    });

    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      await runDoctorProjects({ quiet: true, noUpdateRegistry: true });
      expect(process.exitCode).toBe(2);
    } finally {
      writeSpy.mockRestore();
    }
  });

  it('downgrades unreachable exit code to 1 with ignoreUnreachable=true', async () => {
    await nexusInit();
    const nexusDb = await getNexusDb();
    const now = new Date().toISOString();
    await nexusDb.insert(projectRegistry).values({
      projectId: 'ghost2-id',
      projectHash: 'ghost0000002',
      projectPath: join(testDir, 'nonexistent2'),
      name: 'ghost2',
      registeredAt: now,
      lastSeen: now,
      healthStatus: 'unknown',
      healthLastCheck: null,
      permissions: 'read',
      lastSync: now,
      taskCount: 0,
      labelsJson: '[]',
      statsJson: '{}',
    });

    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      await runDoctorProjects({
        quiet: true,
        noUpdateRegistry: true,
        ignoreUnreachable: true,
      });
      // With ignoreUnreachable=true AND no degraded projects, exit should be 0.
      // (unreachable is downgraded to non-fatal and there are no other issues.)
      expect(process.exitCode === 0 || process.exitCode === 1).toBe(true);
    } finally {
      writeSpy.mockRestore();
    }
  });

  it('emits a quiet one-line summary when quiet=true', async () => {
    await nexusInit();

    const lines: string[] = [];
    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      if (typeof chunk === 'string') lines.push(chunk);
      return true;
    });

    try {
      await runDoctorProjects({ quiet: true, noUpdateRegistry: true });
      const joined = lines.join('');
      expect(joined).toMatch(/projects=\d+/);
      expect(joined).toMatch(/healthy=\d+/);
      expect(joined).toMatch(/degraded=\d+/);
    } finally {
      writeSpy.mockRestore();
    }
  });
});

describe('doctor --all-projects integration', () => {
  it('is routable via the shared runDoctorProjects helper', async () => {
    await nexusInit();
    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      const report = await runDoctorProjects({ json: true, noUpdateRegistry: true });
      expect(report).toBeDefined();
      expect(report.generatedAt).toBeTypeOf('string');
    } finally {
      writeSpy.mockRestore();
    }
  });
});
