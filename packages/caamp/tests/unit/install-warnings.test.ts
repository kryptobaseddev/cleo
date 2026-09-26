/**
 * Unit tests for skill-install gate diagnostics routing.
 *
 * @remarks
 * T9770 moved the install gate's degradation notices off stderr and into the
 * active LAFS {@link WarningCollector}. T12384 then changed what "degradation"
 * means: the gate now FAILS CLOSED when `@cleocode/core` cannot be loaded, so
 * the old `W_CORE_UNAVAILABLE` warn-and-install path is gone — that case is a
 * refusal (`E_SKILL_GATE_UNAVAILABLE`), not a warning.
 *
 * What remains a warning is an audit-log write failure after an operator has
 * already authorised a `--force` bypass: it routes to the collector as
 * `W_AUDIT_LOG_FAILED`, and stderr stays silent.
 *
 * @task T9770
 * @task T12384
 * @epic T9763
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WarningCollector, withWarningCollector } from '@cleocode/lafs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  __installPipelineTesting,
  type ResolvedSkillSource,
  runSkillInstallGate,
  type SkillGateModules,
} from '../../src/core/skills/install-pipeline.js';

function gateStub(overrides: Partial<SkillGateModules> = {}): SkillGateModules {
  return {
    scanSkill: () => ({
      skillName: 'test-skill',
      source: 'local:/tmp/test-skill',
      trustLevel: 'community',
      verdict: 'caution',
      findings: [],
      scannedAt: new Date().toISOString(),
      summary: 'fixture',
    }),
    shouldAllowInstall: () => ({ decision: 'allow', reason: 'fixture' }),
    evaluateFederationInstallGate: () => ({
      decision: 'allow',
      reason: 'fixture',
      peer: null,
      isFederationSource: false,
      computedChecksum: null,
      expectedChecksum: null,
    }),
    recordTrustBypass: () => ({}),
    ...overrides,
  };
}

let dir: string;
let source: ResolvedSkillSource;
let stderrSpy: ReturnType<typeof vi.spyOn>;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'caamp-gate-warn-'));
  await mkdir(join(dir, 'test-skill'), { recursive: true });
  await writeFile(join(dir, 'test-skill', 'SKILL.md'), '---\nname: test-skill\n---\n');
  source = {
    localPath: join(dir, 'test-skill'),
    skillName: 'test-skill',
    sourceValue: join(dir, 'test-skill'),
    sourceType: 'local',
  };
  // Sentinel: any stderr write during the test counts as pollution.
  stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
});

afterEach(async () => {
  stderrSpy.mockRestore();
  __installPipelineTesting.setGateLoader(null);
  await rm(dir, { recursive: true, force: true });
});

describe('skill install gate — diagnostics routing (T9770, T12384)', () => {
  it('refuses (does not warn-and-install) when core cannot be loaded', async () => {
    const collector = new WarningCollector();
    __installPipelineTesting.setGateLoader(() => Promise.reject(new Error('MODULE_NOT_FOUND')));

    const outcome = await withWarningCollector(collector, async () =>
      runSkillInstallGate(source).catch((err: Error) => err),
    );

    expect(outcome).toMatchObject({
      code: 'E_SKILL_GATE_UNAVAILABLE',
      details: { cause: 'MODULE_NOT_FOUND' },
    });
    // No W_CORE_UNAVAILABLE: a missing gate is a refusal, not a notice.
    expect(collector.drain() ?? []).toHaveLength(0);
    expect(stderrSpy).not.toHaveBeenCalled();
  });

  it('routes W_AUDIT_LOG_FAILED into the active WarningCollector when recordTrustBypass throws', async () => {
    const collector = new WarningCollector();
    __installPipelineTesting.setGateLoader(async () =>
      gateStub({
        recordTrustBypass: () => {
          throw new Error('disk full');
        },
      }),
    );

    const report = await withWarningCollector(collector, async () =>
      runSkillInstallGate(source, { force: true }),
    );

    expect(report.bypassed).toBe(true);
    const drained = collector.drain();
    expect(drained).toHaveLength(1);
    const [warning] = drained!;
    expect(warning.code).toBe('W_AUDIT_LOG_FAILED');
    expect(warning.severity).toBe('warn');
    expect(warning.message).toBe('trust-bypass audit record failed');
    expect(warning.context).toMatchObject({ error: 'disk full' });
    expect(stderrSpy).not.toHaveBeenCalled();
  });

  it('is silent when the gate allows and no bypass is needed', async () => {
    __installPipelineTesting.setGateLoader(async () => gateStub());

    const report = await runSkillInstallGate(source);

    expect(report.bypassed).toBe(false);
    expect(stderrSpy).not.toHaveBeenCalled();
  });
});
