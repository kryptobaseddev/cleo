/**
 * Compliance checking - ported from lib/validation/compliance-check.sh
 *
 * Validates subagent outputs against protocol requirements, checks manifest
 * entries, research links, return format, and generates compliance metrics.
 *
 * @task T4524
 * @epic T4454
 */

// ============================================================================
// Types
// ============================================================================

export type ManifestIntegrity = 'valid' | 'partial' | 'invalid' | 'missing';
export type Severity = 'low' | 'medium' | 'high' | 'critical';

export interface ComplianceMetrics {
  timestamp: string;
  category: string;
  source: string;
  sourceId: string;
  period: string;
  compliance: {
    compliancePassRate: number;
    ruleAdherenceScore: number;
    violationCount: number;
    violationSeverity: Severity;
    manifestIntegrity: ManifestIntegrity;
  };
  tags: string[];
  context: {
    taskId: string;
    researchLinked: boolean;
    returnFormatValid: boolean;
  };
}

export interface ManifestEntry {
  id?: string;
  research_id?: string;
  title?: string;
  status?: string;
  key_findings?: string[];
  findings_summary?: string;
  linked_tasks?: string[];
  task_ids?: string[];
  agent_type?: string;
  [key: string]: unknown;
}

export interface TokenMetrics {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  maxTokens: number;
  percentage: number;
  status: string;
}

export interface TokenEfficiency {
  tokensUsed: number;
  maxTokens: number;
  tasksCompleted: number;
  contextUtilization: number;
  tokenUtilizationRate: number;
  contextEfficiency: number;
  inputTokens: number;
  outputTokens: number;
}

export interface OrchestrationOverhead {
  orchestratorTokens: number;
  totalSubagentTokens: number;
  numSubagents: number;
  overheadRatio: number;
  tokensPerSubagent: number;
}

// ============================================================================
// Manifest Entry Checking
// ============================================================================

/**
 * Verify a manifest entry for a task has valid required fields.
 * @task T4524
 */
export function checkManifestEntry(entry: ManifestEntry | null): ManifestIntegrity {
  if (!entry) return 'missing';

  const hasId = !!(entry.id || entry.research_id);
  const hasTitle = !!entry.title;
  const hasStatus = !!entry.status;
  const hasKeyFindings = !!(entry.key_findings || entry.findings_summary);

  const missingCount = [hasId, hasTitle, hasStatus, hasKeyFindings].filter(v => !v).length;

  if (missingCount === 0) {
    const findingsValid = Array.isArray(entry.key_findings) || typeof entry.findings_summary === 'string';
    const linkedValid = Array.isArray(entry.linked_tasks) || Array.isArray(entry.task_ids);
    return (findingsValid && linkedValid) ? 'valid' : 'partial';
  }

  return missingCount < 3 ? 'partial' : 'invalid';
}

// ============================================================================
// Return Format Checking
// ============================================================================

const RETURN_PATTERN = /Research complete\. See MANIFEST\.jsonl/;

/**
 * Check if a response matches the expected return format.
 * @task T4524
 */
export function checkReturnFormat(response: string): boolean {
  return RETURN_PATTERN.test(response);
}

// ============================================================================
// Compliance Scoring
// ============================================================================

/**
 * Calculate comprehensive compliance score for a subagent.
 * @task T4524
 */
export function scoreSubagentCompliance(
  taskId: string,
  agentId: string,
  manifestEntry: ManifestEntry | null,
  researchLinked: boolean,
  response: string,
): ComplianceMetrics {
  const manifestIntegrity = checkManifestEntry(manifestEntry);
  const returnFormatValid = checkReturnFormat(response);

  let rulesPassed = 0;
  const totalRules = 3;
  let violationCount = 0;
  let violationSeverity: Severity = 'low';

  // Rule 1: Manifest entry
  switch (manifestIntegrity) {
    case 'valid':
      rulesPassed++;
      break;
    case 'partial':
      rulesPassed++;
      violationCount++;
      break;
    case 'invalid':
      violationCount++;
      if (violationSeverity === 'low') violationSeverity = 'medium';
      break;
    case 'missing':
      violationCount++;
      violationSeverity = 'high';
      break;
  }

  // Rule 2: Research link
  if (researchLinked) {
    rulesPassed++;
  } else {
    violationCount++;
    if (violationSeverity === 'low') violationSeverity = 'medium';
  }

  // Rule 3: Return format
  if (returnFormatValid) {
    rulesPassed++;
  } else {
    violationCount++;
  }

  const ruleAdherenceScore = rulesPassed / totalRules;
  const compliancePassRate = violationCount === 0 ? 1.0 : 0.0;

  return {
    timestamp: new Date().toISOString(),
    category: 'compliance',
    source: 'agent',
    sourceId: agentId,
    period: 'instant',
    compliance: {
      compliancePassRate,
      ruleAdherenceScore: Math.round(ruleAdherenceScore * 100) / 100,
      violationCount,
      violationSeverity,
      manifestIntegrity,
    },
    tags: ['subagent-compliance', 'orchestrator'],
    context: {
      taskId,
      researchLinked,
      returnFormatValid,
    },
  };
}

// ============================================================================
// Token Efficiency
// ============================================================================

/**
 * Calculate token efficiency metrics.
 * @task T4524
 */
export function calculateTokenEfficiency(
  tokensUsed: number,
  maxTokens: number = 200000,
  tasksCompleted: number = 0,
  inputTokens: number = 0,
  outputTokens: number = 0,
): TokenEfficiency {
  const safeTokensUsed = tokensUsed || 1;
  const safeMaxTokens = maxTokens || 200000;
  const totalIo = (inputTokens + outputTokens) || 1;

  const contextUtilization = safeTokensUsed / safeMaxTokens;
  const tokenUtilizationRate = outputTokens / totalIo;
  const contextEfficiency = contextUtilization > 0.01
    ? tasksCompleted / (contextUtilization * 10)
    : 0;

  return {
    tokensUsed: safeTokensUsed,
    maxTokens: safeMaxTokens,
    tasksCompleted,
    contextUtilization: Math.round(contextUtilization * 10000) / 10000,
    tokenUtilizationRate: Math.round(tokenUtilizationRate * 10000) / 10000,
    contextEfficiency: Math.round(contextEfficiency * 10000) / 10000,
    inputTokens,
    outputTokens,
  };
}

/**
 * Calculate orchestration overhead metrics.
 * @task T4524
 */
export function calculateOrchestrationOverhead(
  orchestratorTokens: number,
  totalSubagentTokens: number,
  numSubagents: number = 1,
): OrchestrationOverhead {
  const safeSubagents = numSubagents || 1;
  const totalTokens = (orchestratorTokens + totalSubagentTokens) || 1;

  return {
    orchestratorTokens,
    totalSubagentTokens,
    numSubagents: safeSubagents,
    overheadRatio: Math.round((orchestratorTokens / totalTokens) * 10000) / 10000,
    tokensPerSubagent: Math.round(totalSubagentTokens / safeSubagents),
  };
}
