/**
 * T12482 — the spawn prompt's HITL line names the orchestrator's ask tool.
 *
 * Spawn prompts go to SUBAGENTS, which never ask the human directly: they
 * return `blocked` with the question + options, and the orchestrator asks via
 * its harness ask tool (or emits a `hitl.request` envelope when it has none).
 */
import { getAllProviders, getProviderAskTool } from '@cleocode/caamp';
import type { Task } from '@cleocode/contracts';
import { describe, expect, it } from 'vitest';
import { buildSpawnPrompt } from '../spawn-prompt.js';

const TASK: Task = {
  id: 'T9100',
  title: 'HITL line fixture',
  description: 'Fixture for the HITL line.',
  status: 'pending',
  priority: 'medium',
  type: 'task',
  acceptance: ['AC1'],
  createdAt: '2026-09-27T00:00:00Z',
};

function hitlLine(input: { askProviderId?: string; harnessHint?: 'claude-code' | 'generic' }) {
  const { prompt } = buildSpawnPrompt({
    task: TASK,
    protocol: 'implementation',
    tier: 0,
    projectRoot: '/tmp/spawn-prompt-hitl',
    ...input,
  });
  const line = prompt.split('\n').find((l) => l.startsWith('HITL: '));
  if (!line) throw new Error('HITL line missing');
  return line;
}

describe('spawn prompt HITL line (T12482)', () => {
  it('tells the subagent never to ask and to return blocked with options', () => {
    const line = hitlLine({ askProviderId: 'claude-code' });
    expect(line).toContain('never ask the human');
    expect(line).toContain('`Implementation blocked.`');
    expect(line).toContain('{question, options[{label,description}], recommended}');
    expect(line.length).toBeLessThan(200);
  });

  it.each([
    ['claude-code', 'AskUserQuestion'],
    ['codex', 'request_user_input'],
    ['gemini-cli', 'ask_user'],
    ['opencode', 'question'],
    ['kimi', 'AskUserQuestion'],
    ['cursor', 'AskQuestion'],
  ])('names the orchestrator ask tool for %s', (id, tool) => {
    expect(hitlLine({ askProviderId: id })).toContain(`the orchestrator asks via \`${tool}\``);
  });

  it('names the right tool (or the fallback) for every CAAMP provider', () => {
    for (const { id } of getAllProviders()) {
      const tool = getProviderAskTool(id).toolName;
      const expected = tool ? `asks via \`${tool}\`` : 'emits one `hitl.request` LAFS envelope';
      expect(hitlLine({ askProviderId: id }), id).toContain(expected);
    }
  });

  it('defaults to AskUserQuestion under the claude-code harness hint', () => {
    expect(hitlLine({ harnessHint: 'claude-code' })).toContain('`AskUserQuestion`');
  });

  it('uses the hitl.request fallback when the provider is unknown or unset', () => {
    expect(hitlLine({})).toContain('emits one `hitl.request` LAFS envelope');
    expect(hitlLine({ harnessHint: 'generic' })).toContain('`hitl.request`');
    expect(hitlLine({ askProviderId: 'pi' })).toContain('`hitl.request`');
  });
});
