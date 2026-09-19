/** Code placed in `packages/cleo-os/` per Package-Boundary Check — verified against AGENTS.md. */
import type { KnowledgeDoctorResult } from '@cleocode/contracts';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@cleocode/core/doctor/knowledge', () => ({ runKnowledgeDoctor: vi.fn() }));

import { runKnowledgeDoctor } from '@cleocode/core/doctor/knowledge';
import { PiCodingAgentAdapter } from '../adapter.js';
import { PiWrapper } from '../pi-wrapper.js';

const assessment: KnowledgeDoctorResult = {
  health: {
    coverage: {
      status: 'missing',
      projectId: 'fixture',
      assessedRevision: null,
      indexedRevision: null,
      assessedAt: '2026-09-18T00:00:00Z',
      reasons: ['No graph'],
      evidence: [],
      limitations: ['Static analysis cannot prove all runtime callers.'],
    },
    structure: { status: 'clean', reasons: [], evidence: [] },
    semantics: { status: 'unavailable', reasons: ['Requires caller evidence'], evidence: [] },
    extraction: { status: 'unavailable', reasons: [], evidence: [] },
    findings: [
      {
        id: 'F1',
        projectId: 'fixture',
        affectedRecordIds: ['D001'],
        description: 'Choose sourced authority',
        evidence: [],
        repairClass: 'agent-resolvable',
        state: 'unresolved',
        proposedAction: null,
        verification: ['Fetch sourced successor'],
        recovery: null,
      },
    ],
  },
  stateHash: 'fixture-state',
  proposals: [],
  receipts: [],
  dryRun: false,
};

beforeEach(() => {
  vi.restoreAllMocks();
  vi.mocked(runKnowledgeDoctor).mockReset().mockResolvedValue(assessment);
  vi.spyOn(PiWrapper.prototype, 'start').mockImplementation(async (entry) => entry);
});

describe('foreground shared knowledge integration', () => {
  it('delivers bounded assessment and repair matrix to the existing coding agent', async () => {
    await new PiCodingAgentAdapter().spawn('T123', 'Fix assigned task', { cwd: '/fixture' });
    expect(runKnowledgeDoctor).toHaveBeenCalledWith('/fixture', { taskId: 'T123', budgetMs: 2000 });
    const prompt = vi.mocked(PiWrapper.prototype.start).mock.calls[0]?.[1];
    expect(prompt).toContain('Fix assigned task');
    expect(prompt).toContain('fixture-state');
    expect(prompt).toContain('Choose sourced authority');
    expect(prompt).toContain('UNKNOWN');
    expect(prompt).toContain('permission policy');
    expect(prompt).toContain('No graph');
  });

  it('honors cancellation before assessment and process spawn', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      new PiCodingAgentAdapter().spawn('T123', 'Fix', { signal: controller.signal }),
    ).rejects.toThrow();
    expect(runKnowledgeDoctor).not.toHaveBeenCalled();
    expect(PiWrapper.prototype.start).not.toHaveBeenCalled();
  });
});
