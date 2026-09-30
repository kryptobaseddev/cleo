/**
 * T12512 — `cleo doctor --all-projects` / `cleo doctor-projects` on an
 * unreadable registry: a typed error envelope with exit 75, never the
 * "No projects registered" table with exit 0.
 *
 * Renders a synthetic report, so no store is opened.
 *
 * @task T12512
 */

import type { DbProbeResult, FullHealthReport } from '@cleocode/core/internal';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setFormatContext } from '../../format-context.js';
import { printDoctorProjectsReport } from '../doctor-projects.js';

/** A healthy probe of one database file. */
function probe(path: string): DbProbeResult {
  return {
    path,
    exists: true,
    readable: true,
    sqliteOpenable: true,
    integrityOk: true,
    walSidecarClean: true,
  };
}

/** A report whose registry could not be read. */
function unreadableRegistryReport(): FullHealthReport {
  const generatedAt = new Date().toISOString();
  return {
    global: {
      cleoHome: '/tmp/cleo-home',
      dbs: { nexus: probe('/tmp/cleo-home/cleo.db'), signaldock: probe('/tmp/cleo-home/sd.db') },
      overall: 'unknown',
      issues: ['Registry unreadable: no such table'],
      checkedAt: generatedAt,
    },
    projects: [],
    summary: { totalProjects: 0, healthy: 0, degraded: 0, unreachable: 0, unknown: 0 },
    generatedAt,
    registryError: {
      code: 'E_NEXUS_REGISTRY_READ',
      message: 'Cannot read the project registry (list projects): no such table',
      exitCode: 75,
      fix: 'Run `cleo doctor` to check the global store.',
    },
  };
}

let written: string[];

beforeEach(() => {
  written = [];
  const capture = (chunk: string | Uint8Array): boolean => {
    written.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString());
    return true;
  };
  vi.spyOn(process.stdout, 'write').mockImplementation(capture);
  vi.spyOn(process.stderr, 'write').mockImplementation(capture);
});

afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = 0;
  setFormatContext({ format: 'json', source: 'default', quiet: false });
});

describe('printDoctorProjectsReport with an unreadable registry (T12512)', () => {
  it('JSON: emits an E_NEXUS_REGISTRY_READ error envelope and exits 75', () => {
    setFormatContext({ format: 'json', source: 'default', quiet: false });
    printDoctorProjectsReport(unreadableRegistryReport(), { json: true }, new Map());
    expect(process.exitCode).toBe(75);
    const envelope = JSON.parse(written.join('').trim()) as {
      success: boolean;
      error: { code: number; codeName: string; fix: string };
    };
    expect(envelope.success).toBe(false);
    expect(envelope.error.code).toBe(75);
    expect(envelope.error.codeName).toBe('E_NEXUS_REGISTRY_READ');
    expect(envelope.error.fix).toMatch(/cleo doctor/);
  });

  it('human: reports the error with its fix, never "No projects registered"', () => {
    setFormatContext({ format: 'human', source: 'flag', quiet: false });
    printDoctorProjectsReport(unreadableRegistryReport(), {}, new Map());
    expect(process.exitCode).toBe(75);
    const text = written.join('');
    expect(text).toMatch(/Cannot read the project registry/);
    expect(text).toMatch(/Fix: Run `cleo doctor`/);
    expect(text).not.toMatch(/No projects registered/);
  });
});
