/**
 * Verification gates management - ported from lib/validation/verification.sh
 *
 * Implements gate dependency chains, round management, failure logging,
 * epic lifecycle transitions, and circular validation prevention.
 *
 * Gate Dependency Chain:
 *   implemented -> testsPassed -> qaPassed -> cleanupDone -> securityPassed -> documented
 *
 * @task T4526
 * @epic T4454
 */

import { ExitCode } from '../../types/exit-codes.js';

// ============================================================================
// Constants
// ============================================================================

export const VERIFICATION_GATE_ORDER = [
  'implemented',
  'testsPassed',
  'qaPassed',
  'cleanupDone',
  'securityPassed',
  'documented',
] as const;

export type GateName = typeof VERIFICATION_GATE_ORDER[number];

export const VERIFICATION_VALID_AGENTS = [
  'planner', 'coder', 'testing', 'qa', 'cleanup', 'security', 'docs',
] as const;

export type AgentName = typeof VERIFICATION_VALID_AGENTS[number];

const DEFAULT_REQUIRED_GATES: GateName[] = [
  'implemented', 'testsPassed', 'qaPassed', 'securityPassed', 'documented',
];

// ============================================================================
// Types
// ============================================================================

export interface FailureLogEntry {
  gate: GateName;
  agent: string;
  reason: string;
  timestamp: string;
  round: number;
}

export interface VerificationGates {
  implemented: boolean | null;
  testsPassed: boolean | null;
  qaPassed: boolean | null;
  cleanupDone: boolean | null;
  securityPassed: boolean | null;
  documented: boolean | null;
}

export interface Verification {
  passed: boolean;
  round: number;
  gates: VerificationGates;
  lastAgent: string | null;
  lastUpdated: string;
  failureLog: FailureLogEntry[];
}

export type VerificationStatus = 'pending' | 'in-progress' | 'passed' | 'failed';

// ============================================================================
// Validation Functions
// ============================================================================

/** @task T4526 */
export function isValidGateName(name: string): name is GateName {
  return (VERIFICATION_GATE_ORDER as readonly string[]).includes(name);
}

/** @task T4526 */
export function isValidAgentName(name: string): name is AgentName {
  if (!name || name === 'null') return true; // null/empty allowed
  return (VERIFICATION_VALID_AGENTS as readonly string[]).includes(name);
}

// ============================================================================
// Gate Order Functions
// ============================================================================

/** @task T4526 */
export function getGateOrder(): GateName[] {
  return [...VERIFICATION_GATE_ORDER];
}

/** @task T4526 */
export function getGateIndex(gateName: GateName): number {
  const idx = VERIFICATION_GATE_ORDER.indexOf(gateName);
  if (idx === -1) return -1;
  return idx;
}

/** @task T4526 */
export function getDownstreamGates(fromGate: GateName): GateName[] {
  const idx = getGateIndex(fromGate);
  if (idx === -1) return [];
  return VERIFICATION_GATE_ORDER.slice(idx + 1) as GateName[];
}

// ============================================================================
// Verification Object Functions
// ============================================================================

/**
 * Initialize a new verification object with default values.
 * @task T4526
 */
export function initVerification(): Verification {
  return {
    passed: false,
    round: 0,
    gates: {
      implemented: null,
      testsPassed: null,
      qaPassed: null,
      cleanupDone: null,
      securityPassed: null,
      documented: null,
    },
    lastAgent: null,
    lastUpdated: new Date().toISOString(),
    failureLog: [],
  };
}

/**
 * Compute whether verification has passed based on required gates.
 * @task T4526
 */
export function computePassed(
  verification: Verification,
  requiredGates: GateName[] = DEFAULT_REQUIRED_GATES,
): boolean {
  return requiredGates.every(gate => verification.gates[gate] === true);
}

/**
 * Update the passed field on a verification object.
 * @task T4526
 */
export function setVerificationPassed(
  verification: Verification,
  passed: boolean,
): Verification {
  return {
    ...verification,
    passed,
    lastUpdated: new Date().toISOString(),
  };
}

/**
 * Update a single gate value.
 * @task T4526
 */
export function updateGate(
  verification: Verification,
  gateName: GateName,
  value: boolean | null,
  agent?: string,
): Verification {
  if (!isValidGateName(gateName)) {
    throw new Error(`Invalid gate name: ${gateName}`);
  }

  if (agent && agent !== 'null' && !isValidAgentName(agent)) {
    throw new Error(`Invalid agent name: ${agent}`);
  }

  return {
    ...verification,
    gates: {
      ...verification.gates,
      [gateName]: value,
    },
    lastAgent: agent ?? verification.lastAgent,
    lastUpdated: new Date().toISOString(),
  };
}

/**
 * Reset all downstream gates to null after a gate failure.
 * @task T4526
 */
export function resetDownstreamGates(
  verification: Verification,
  fromGate: GateName,
): Verification {
  if (!isValidGateName(fromGate)) {
    throw new Error(`Invalid gate name: ${fromGate}`);
  }

  const downstream = getDownstreamGates(fromGate);
  const newGates = { ...verification.gates };

  for (const gate of downstream) {
    newGates[gate] = null;
  }

  return {
    ...verification,
    gates: newGates,
    lastUpdated: new Date().toISOString(),
  };
}

// ============================================================================
// Round Management
// ============================================================================

/**
 * Increment the round counter.
 * Returns null if max rounds exceeded.
 * @task T4526
 */
export function incrementRound(
  verification: Verification,
  maxRounds: number = 5,
): Verification | null {
  const newRound = verification.round + 1;
  if (newRound > maxRounds) return null;

  return {
    ...verification,
    round: newRound,
    lastUpdated: new Date().toISOString(),
  };
}

// ============================================================================
// Failure Logging
// ============================================================================

/**
 * Log a failure to the failureLog array.
 * @task T4526
 */
export function logFailure(
  verification: Verification,
  gateName: GateName,
  agent: string,
  reason: string,
): Verification {
  const entry: FailureLogEntry = {
    gate: gateName,
    agent,
    reason,
    timestamp: new Date().toISOString(),
    round: verification.round,
  };

  return {
    ...verification,
    failureLog: [...verification.failureLog, entry],
    lastUpdated: new Date().toISOString(),
  };
}

// ============================================================================
// Status Check Functions
// ============================================================================

/**
 * Check if all required gates have passed.
 * @task T4526
 */
export function checkAllGatesPassed(
  verification: Verification,
  requiredGates: GateName[] = DEFAULT_REQUIRED_GATES,
): boolean {
  return computePassed(verification, requiredGates);
}

/**
 * Check if verification is complete (passed = true).
 * @task T4526
 */
export function isVerificationComplete(verification: Verification | null): boolean {
  if (!verification) return false;
  return verification.passed === true;
}

/**
 * Get verification status for display.
 * @task T4526
 */
export function getVerificationStatus(verification: Verification | null): VerificationStatus {
  if (!verification) return 'pending';

  if (verification.passed) return 'passed';

  if (verification.failureLog.length > 0) return 'failed';

  const gatesSet = Object.values(verification.gates).filter(v => v !== null).length;
  if (gatesSet > 0) return 'in-progress';

  return 'pending';
}

/**
 * Check if a task type should require verification.
 * @task T4526
 */
export function shouldRequireVerification(
  taskType: string = 'task',
  verificationEnabled: boolean = true,
): boolean {
  if (taskType === 'epic') return false;
  return verificationEnabled;
}

// ============================================================================
// Missing Gates
// ============================================================================

/**
 * Get gate names that are not yet true.
 * @task T4526
 */
export function getMissingGates(
  verification: Verification,
  requiredGates: GateName[] = DEFAULT_REQUIRED_GATES,
): GateName[] {
  return requiredGates.filter(gate => verification.gates[gate] !== true);
}

/**
 * Get gate summary for display.
 * @task T4526
 */
export function getGateSummary(verification: Verification): {
  passed: boolean;
  round: number;
  gates: VerificationGates;
  lastAgent: string | null;
  lastUpdated: string;
  failureCount: number;
} {
  return {
    passed: verification.passed,
    round: verification.round,
    gates: verification.gates,
    lastAgent: verification.lastAgent,
    lastUpdated: verification.lastUpdated,
    failureCount: verification.failureLog.length,
  };
}

// ============================================================================
// Circular Validation (Self-Approval Prevention)
// ============================================================================

export interface CircularValidationResult {
  valid: boolean;
  error?: string;
  code?: number;
}

/**
 * Check for circular validation (self-approval prevention).
 * Prevents: creator validating own work, validator re-testing, tester self-creating.
 * @task T4526
 */
export function checkCircularValidation(
  currentAgent: string,
  createdBy?: string | null,
  validatedBy?: string | null,
  testedBy?: string | null,
): CircularValidationResult {
  // Special agents bypass
  if (['user', 'legacy', 'system'].includes(currentAgent)) {
    return { valid: true };
  }

  if (currentAgent && currentAgent === createdBy) {
    return {
      valid: false,
      error: `Cannot validate your own work (agent: ${currentAgent})`,
      code: ExitCode.CIRCULAR_VALIDATION,
    };
  }

  if (currentAgent && currentAgent === validatedBy) {
    return {
      valid: false,
      error: `Validator cannot also be tester (agent: ${currentAgent})`,
      code: ExitCode.CIRCULAR_VALIDATION,
    };
  }

  if (currentAgent && currentAgent === testedBy) {
    return {
      valid: false,
      error: `Tester cannot create tasks for own testing (agent: ${currentAgent})`,
      code: ExitCode.CIRCULAR_VALIDATION,
    };
  }

  return { valid: true };
}

// ============================================================================
// Epic Lifecycle Transitions
// ============================================================================

export interface TaskForVerification {
  id: string;
  status: string;
  parentId?: string | null;
  type?: string;
  verification?: Verification | null;
  epicLifecycle?: string;
}

/**
 * Check if all children of an epic have verification.passed = true.
 * @task T4526
 */
export function allEpicChildrenVerified(
  epicId: string,
  tasks: TaskForVerification[],
): boolean {
  const children = tasks.filter(t => t.parentId === epicId);
  if (children.length === 0) return false;

  const incomplete = children.filter(t => t.status !== 'done');
  if (incomplete.length > 0) return false;

  const unverified = children.filter(t =>
    t.status === 'done' && (!t.verification || !t.verification.passed),
  );
  return unverified.length === 0;
}

/**
 * Check if all siblings of a task are verified.
 * @task T4526
 */
export function allSiblingsVerified(
  parentId: string,
  tasks: TaskForVerification[],
): boolean {
  const siblings = tasks.filter(t => t.parentId === parentId);

  const unverifiedDone = siblings.filter(t =>
    t.status === 'done' && (!t.verification || !t.verification.passed),
  );

  const incomplete = siblings.filter(t =>
    t.status === 'pending' || t.status === 'active' || t.status === 'blocked',
  );

  return unverifiedDone.length === 0 && incomplete.length === 0;
}
