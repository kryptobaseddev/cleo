/**
 * Tests for tier parameter passthrough in orchestrator spawn functions.
 *
 * The orchestrator's spawn.ts itself does not contain tier logic — tier
 * filtering lives in src/core/skills/injection/subagent.ts. These tests
 * verify that orchestratorSpawnSkill correctly passes the tier parameter
 * through to injectProtocol, and that omitting tier preserves backward
 * compatibility (full protocol content injected).
 *
 * @task T5156
 * @epic T5150
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock dependencies so we don't hit the filesystem
vi.mock('node:fs', () => ({
  existsSync: vi.fn(() => true),
  readFileSync: vi.fn(),
}));

vi.mock('../../../paths.js', () => ({
  getProjectRoot: vi.fn(() => '/mock/project'),
  getTaskPath: vi.fn(() => '/mock/project/.cleo/tasks.json'),
}));

vi.mock('../../discovery.js', () => ({
  findSkill: vi.fn(),
}));

import { existsSync, readFileSync } from 'node:fs';
import { findSkill } from '../../discovery.js';
import { injectProtocol, orchestratorSpawnSkill, filterProtocolByTier } from '../../injection/subagent.js';

const TIERED_PROTOCOL = `# Protocol
<!-- TIER:minimal -->
## Minimal Section
Minimal content here.
<!-- /TIER:minimal -->
<!-- TIER:standard -->
## Standard Section
Standard content here.
<!-- /TIER:standard -->
<!-- TIER:orchestrator -->
## Orchestrator Section
Orchestrator content here.
<!-- /TIER:orchestrator -->
## References`;

const MOCK_TASKS_JSON = JSON.stringify({
  tasks: [{ id: 'T100', title: 'Test task', status: 'active', description: 'A test' }],
});

describe('orchestratorSpawnSkill tier passthrough', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(findSkill).mockReturnValue({
      name: 'test-skill',
      path: '/mock/project/skills/test-skill',
      content: '# Test Skill\nDo the thing.',
    });
  });

  it('passes tier 0 through — output excludes standard and orchestrator', () => {
    vi.mocked(readFileSync).mockImplementation((path: unknown) => {
      const p = String(path);
      if (p.includes('subagent-protocol-base')) return TIERED_PROTOCOL;
      if (p.includes('tasks.json')) return MOCK_TASKS_JSON;
      return '';
    });

    const result = orchestratorSpawnSkill('T100', 'test-skill', { TASK_ID: 'T100' }, '/mock/project', 0);

    expect(result).toContain('Minimal Section');
    expect(result).not.toContain('Standard Section');
    expect(result).not.toContain('Orchestrator Section');
    expect(result).toContain('Test Skill');
  });

  it('passes tier 1 through — output includes minimal + standard', () => {
    vi.mocked(readFileSync).mockImplementation((path: unknown) => {
      const p = String(path);
      if (p.includes('subagent-protocol-base')) return TIERED_PROTOCOL;
      if (p.includes('tasks.json')) return MOCK_TASKS_JSON;
      return '';
    });

    const result = orchestratorSpawnSkill('T100', 'test-skill', { TASK_ID: 'T100' }, '/mock/project', 1);

    expect(result).toContain('Minimal Section');
    expect(result).toContain('Standard Section');
    expect(result).not.toContain('Orchestrator Section');
  });

  it('passes tier 2 through — output includes all tiers', () => {
    vi.mocked(readFileSync).mockImplementation((path: unknown) => {
      const p = String(path);
      if (p.includes('subagent-protocol-base')) return TIERED_PROTOCOL;
      if (p.includes('tasks.json')) return MOCK_TASKS_JSON;
      return '';
    });

    const result = orchestratorSpawnSkill('T100', 'test-skill', { TASK_ID: 'T100' }, '/mock/project', 2);

    expect(result).toContain('Minimal Section');
    expect(result).toContain('Standard Section');
    expect(result).toContain('Orchestrator Section');
  });

  it('omitting tier includes full protocol (backward compat)', () => {
    vi.mocked(readFileSync).mockImplementation((path: unknown) => {
      const p = String(path);
      if (p.includes('subagent-protocol-base')) return TIERED_PROTOCOL;
      if (p.includes('tasks.json')) return MOCK_TASKS_JSON;
      return '';
    });

    // No tier parameter — should pass through unfiltered
    const result = orchestratorSpawnSkill('T100', 'test-skill', { TASK_ID: 'T100' }, '/mock/project');

    // All tier content present because no filtering was applied
    expect(result).toContain('TIER:minimal');
    expect(result).toContain('TIER:standard');
    expect(result).toContain('TIER:orchestrator');
  });

  it('throws when skill not found', () => {
    vi.mocked(findSkill).mockReturnValue(null);

    expect(() => {
      orchestratorSpawnSkill('T100', 'nonexistent', { TASK_ID: 'T100' }, '/mock/project', 0);
    }).toThrow(/Skill not found/);
  });
});

describe('injectProtocol tier parameter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(existsSync).mockReturnValue(true);
  });

  it('tier undefined leaves protocol unfiltered', () => {
    vi.mocked(readFileSync).mockImplementation((path: unknown) => {
      const p = String(path);
      if (p.includes('subagent-protocol-base')) return TIERED_PROTOCOL;
      if (p.includes('tasks.json')) return MOCK_TASKS_JSON;
      return '';
    });

    const result = injectProtocol('# Skill', 'T100', {}, '/mock/project', undefined);

    expect(result).toContain('TIER:minimal');
    expect(result).toContain('TIER:orchestrator');
  });

  it('tier 0 filters to minimal only', () => {
    vi.mocked(readFileSync).mockImplementation((path: unknown) => {
      const p = String(path);
      if (p.includes('subagent-protocol-base')) return TIERED_PROTOCOL;
      if (p.includes('tasks.json')) return MOCK_TASKS_JSON;
      return '';
    });

    const result = injectProtocol('# Skill', 'T100', {}, '/mock/project', 0);

    expect(result).toContain('Minimal Section');
    expect(result).not.toContain('Standard Section');
    expect(result).not.toContain('Orchestrator Section');
  });
});
