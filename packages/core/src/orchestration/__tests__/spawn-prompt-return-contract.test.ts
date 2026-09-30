/**
 * T12521 — compressed cavecrew-style return + manifest contract.
 *
 * The Return Format Contract and Manifest Protocol blocks are rendered into
 * every spawn prompt. Before T12521 the pair measured 767 estimated tokens
 * (chars / 4, the repo's `estimateTokens`) for `implementation` — 783 with
 * o200k_base — and piped the manifest receipt through `python3`. This file
 * pins the new ceiling, the per-protocol manifest types, and that the rendered
 * return template, once filled, passes every return-message validator.
 */
import type { Task } from '@cleocode/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { estimateTokens } from '../../metrics/token-estimation.js';
import { validateReturnMessage } from '../../skills/validation.js';
import { checkReturnFormat } from '../../validation/compliance.js';
import { checkReturnMessageFormat } from '../../validation/protocol-common.js';
import {
  ALL_SPAWN_PROTOCOL_PHASES,
  buildSpawnPrompt,
  resetSpawnPromptCache,
  resolveSpawnReturnContract,
  SPAWN_RETURN_CONTRACTS,
  type SpawnProtocolPhase,
} from '../spawn-prompt.js';

const TASK: Task = {
  id: 'T12489',
  title: 'Return contract fixture',
  description: 'Fixture for the compressed return contract.',
  status: 'pending',
  priority: 'medium',
  type: 'task',
  acceptance: ['AC1'],
  createdAt: '2026-09-29T00:00:00Z',
};

/** Estimated tokens of the two blocks before T12521 (implementation, chars / 4). */
const LEGACY_BLOCKS_TOKENS = 767;

/**
 * Ceiling for the two blocks after T12521, HITL line included (chars / 4).
 * Still holds after the review fixes restored the rich-entry capture/readback,
 * the `E_VALIDATION_FAILED` and the first-task-id rules (F4).
 */
const BLOCKS_TOKEN_CEILING = 380;

function contractBlocks(protocol: SpawnProtocolPhase): string {
  const { prompt } = buildSpawnPrompt({
    task: TASK,
    protocol,
    tier: 0,
    projectRoot: '/tmp/spawn-prompt-return-contract',
    harnessHint: 'claude-code',
  });
  const body = prompt.split('## Return Format Contract')[1]?.split('## Session Linkage')[0];
  if (!body) throw new Error(`return/manifest blocks missing for ${protocol}`);
  return `## Return Format Contract${body}`;
}

describe('return + manifest contract token budget (T12521)', () => {
  it.each(ALL_SPAWN_PROTOCOL_PHASES)('%s stays under the ceiling', (protocol) => {
    const tokens = estimateTokens(contractBlocks(protocol));
    expect(tokens).toBeLessThanOrEqual(BLOCKS_TOKEN_CEILING);
    expect(tokens).toBeLessThan(LEGACY_BLOCKS_TOKENS / 2);
  });

  it('keeps the HITL rule and never pipes through python3', () => {
    for (const protocol of ALL_SPAWN_PROTOCOL_PHASES) {
      const blocks = contractBlocks(protocol);
      expect(blocks, protocol).toContain('HITL: never ask the human.');
      expect(blocks, protocol).toContain('the orchestrator asks via `AskUserQuestion`');
      expect(blocks, protocol).not.toContain('python3');
    }
  });
});

describe('protocol → manifest type (T12521)', () => {
  it('maps every protocol to its own manifest type', () => {
    const types = ALL_SPAWN_PROTOCOL_PHASES.map((p) => SPAWN_RETURN_CONTRACTS[p].manifestType);
    expect(new Set(types).size).toBe(ALL_SPAWN_PROTOCOL_PHASES.length);
    expect(SPAWN_RETURN_CONTRACTS.consensus.manifestType).toBe('consensus');
    expect(SPAWN_RETURN_CONTRACTS.specification.manifestType).toBe('specification');
    expect(SPAWN_RETURN_CONTRACTS.architecture_decision.manifestType).toBe('architecture_decision');
  });

  it.each(ALL_SPAWN_PROTOCOL_PHASES)('%s renders --type with its own manifest type', (protocol) => {
    const { manifestType } = SPAWN_RETURN_CONTRACTS[protocol];
    expect(contractBlocks(protocol)).toContain(`--task T12489 --type ${manifestType} `);
  });

  it('falls back to the implementation contract for an unknown protocol', () => {
    expect(resolveSpawnReturnContract('unknown-phase')).toBe(SPAWN_RETURN_CONTRACTS.implementation);
  });
});

describe('rendered return template passes every validator (T12521)', () => {
  it.each(ALL_SPAWN_PROTOCOL_PHASES)('%s — compressed and legacy forms', (protocol) => {
    const { type } = SPAWN_RETURN_CONTRACTS[protocol];
    const template = contractBlocks(protocol).split('```')[1] ?? '';
    const filled = template
      .trim()
      .replace('<complete|partial|blocked>', 'partial')
      .replace('<entryId>', `T12489-${protocol}-20260929`)
      .replace('<sha7,sha7|none>', 'abc1234')
      .replace('<gate>=<pass|fail|skip> ...', 'implemented=pass testsPassed=fail')
      .replace('<≤12 words|none>', 'flaky fixture needs owner decision');
    const legacy = `${type} complete. Manifest appended to pipeline_manifest.`;
    for (const message of [filled, legacy]) {
      expect(checkReturnMessageFormat(message, protocol), message).toBe(true);
      expect(checkReturnFormat(message), message).toBe(true);
      expect(validateReturnMessage(message).valid, message).toBe(true);
    }
  });
});

describe('tier-2 prompt carries no legacy return instruction (T12521 F1)', () => {
  beforeEach(() => resetSpawnPromptCache());
  afterEach(() => resetSpawnPromptCache());

  it.each(
    ALL_SPAWN_PROTOCOL_PHASES,
  )('%s embeds the compressed Subagent Protocol Block', (protocol) => {
    const { prompt } = buildSpawnPrompt({
      task: TASK,
      protocol,
      tier: 2,
      projectRoot: '/tmp/spawn-prompt-return-contract',
      harnessHint: 'claude-code',
    });
    const block = prompt.split('### Subagent Protocol Block (return-format spec)')[1];
    expect(block, 'subagent protocol block not embedded').toBeDefined();
    expect(block).toContain('manifest:<entryId>');
    expect(block).toContain('HITL: never ask the human.');
    expect(prompt).not.toContain('Manifest appended to pipeline_manifest');
    expect(prompt).not.toContain('MUST return ONLY');
  });
});

describe('F2/F3/F4 wording (T12521)', () => {
  it('renders the blocker rule, HITL entry id and restored manifest rules', () => {
    const blocks = contractBlocks('research');
    expect(blocks).toContain('blocker: none when complete; required when partial/blocked');
    expect(blocks).toContain('Return `Research blocked. manifest:<entryId>` + blocker: with');
    expect(blocks).toContain('First --task/linked_tasks entry = manifest task id');
    expect(blocks).toContain('actionable (missing → `E_VALIDATION_FAILED`)');
    expect(blocks).toContain(
      "Rich `--entry '<json>'` needs id, file, title, date, status, agent_type, topics, actionable",
    );
    expect(blocks).toContain('Capture via `--field /data/entryId`; same guard + readback.');
  });
});
