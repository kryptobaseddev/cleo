/**
 * Multi-agent contribution protocol.
 * Ports lib/skills/contribution-protocol.sh.
 *
 * Implements the contribution protocol for multi-agent research coordination:
 * template instantiation, task validation, injection block generation,
 * conflict detection, and consensus computation.
 *
 * @epic T4454
 * @task T4520
 */

import { existsSync, readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { getTodoPath } from '../../paths.js';
import type { Task } from '../../../types/task.js';
import type { ManifestEntry } from '../types.js';

// ============================================================================
// Types
// ============================================================================

/** A contribution decision from an agent. */
export interface ContributionDecision {
  agentId: string;
  taskId: string;
  decision: string;
  confidence: number;
  rationale: string;
}

/** Conflict between two agent decisions. */
export interface ContributionConflict {
  field: string;
  agent1: string;
  agent2: string;
  value1: string;
  value2: string;
  severity: 'low' | 'medium' | 'high';
}

/** Consensus result from weighted voting. */
export interface ConsensusResult {
  decision: string;
  confidence: number;
  votes: Array<{ agentId: string; weight: number; vote: string }>;
  conflicts: ContributionConflict[];
}

// ============================================================================
// Contribution Protocol
// ============================================================================

/**
 * Generate a unique contribution ID.
 * @task T4520
 */
export function generateContributionId(taskId: string): string {
  const hash = randomBytes(4).toString('hex');
  const date = new Date().toISOString().split('T')[0];
  return `contrib-${taskId}-${date}-${hash}`;
}

/**
 * Validate that a task is suitable for contribution protocol.
 * @task T4520
 */
export function validateContributionTask(
  taskId: string,
  cwd?: string,
): { valid: boolean; issues: string[] } {
  const issues: string[] = [];
  const todoPath = getTodoPath(cwd);

  if (!existsSync(todoPath)) {
    return { valid: false, issues: ['Todo file not found'] };
  }

  const data = JSON.parse(readFileSync(todoPath, 'utf-8'));
  const tasks: Task[] = data.tasks ?? [];
  const task = tasks.find(t => t.id === taskId);

  if (!task) {
    return { valid: false, issues: [`Task ${taskId} not found`] };
  }

  // Must be pending or active
  if (task.status !== 'pending' && task.status !== 'active') {
    issues.push(`Task status is ${task.status}, expected pending or active`);
  }

  // Should have a description
  if (!task.description) {
    issues.push('Task missing description');
  }

  return { valid: issues.length === 0, issues };
}

/**
 * Generate the contribution injection block for a subagent prompt.
 * @task T4520
 */
export function getContributionInjection(
  taskId: string,
  protocolPath?: string,
  _cwd?: string,
): string {
  const lines: string[] = [
    '---',
    '## CONTRIBUTION PROTOCOL',
    '',
    `**Task**: ${taskId}`,
    `**Protocol**: contribution`,
    `**Generated**: ${new Date().toISOString()}`,
    '',
    '### Requirements',
    '- Tag all new functions with @task and @contribution markers',
    '- Provide rationale for all decisions',
    '- Report confidence levels (0.0-1.0)',
    '- Document any conflicts with prior agent outputs',
    '',
  ];

  if (protocolPath && existsSync(protocolPath)) {
    lines.push('### Protocol Details');
    lines.push('');
    lines.push(readFileSync(protocolPath, 'utf-8'));
  }

  lines.push('---');
  return lines.join('\n');
}

/**
 * Detect conflicts between two sets of decisions.
 * @task T4520
 */
export function detectConflicts(
  decisions1: ContributionDecision[],
  decisions2: ContributionDecision[],
): ContributionConflict[] {
  const conflicts: ContributionConflict[] = [];

  for (const d1 of decisions1) {
    for (const d2 of decisions2) {
      if (d1.taskId === d2.taskId && d1.decision !== d2.decision) {
        const confDiff = Math.abs(d1.confidence - d2.confidence);
        const severity: ContributionConflict['severity'] =
          confDiff > 0.5 ? 'high' : confDiff > 0.2 ? 'medium' : 'low';

        conflicts.push({
          field: 'decision',
          agent1: d1.agentId,
          agent2: d2.agentId,
          value1: d1.decision,
          value2: d2.decision,
          severity,
        });
      }
    }
  }

  return conflicts;
}

/**
 * Compute weighted consensus from multiple agent decisions.
 * @task T4520
 */
export function computeConsensus(
  decisions: ContributionDecision[],
  weights?: Record<string, number>,
): ConsensusResult {
  if (decisions.length === 0) {
    return { decision: '', confidence: 0, votes: [], conflicts: [] };
  }

  // Build vote map: decision -> weighted score
  const voteMap = new Map<string, number>();
  const votes: ConsensusResult['votes'] = [];

  for (const d of decisions) {
    const weight = weights?.[d.agentId] ?? d.confidence;
    const current = voteMap.get(d.decision) ?? 0;
    voteMap.set(d.decision, current + weight);
    votes.push({ agentId: d.agentId, weight, vote: d.decision });
  }

  // Find highest scoring decision
  let bestDecision = '';
  let bestScore = -1;
  let totalWeight = 0;

  for (const [decision, score] of voteMap) {
    totalWeight += score;
    if (score > bestScore) {
      bestScore = score;
      bestDecision = decision;
    }
  }

  // Detect conflicts among decisions
  const conflicts: ContributionConflict[] = [];
  const uniqueDecisions = [...new Set(decisions.map(d => d.decision))];
  if (uniqueDecisions.length > 1) {
    // Pairwise conflict detection
    for (let i = 0; i < decisions.length; i++) {
      for (let j = i + 1; j < decisions.length; j++) {
        if (decisions[i].decision !== decisions[j].decision) {
          const confDiff = Math.abs(decisions[i].confidence - decisions[j].confidence);
          conflicts.push({
            field: 'decision',
            agent1: decisions[i].agentId,
            agent2: decisions[j].agentId,
            value1: decisions[i].decision,
            value2: decisions[j].decision,
            severity: confDiff > 0.5 ? 'high' : confDiff > 0.2 ? 'medium' : 'low',
          });
        }
      }
    }
  }

  return {
    decision: bestDecision,
    confidence: totalWeight > 0 ? bestScore / totalWeight : 0,
    votes,
    conflicts,
  };
}

/**
 * Create a manifest entry for a contribution.
 * @task T4520
 */
export function createContributionManifestEntry(
  taskId: string,
  contributionId: string,
  decisions: ContributionDecision[],
): ManifestEntry {
  return {
    id: contributionId,
    file: `${contributionId}.md`,
    title: `Contribution for ${taskId}`,
    date: new Date().toISOString().split('T')[0],
    status: 'complete',
    agent_type: 'contribution',
    topics: ['contribution', 'multi-agent'],
    key_findings: decisions.map(d => `${d.agentId}: ${d.decision} (conf: ${d.confidence})`),
    actionable: true,
    needs_followup: [],
    linked_tasks: [taskId],
  };
}
