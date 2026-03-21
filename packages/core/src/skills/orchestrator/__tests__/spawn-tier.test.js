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
import { beforeEach, describe, expect, it, vi } from 'vitest';
// Mock dependencies so we don't hit the filesystem
vi.mock('node:fs', () => ({
    existsSync: vi.fn(() => true),
    readFileSync: vi.fn(),
}));
vi.mock('../../../paths.js', () => ({
    getProjectRoot: vi.fn(() => '/mock/project'),
    getTaskPath: vi.fn(() => '/mock/project/.cleo/tasks.json'),
    getAgentOutputsDir: vi.fn(() => '/mock/project/.cleo/agent-outputs'),
}));
vi.mock('../../discovery.js', () => ({
    findSkill: vi.fn(),
    mapSkillName: vi.fn(() => ({ canonical: 'task-executor', mapped: true })),
}));
vi.mock('../../../store/data-accessor.js', () => ({
    getAccessor: vi.fn().mockResolvedValue({
        loadSingleTask: vi.fn().mockResolvedValue({
            id: 'T100',
            title: 'Test task',
            status: 'active',
            description: 'A test',
            priority: 'medium',
            labels: [],
            depends: [],
        }),
        loadTasks: vi.fn().mockResolvedValue([]),
        queryTasks: vi.fn().mockResolvedValue({ tasks: [], total: 0 }),
    }),
}));
import { existsSync, readFileSync } from 'node:fs';
import { findSkill } from '../../discovery.js';
import { injectProtocol, orchestratorSpawnSkill } from '../../injection/subagent.js';
import { buildPrompt, spawn, spawnBatch } from '../spawn.js';
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
            dirName: 'test-skill',
            path: '/mock/project/skills/test-skill',
            skillMdPath: '/mock/project/skills/test-skill/SKILL.md',
            frontmatter: {},
            content: '# Test Skill\nDo the thing.',
        });
    });
    it('passes tier 0 through — output excludes standard and orchestrator', async () => {
        vi.mocked(readFileSync).mockImplementation((path) => {
            const p = String(path);
            if (p.includes('subagent-protocol-base'))
                return TIERED_PROTOCOL;
            if (p.includes('tasks.json'))
                return MOCK_TASKS_JSON;
            return '';
        });
        const result = await orchestratorSpawnSkill('T100', 'test-skill', { TASK_ID: 'T100' }, '/mock/project', 0);
        expect(result).toContain('Minimal Section');
        expect(result).not.toContain('Standard Section');
        expect(result).not.toContain('Orchestrator Section');
        expect(result).toContain('Test Skill');
    });
    it('passes tier 1 through — output includes minimal + standard', async () => {
        vi.mocked(readFileSync).mockImplementation((path) => {
            const p = String(path);
            if (p.includes('subagent-protocol-base'))
                return TIERED_PROTOCOL;
            if (p.includes('tasks.json'))
                return MOCK_TASKS_JSON;
            return '';
        });
        const result = await orchestratorSpawnSkill('T100', 'test-skill', { TASK_ID: 'T100' }, '/mock/project', 1);
        expect(result).toContain('Minimal Section');
        expect(result).toContain('Standard Section');
        expect(result).not.toContain('Orchestrator Section');
    });
    it('passes tier 2 through — output includes all tiers', async () => {
        vi.mocked(readFileSync).mockImplementation((path) => {
            const p = String(path);
            if (p.includes('subagent-protocol-base'))
                return TIERED_PROTOCOL;
            if (p.includes('tasks.json'))
                return MOCK_TASKS_JSON;
            return '';
        });
        const result = await orchestratorSpawnSkill('T100', 'test-skill', { TASK_ID: 'T100' }, '/mock/project', 2);
        expect(result).toContain('Minimal Section');
        expect(result).toContain('Standard Section');
        expect(result).toContain('Orchestrator Section');
    });
    it('omitting tier includes full protocol (backward compat)', async () => {
        vi.mocked(readFileSync).mockImplementation((path) => {
            const p = String(path);
            if (p.includes('subagent-protocol-base'))
                return TIERED_PROTOCOL;
            if (p.includes('tasks.json'))
                return MOCK_TASKS_JSON;
            return '';
        });
        // No tier parameter — should pass through unfiltered
        const result = await orchestratorSpawnSkill('T100', 'test-skill', { TASK_ID: 'T100' }, '/mock/project');
        // All tier content present because no filtering was applied
        expect(result).toContain('TIER:minimal');
        expect(result).toContain('TIER:standard');
        expect(result).toContain('TIER:orchestrator');
    });
    it('throws when skill not found', async () => {
        vi.mocked(findSkill).mockReturnValue(null);
        await expect(orchestratorSpawnSkill('T100', 'nonexistent', { TASK_ID: 'T100' }, '/mock/project', 0)).rejects.toThrow(/Skill not found/);
    });
});
describe('injectProtocol tier parameter', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(existsSync).mockReturnValue(true);
    });
    it('tier undefined leaves protocol unfiltered', async () => {
        vi.mocked(readFileSync).mockImplementation((path) => {
            const p = String(path);
            if (p.includes('subagent-protocol-base'))
                return TIERED_PROTOCOL;
            return '';
        });
        const result = await injectProtocol('# Skill', 'T100', {}, '/mock/project', undefined);
        expect(result).toContain('TIER:minimal');
        expect(result).toContain('TIER:orchestrator');
    });
    it('tier 0 filters to minimal only', async () => {
        vi.mocked(readFileSync).mockImplementation((path) => {
            const p = String(path);
            if (p.includes('subagent-protocol-base'))
                return TIERED_PROTOCOL;
            return '';
        });
        const result = await injectProtocol('# Skill', 'T100', {}, '/mock/project', 0);
        expect(result).toContain('Minimal Section');
        expect(result).not.toContain('Standard Section');
        expect(result).not.toContain('Orchestrator Section');
    });
});
describe('buildPrompt tier passthrough', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(existsSync).mockReturnValue(true);
        vi.mocked(readFileSync).mockImplementation((path) => {
            const p = String(path);
            if (p.includes('subagent-protocol-base'))
                return TIERED_PROTOCOL;
            if (p.includes('todo') || p.includes('tasks'))
                return MOCK_TASKS_JSON;
            return '';
        });
        vi.mocked(findSkill).mockReturnValue({
            name: 'task-executor',
            dirName: 'task-executor',
            path: '/mock/project/skills/task-executor',
            skillMdPath: '/mock/project/skills/task-executor/SKILL.md',
            frontmatter: {},
            content: '# Task Executor\nExecute {{TASK_ID}}.',
        });
    });
    it('buildPrompt with tier 0 filters protocol to minimal only', async () => {
        const result = await buildPrompt('T100', 'TASK-EXECUTOR', '/mock/project', 0);
        expect(result.prompt).toContain('Minimal Section');
        expect(result.prompt).not.toContain('Standard Section');
        expect(result.prompt).not.toContain('Orchestrator Section');
        expect(result.prompt).toContain('SUBAGENT PROTOCOL');
    });
    it('buildPrompt with tier 1 includes minimal + standard', async () => {
        const result = await buildPrompt('T100', 'TASK-EXECUTOR', '/mock/project', 1);
        expect(result.prompt).toContain('Minimal Section');
        expect(result.prompt).toContain('Standard Section');
        expect(result.prompt).not.toContain('Orchestrator Section');
    });
    it('buildPrompt without tier includes full protocol', async () => {
        const result = await buildPrompt('T100', 'TASK-EXECUTOR', '/mock/project');
        // No tier = unfiltered, so tier markers present
        expect(result.prompt).toContain('TIER:minimal');
        expect(result.prompt).toContain('TIER:orchestrator');
    });
    it('buildPrompt injects task context', async () => {
        const result = await buildPrompt('T100', 'TASK-EXECUTOR', '/mock/project', 0);
        expect(result.prompt).toContain('Task Context');
        expect(result.prompt).toContain('T100');
    });
    it('spawn passes tier through', async () => {
        const result = await spawn('T100', 'TASK-EXECUTOR', '/mock/project', 0);
        expect(result.prompt).toContain('Minimal Section');
        expect(result.prompt).not.toContain('Orchestrator Section');
        expect(result.spawnTimestamp).toBeDefined();
    });
    it('spawnBatch passes tier through', async () => {
        const result = await spawnBatch(['T100'], 'TASK-EXECUTOR', '/mock/project', 0);
        expect(result.succeeded).toBe(1);
        expect(result.spawns[0].result.prompt).toContain('Minimal Section');
        expect(result.spawns[0].result.prompt).not.toContain('Orchestrator Section');
    });
});
//# sourceMappingURL=spawn-tier.test.js.map