/**
 * Approval gate manager for CANT workflow execution.
 *
 * Manages the lifecycle of approval tokens: generation, validation,
 * approval, rejection, and expiration. Tokens follow the state machine
 * defined in CANT-DSL-SPEC.md Section 8.2.
 *
 * State transitions are atomic (CAS): only `pending -> approved`,
 * `pending -> rejected`, and `pending -> expired` are permitted.
 *
 * @see docs/specs/CANT-DSL-SPEC.md Section 8 (Approval Token Protocol)
 */

import { createHash, randomUUID } from 'node:crypto';
import type { ApprovalToken, ApprovalTokenStatus, TokenValidation } from './types.js';

/** Default token expiration duration: 24 hours in milliseconds. */
const DEFAULT_EXPIRY_MS = 24 * 60 * 60 * 1000;

/**
 * Manages approval tokens for CANT workflow gates.
 *
 * Tokens are stored in-memory per instance. In production, these are
 * persisted via the session's `approvalTokensJson` column in tasks.db.
 */
export class ApprovalManager {
  /** In-memory token store keyed by token UUID. */
  private tokens: Map<string, ApprovalToken> = new Map();

  /**
   * Generates a new approval token for a workflow gate.
   *
   * @param sessionId - The session that owns this token.
   * @param workflowName - The workflow containing the approval gate.
   * @param gateName - The label of the specific approval gate.
   * @param message - The message to display to the approver.
   * @param workflowHash - SHA-256 hash of the workflow definition.
   * @param requestedBy - The agent/workflow requesting approval.
   * @param expiresInMs - Token lifetime in milliseconds (default: 24h).
   * @returns The generated approval token.
   */
  generateToken(
    sessionId: string,
    workflowName: string,
    gateName: string,
    message: string,
    workflowHash: string,
    requestedBy: string,
    expiresInMs: number = DEFAULT_EXPIRY_MS,
  ): ApprovalToken {
    const now = new Date();
    const token: ApprovalToken = {
      token: randomUUID(),
      sessionId,
      workflowName,
      gateName,
      workflowHash,
      message,
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + expiresInMs).toISOString(),
      status: 'pending',
      requestedBy,
    };

    this.tokens.set(token.token, token);
    return token;
  }

  /**
   * Validates an approval token against the current execution context.
   *
   * Checks: (a) token exists, (b) sessionId matches, (c) status is pending,
   * (d) not expired, (e) workflowHash matches current workflow.
   *
   * @param tokenId - The token UUID to validate.
   * @param currentSessionId - The current session to validate against.
   * @param currentWorkflowHash - The current workflow hash for TOCTOU check.
   * @returns Validation result with reason if invalid.
   */
  validateToken(
    tokenId: string,
    currentSessionId: string,
    currentWorkflowHash: string,
  ): TokenValidation {
    const token = this.tokens.get(tokenId);

    if (!token) {
      return { valid: false, reason: 'not_found' };
    }

    if (token.sessionId !== currentSessionId) {
      return { valid: false, reason: 'wrong_session', token };
    }

    if (token.status !== 'pending') {
      return { valid: false, reason: 'not_pending', token };
    }

    // Check expiration
    if (new Date(token.expiresAt).getTime() < Date.now()) {
      // Atomically transition to expired
      this.transitionStatus(tokenId, 'expired');
      return { valid: false, reason: 'expired', token: { ...token, status: 'expired' } };
    }

    // TOCTOU: verify workflow has not been modified
    if (token.workflowHash !== currentWorkflowHash) {
      return { valid: false, reason: 'hash_mismatch', token };
    }

    return { valid: true, token };
  }

  /**
   * Approves a pending token.
   *
   * Performs an atomic CAS transition: `pending -> approved`. If the token
   * is not in `pending` state, the operation is a no-op and returns false.
   *
   * @param tokenId - The token UUID to approve.
   * @param approvedBy - The identifier of the approving actor.
   * @returns `true` if the transition succeeded, `false` if CAS failed.
   */
  approveToken(tokenId: string, approvedBy: string): boolean {
    const token = this.tokens.get(tokenId);
    if (!token || token.status !== 'pending') {
      return false;
    }

    const now = new Date().toISOString();
    token.status = 'approved';
    token.approvedBy = approvedBy;
    token.approvedAt = now;
    token.usedAt = now;
    return true;
  }

  /**
   * Rejects a pending token.
   *
   * Performs an atomic CAS transition: `pending -> rejected`.
   *
   * @param tokenId - The token UUID to reject.
   * @returns `true` if the transition succeeded, `false` if CAS failed.
   */
  rejectToken(tokenId: string): boolean {
    const token = this.tokens.get(tokenId);
    if (!token || token.status !== 'pending') {
      return false;
    }

    token.status = 'rejected';
    token.usedAt = new Date().toISOString();
    return true;
  }

  /**
   * Expires a pending token.
   *
   * Performs an atomic CAS transition: `pending -> expired`.
   *
   * @param tokenId - The token UUID to expire.
   * @returns `true` if the transition succeeded, `false` if CAS failed.
   */
  expireToken(tokenId: string): boolean {
    return this.transitionStatus(tokenId, 'expired');
  }

  /**
   * Retrieves a token by its UUID.
   *
   * @param tokenId - The token UUID to look up.
   * @returns The token if found, otherwise undefined.
   */
  getToken(tokenId: string): ApprovalToken | undefined {
    return this.tokens.get(tokenId);
  }

  /**
   * Lists all tokens for a given session.
   *
   * @param sessionId - The session to filter by.
   * @returns Array of tokens belonging to the session.
   */
  getTokensForSession(sessionId: string): ApprovalToken[] {
    return Array.from(this.tokens.values()).filter((t) => t.sessionId === sessionId);
  }

  /**
   * Computes a SHA-256 hash of a workflow definition string.
   *
   * Used for TOCTOU protection: the hash at token creation time is compared
   * against the hash at approval time.
   *
   * @param workflowText - The raw workflow definition text.
   * @returns Hex-encoded SHA-256 hash.
   */
  static computeWorkflowHash(workflowText: string): string {
    return createHash('sha256').update(workflowText).digest('hex');
  }

  /**
   * Atomically transitions a token from `pending` to the target status.
   *
   * @param tokenId - The token UUID.
   * @param targetStatus - The desired new status.
   * @returns `true` if the CAS transition succeeded.
   */
  private transitionStatus(tokenId: string, targetStatus: ApprovalTokenStatus): boolean {
    const token = this.tokens.get(tokenId);
    if (!token || token.status !== 'pending') {
      return false;
    }
    token.status = targetStatus;
    token.usedAt = new Date().toISOString();
    return true;
  }
}
