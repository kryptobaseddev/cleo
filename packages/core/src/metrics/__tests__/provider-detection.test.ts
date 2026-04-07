import type { DetectionResult } from '@cleocode/caamp';
import { describe, expect, it } from 'vitest';
import { selectRuntimeProviderContext } from '../provider-detection.js';

function makeDetection(overrides: Partial<DetectionResult>): DetectionResult {
  return {
    provider: {
      id: 'claude-code',
      toolName: 'Claude Code',
      vendor: 'Anthropic',
      agentFlag: 'claude',
      aliases: ['claude'],
      pathGlobal: '',
      pathProject: '',
      instructFile: 'CLAUDE.md',
      pathSkills: '',
      pathProjectSkills: '',
      detection: { methods: ['binary'], binary: 'claude' },
      priority: 'high',
      status: 'active',
      agentSkillsCompatible: true,
      capabilities: {
        mcp: {
          configKey: 'mcpServers',
          configFormat: 'json',
          configPathGlobal: '',
          configPathProject: '.claude.json',
          supportedTransports: ['stdio'],
          supportsHeaders: false,
        },
        harness: null,
        skills: { agentsGlobalPath: null, agentsProjectPath: null, precedence: 'agents-first' },
        hooks: {
          supported: [],
          hookConfigPath: null,
          hookConfigPathProject: null,
          hookFormat: null,
          nativeEventCatalog: 'canonical',
          canInjectSystemPrompt: false,
          canBlockTools: false,
        },
        spawn: {
          supportsSubagents: true,
          supportsProgrammaticSpawn: true,
          supportsInterAgentComms: false,
          supportsParallelSpawn: true,
          spawnMechanism: 'cli',
          spawnCommand: null,
        },
      },
    },
    installed: true,
    methods: ['binary'],
    projectDetected: false,
    ...overrides,
  };
}

describe('selectRuntimeProviderContext', () => {
  it('prefers explicit runtime hint matches from argv', () => {
    const detections = [
      makeDetection({}),
      makeDetection({
        provider: {
          ...makeDetection({}).provider,
          id: 'opencode',
          toolName: 'OpenCode',
          vendor: 'OpenCode',
          agentFlag: 'opencode',
          aliases: ['open-code'],
          instructFile: 'AGENTS.md',
        },
      }),
    ];

    const result = selectRuntimeProviderContext(detections, {
      argv: ['/usr/bin/node', '/usr/local/bin/opencode'],
      env: {},
    });

    expect(result.runtimeProviderId).toBe('opencode');
    expect(result.runtimeToolName).toBe('OpenCode');
  });

  it('falls back to a single project-detected provider', () => {
    const detections = [
      makeDetection({ projectDetected: true }),
      makeDetection({
        provider: {
          ...makeDetection({}).provider,
          id: 'cursor',
          toolName: 'Cursor',
          vendor: 'Cursor',
          agentFlag: 'cursor',
          aliases: ['cursor-ai'],
        },
        projectDetected: false,
      }),
    ];

    const result = selectRuntimeProviderContext(detections, {
      argv: ['/usr/bin/node', '/usr/local/bin/node'],
      env: {},
    });

    expect(result.runtimeProviderId).toBe('claude-code');
    expect(result.inferredModelProvider).toBe('anthropic');
  });

  it('returns candidate ids when no single runtime provider can be chosen', () => {
    const detections = [
      makeDetection({}),
      makeDetection({
        provider: {
          ...makeDetection({}).provider,
          id: 'cursor',
          toolName: 'Cursor',
          vendor: 'Cursor',
          agentFlag: 'cursor',
          aliases: ['cursor-ai'],
        },
      }),
    ];

    const result = selectRuntimeProviderContext(detections, {
      argv: ['/usr/bin/node', '/usr/local/bin/node'],
      env: {},
    });

    expect(result.runtimeProviderId).toBeUndefined();
    expect(result.runtimeCandidates).toEqual(['claude-code', 'cursor']);
  });
});
