/**
 * Foreground knowledge assessment and transactional, sourced repair.
 *
 * Code placed in `packages/core/` per Package-Boundary Check — verified
 * against AGENTS.md. No repair reasoning is delegated to a background model.
 */

import { createHash } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type {
  KnowledgeDoctorOptions,
  KnowledgeDoctorResult,
  KnowledgeEvidenceRef,
  KnowledgeRepairProposal,
  KnowledgeRepairReceipt,
} from '@cleocode/contracts';
import { z } from 'zod';
import { scanBrainGraphOrphans } from '../memory/brain-doctor.js';
import { pruneObservationStubs, restoreObservationStubs } from '../memory/brain-stub-prune.js';
import { linkDecisionToCodeEvidence } from '../memory/decision-cross-link.js';
import { assessKnowledgeCoverage } from '../nexus/knowledge.js';
import { getTaskKnowledgeEvidence } from '../nexus/task-evidence.js';
import { getBrainDb, getBrainNativeDb } from '../store/memory-sqlite.js';
import { getNexusDb } from '../store/nexus-sqlite.js';

const evidenceSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  source: z.enum(['task', 'verification', 'commit', 'attachment', 'memory', 'index', 'file']),
  revision: z.string().nullable(),
  precision: z.enum(['project', 'record', 'file', 'symbol']),
  contentHash: z.string().optional(),
  excerpt: z.string().optional(),
});
const actionSchema = z.object({
  operation: z.enum([
    'knowledge.quarantine-stubs',
    'knowledge.supersede-decision',
    'knowledge.rollback',
  ]),
  arguments: z.record(
    z.string(),
    z.union([z.string(), z.number(), z.boolean(), z.array(z.string()), z.null()]),
  ),
  prerequisites: z.array(z.string()),
});
const proposalSchema = z.object({
  id: z.string().min(1).max(200),
  findingId: z.string(),
  projectId: z.string(),
  expectedRevision: z.string().nullable(),
  expectedStateHash: z.string(),
  action: actionSchema,
  evidence: z.tuple([evidenceSchema]).rest(evidenceSchema),
});
const decisionSchema = z.object({
  id: z.string(),
  decision: z.string(),
  rationale: z.string(),
  invalid_at: z.string().nullable(),
  superseded_by: z.string().nullable(),
  supersedes: z.string().nullable(),
  confirmation_state: z.string(),
});
const observationSchema = z.object({
  id: z.string(),
  title: z.string(),
  narrative: z.string().nullable(),
  invalid_at: z.string().nullable(),
  verified: z.number().nullable(),
});
const receiptSchema = z.object({
  action: actionSchema.optional(),
  id: z.string(),
  proposalId: z.string(),
  findingId: z.string(),
  projectId: z.string(),
  state: z.enum(['pending', 'running', 'repaired', 'unresolved', 'failed']),
  attempt: z.number(),
  startedAt: z.string(),
  completedAt: z.string().nullable(),
  recovery: z.object({ snapshotId: z.string(), restoreAction: actionSchema }),
  verificationEvidence: z.array(evidenceSchema),
  reasons: z.array(z.string()),
});
const storedRepairSchema = z.object({
  receipt: receiptSchema,
  postHash: z.string(),
  proposalHash: z.string(),
  rolledBack: z.boolean(),
  decisions: z.array(decisionSchema),
  quarantine: z
    .object({
      applied: z.boolean(),
      before: z.number(),
      after: z.number(),
      matched: z.number(),
      byRule: z.record(z.string(), z.number()),
      sample: z.array(
        z.object({ id: z.string(), title: z.string(), narrative: z.string(), rule: z.string() }),
      ),
      quarantinedAt: z.string().optional(),
      quarantinedIds: z.array(z.string()).optional(),
    })
    .nullable(),
});

/**
 * Validation error preserving a stable repair failure code for CLI envelopes.
 * @remarks Stale proposals and failed source validation never apply a mutation.
 * @example
 * ```ts
 * if (error instanceof KnowledgeRepairError) return error.code;
 * ```
 */
export class KnowledgeRepairError extends Error {
  /** Stable machine-readable repair failure code. */
  readonly code: string;
  /**
   * Construct an actionable validation or concurrency error.
   * @param code - Stable repair validation failure code.
   * @param message - Observable reason the repair was rejected.
   */
  constructor(code: string, message: string) {
    super(message);
    this.name = 'KnowledgeRepairError';
    this.code = code;
  }
}

/**
 * Parse caller-supplied repair JSON against the supported operation contract.
 * @param text - JSON proposal supplied by the foreground calling agent.
 * @returns Validated proposal with an explicit supported operation.
 * @remarks Parsing does not apply repairs; source and state validation occur transactionally.
 * @example
 * ```ts
 * const proposal = parseKnowledgeRepairProposal(await readFile(path, 'utf8'));
 * ```
 */
export function parseKnowledgeRepairProposal(text: string): KnowledgeRepairProposal {
  return proposalSchema.parse(JSON.parse(text));
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function readState(db: DatabaseSync) {
  return {
    decisions: z
      .array(decisionSchema)
      .parse(
        db
          .prepare(
            'SELECT id, decision, rationale, invalid_at, superseded_by, supersedes, confirmation_state FROM main.brain_decisions ORDER BY id',
          )
          .all(),
      ),
    observations: z
      .array(observationSchema)
      .parse(
        db
          .prepare(
            'SELECT id, title, narrative, invalid_at, verified FROM main.brain_observations ORDER BY id',
          )
          .all(),
      ),
  };
}

function stateHash(db: DatabaseSync): string {
  return hash(JSON.stringify(readState(db)));
}

function readReceipt(db: DatabaseSync, id: string) {
  const row = db
    .prepare('SELECT value FROM main._nexus_meta WHERE key = ?')
    .get(`knowledge_repair:${id}`);
  if (!row) return null;
  if (typeof row.value !== 'string') throw new Error('Invalid stored repair receipt');
  return storedRepairSchema.parse(JSON.parse(row.value));
}

function writeReceipt(db: DatabaseSync, repair: z.infer<typeof storedRepairSchema>): void {
  db.prepare(
    'INSERT INTO main._nexus_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  ).run(`knowledge_repair:${repair.receipt.id}`, JSON.stringify(repair));
}

function validateAuthoritySources(
  db: DatabaseSync,
  proposal: KnowledgeRepairProposal,
  previous: z.infer<typeof decisionSchema>,
  successor: z.infer<typeof decisionSchema>,
  projectRoot: string,
): void {
  const state = readState(db);
  let explicitReplacement = false;
  for (const source of proposal.evidence) {
    if (source.projectId !== proposal.projectId || !['memory', 'file'].includes(source.source)) {
      throw new KnowledgeRepairError(
        'E_REPAIR_SOURCE',
        'Authority changes require a verified memory or file source from this project.',
      );
    }
    const decision = state.decisions.find((row) => row.id === source.id);
    const observation = state.observations.find((row) => row.id === source.id);
    let text = decision?.decision ?? observation?.narrative;
    if (source.source === 'file') {
      const sourcePath = realpathSync(resolve(projectRoot, source.id));
      const sourceRelative = relative(realpathSync(projectRoot), sourcePath);
      if (
        sourceRelative === '..' ||
        sourceRelative.startsWith(`..${sep}`) ||
        isAbsolute(sourceRelative) ||
        source.revision !== proposal.expectedRevision
      ) {
        throw new KnowledgeRepairError(
          'E_REPAIR_SOURCE',
          'File source is outside the project or its revision does not match the assessment.',
        );
      }
      text = readFileSync(sourcePath, 'utf8');
    }
    const invalidAt = decision?.invalid_at ?? observation?.invalid_at;
    if (
      !text ||
      invalidAt ||
      decision?.superseded_by ||
      (decision && decision.confirmation_state !== 'accepted') ||
      !source.excerpt ||
      !text.includes(source.excerpt) ||
      hash(text) !== source.contentHash
    ) {
      throw new KnowledgeRepairError(
        'E_REPAIR_SOURCE',
        `Source ${source.id} is missing, stale, historical, or does not match its cited content hash and excerpt.`,
      );
    }
    if (
      source.excerpt.includes(`Replace "${previous.decision}" with "${successor.decision}"`) ||
      source.excerpt.includes(`Supersede ${previous.id} with "${successor.decision}"`)
    )
      explicitReplacement = true;
  }
  const args = proposal.action.arguments;
  const mappedSource = proposal.evidence.find((source) => source.id === args.sourceId);
  const callerReviewed =
    args.authorityResolution === 'caller-reviewed' &&
    args.scope === proposal.projectId &&
    args.previousContentHash === hash(previous.decision) &&
    args.successorContentHash === hash(successor.decision) &&
    typeof args.rationale === 'string' &&
    args.rationale.trim().length > 0 &&
    typeof args.sourcePolicyStatement === 'string' &&
    args.sourcePolicyStatement.trim().length > 0 &&
    mappedSource?.excerpt?.includes(args.sourcePolicyStatement);
  if (!explicitReplacement && !callerReviewed) {
    throw new KnowledgeRepairError(
      'E_REPAIR_SOURCE',
      'Provide an explicit replacement directive or a caller-reviewed source mapping with scope, decision hashes, exact policy statement, and rationale. CLEO validates provenance; semantic relevance remains the responsibility of the calling agent.',
    );
  }
}

function applyProposal(
  db: DatabaseSync,
  proposal: KnowledgeRepairProposal,
  result: KnowledgeDoctorResult,
  projectRoot: string,
): KnowledgeRepairReceipt {
  let attempt = 1;
  const startedAt = new Date().toISOString();
  db.exec('BEGIN IMMEDIATE');
  try {
    const prior = readReceipt(db, proposal.id);
    if (prior) {
      if (prior.proposalHash !== hash(JSON.stringify(proposal)))
        throw new KnowledgeRepairError(
          'E_REPAIR_ID_REUSED',
          'A different proposal already uses this idempotency key.',
        );
      if (prior.rolledBack)
        throw new KnowledgeRepairError(
          'E_REPAIR_ROLLED_BACK',
          'This proposal was rolled back; reassess before proposing a new repair.',
        );
      if (prior.receipt.state !== 'failed' || prior.receipt.attempt >= 3) {
        db.exec('COMMIT');
        return prior.receipt;
      }
      attempt = prior.receipt.attempt + 1;
    }
    if (
      proposal.projectId !== result.health.coverage.projectId ||
      proposal.expectedRevision !== result.health.coverage.assessedRevision ||
      proposal.expectedStateHash !== stateHash(db)
    ) {
      throw new KnowledgeRepairError(
        'E_REPAIR_STALE',
        'Repair preconditions changed; reassess and submit a fresh proposal.',
      );
    }
    const previous = readState(db);
    const snapshots: z.infer<typeof decisionSchema>[] = [];
    let quarantine: z.infer<typeof storedRepairSchema>['quarantine'] = null;
    if (proposal.action.operation === 'knowledge.quarantine-stubs') {
      const applied = pruneObservationStubs(db, true);
      quarantine = {
        ...applied,
        sample: [...applied.sample],
        quarantinedIds: applied.quarantinedIds ? [...applied.quarantinedIds] : undefined,
      };
      if (applied.matched !== applied.quarantinedIds?.length && applied.matched !== 0) {
        throw new KnowledgeRepairError(
          'E_REPAIR_VERIFY',
          'Quarantine count did not match the observed candidates.',
        );
      }
    } else if (proposal.action.operation === 'knowledge.supersede-decision') {
      const oldId = proposal.action.arguments.previousId;
      const newId = proposal.action.arguments.successorId;
      if (typeof oldId !== 'string' || typeof newId !== 'string' || oldId === newId) {
        throw new KnowledgeRepairError(
          'E_REPAIR_INPUT',
          'Distinct previousId and successorId are required.',
        );
      }
      const oldDecision = previous.decisions.find((row) => row.id === oldId);
      const successor = previous.decisions.find((row) => row.id === newId);
      if (
        !oldDecision ||
        !successor ||
        oldDecision.invalid_at ||
        oldDecision.superseded_by ||
        successor.invalid_at ||
        successor.superseded_by ||
        successor.confirmation_state !== 'accepted' ||
        (successor.supersedes && successor.supersedes !== oldId)
      ) {
        throw new KnowledgeRepairError(
          'E_REPAIR_AUTHORITY',
          'Both decisions must be current and the successor must not replace a different decision.',
        );
      }
      validateAuthoritySources(db, proposal, oldDecision, successor, projectRoot);
      snapshots.push(oldDecision, successor);
      db.prepare(
        "UPDATE main.brain_decisions SET superseded_by = ?, invalid_at = ?, confirmation_state = 'superseded' WHERE id = ?",
      ).run(newId, startedAt, oldId);
      db.prepare('UPDATE main.brain_decisions SET supersedes = ? WHERE id = ?').run(oldId, newId);
      const verified = readState(db).decisions.find((row) => row.id === oldId);
      if (verified?.superseded_by !== newId)
        throw new KnowledgeRepairError(
          'E_REPAIR_VERIFY',
          'The sourced successor could not be verified.',
        );
    } else {
      throw new KnowledgeRepairError('E_REPAIR_INPUT', 'Use --rollback <receipt> for recovery.');
    }
    const receipt: KnowledgeRepairReceipt = {
      action: proposal.action,
      id: proposal.id,
      proposalId: proposal.id,
      findingId: proposal.findingId,
      projectId: proposal.projectId,
      state: 'repaired',
      attempt,
      startedAt,
      completedAt: new Date().toISOString(),
      recovery: {
        snapshotId: `knowledge_repair:${proposal.id}`,
        restoreAction: {
          operation: 'knowledge.rollback',
          arguments: { receiptId: proposal.id },
          prerequisites: [
            'All substantive project knowledge must still match the recorded post-state.',
          ],
        },
      },
      verificationEvidence: proposal.evidence,
      reasons:
        proposal.action.arguments.authorityResolution === 'caller-reviewed'
          ? [
              'Source integrity, project scope, accepted successor, and decision hashes verified. Semantic relevance is attested by the foreground calling agent.',
            ]
          : [],
    };
    writeReceipt(
      db,
      storedRepairSchema.parse({
        receipt,
        postHash: stateHash(db),
        proposalHash: hash(JSON.stringify(proposal)),
        rolledBack: false,
        decisions: snapshots,
        quarantine,
      }),
    );
    db.exec('COMMIT');
    return receipt;
  } catch (error) {
    db.exec('ROLLBACK');
    if (error instanceof KnowledgeRepairError) throw error;
    const receipt: KnowledgeRepairReceipt = {
      id: proposal.id,
      proposalId: proposal.id,
      findingId: proposal.findingId,
      projectId: proposal.projectId,
      action: proposal.action,
      state: 'failed',
      attempt,
      startedAt,
      completedAt: new Date().toISOString(),
      recovery: {
        snapshotId: `knowledge_repair:${proposal.id}`,
        restoreAction: {
          operation: 'knowledge.rollback',
          arguments: { receiptId: proposal.id },
          prerequisites: ['No repair changes were committed.'],
        },
      },
      verificationEvidence: [],
      reasons: [error instanceof Error ? error.message : String(error)],
    };
    db.exec('BEGIN IMMEDIATE');
    try {
      const latest = readReceipt(db, proposal.id);
      if (
        latest &&
        (latest.receipt.state !== 'failed' ||
          latest.receipt.attempt >= attempt ||
          latest.proposalHash !== hash(JSON.stringify(proposal)))
      ) {
        db.exec('COMMIT');
        return latest.receipt;
      }
      writeReceipt(
        db,
        storedRepairSchema.parse({
          receipt,
          postHash: stateHash(db),
          proposalHash: hash(JSON.stringify(proposal)),
          rolledBack: false,
          decisions: [],
          quarantine: null,
        }),
      );
      db.exec('COMMIT');
      return receipt;
    } catch (persistError) {
      db.exec('ROLLBACK');
      throw persistError;
    }
  }
}

/**
 * List accepted sourced repairs without changing retrieval counters.
 * @param projectRoot - Canonical project root containing the repair ledger.
 * @param limit - Maximum receipts read, default 100 and capped at 1000.
 * @returns Repaired receipts that have not been rolled back.
 * @remarks Historical receipts remain stored but cannot reappear as current guidance after rollback.
 * @example
 * ```ts
 * const corrections = await listKnowledgeRepairReceipts(projectRoot, 100);
 * ```
 */
export async function listKnowledgeRepairReceipts(
  projectRoot: string,
  limit = 100,
): Promise<KnowledgeRepairReceipt[]> {
  await getBrainDb(projectRoot);
  await getNexusDb(projectRoot);
  const db = getBrainNativeDb(projectRoot);
  if (!db)
    throw new KnowledgeRepairError('E_REPAIR_STORE', 'Project knowledge store is unavailable.');
  return db
    .prepare(
      "SELECT value FROM main._nexus_meta WHERE key LIKE 'knowledge_repair:%' ORDER BY rowid DESC LIMIT ?",
    )
    .all(Math.max(1, Math.min(1000, limit)))
    .flatMap((row) => {
      if (typeof row.value !== 'string') throw new Error('Invalid stored repair receipt');
      const repair = storedRepairSchema.parse(JSON.parse(row.value));
      return !repair.rolledBack && repair.receipt.state === 'repaired' ? [repair.receipt] : [];
    });
}

function rollback(db: DatabaseSync, id: string): KnowledgeRepairReceipt {
  db.exec('BEGIN IMMEDIATE');
  try {
    const stored = readReceipt(db, id);
    if (!stored)
      throw new KnowledgeRepairError('E_REPAIR_NOT_FOUND', `Receipt ${id} was not found.`);
    if (!stored.rolledBack) {
      if (stored.postHash !== stateHash(db))
        throw new KnowledgeRepairError(
          'E_REPAIR_STALE',
          'Knowledge changed after repair; rollback would overwrite concurrent changes.',
        );
      if (stored.quarantine) {
        const restored = restoreObservationStubs(db, stored.quarantine);
        if (restored !== stored.quarantine.quarantinedIds?.length)
          throw new KnowledgeRepairError(
            'E_REPAIR_VERIFY',
            'Rollback did not restore every quarantined record.',
          );
      }
      for (const row of stored.decisions) {
        db.prepare(
          'UPDATE main.brain_decisions SET invalid_at = ?, superseded_by = ?, supersedes = ?, confirmation_state = ? WHERE id = ?',
        ).run(row.invalid_at, row.superseded_by, row.supersedes, row.confirmation_state, row.id);
      }
      stored.rolledBack = true;
      stored.receipt.state = 'unresolved';
      stored.receipt.reasons.push('Repair rolled back to the captured previous state.');
      writeReceipt(db, stored);
    }
    db.exec('COMMIT');
    return stored.receipt;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

/**
 * Assess project knowledge and optionally apply verified foreground repairs.
 * @param projectRoot - Canonical project identity root; source-root selection stays explicit.
 * @param options - Assessment budget, deterministic fix mode, sourced proposal, or receipt recovery.
 * @returns Separate health dimensions, actionable findings, proposals, and durable repair receipts.
 * @remarks Rollback conservatively checks the entire substantive project state, including unrelated later edits. Automatic repair is capped at 25 confirmed stubs and checked against the maintenance deadline before mutation.
 * @example
 * ```ts
 * const options = { fix: true, dryRun: true };
 * const report = await runKnowledgeDoctor(projectRoot, options);
 * ```
 */
export async function runKnowledgeDoctor(
  projectRoot: string,
  options: KnowledgeDoctorOptions = {},
): Promise<KnowledgeDoctorResult> {
  const deadline = Date.now() + Math.max(0, options.budgetMs ?? 2000);
  const coverage = await assessKnowledgeCoverage(
    projectRoot,
    undefined,
    Math.max(0, deadline - Date.now()),
  );
  const result: KnowledgeDoctorResult = {
    health: {
      coverage,
      structure: {
        status: 'unavailable',
        reasons: ['Knowledge record checks have not completed.'],
        evidence: [],
      },
      semantics: {
        status: 'unavailable',
        reasons: ['Semantic authority has not been assessed.'],
        evidence: [],
      },
      extraction: {
        status:
          coverage.status === 'failed'
            ? 'failed'
            : coverage.status === 'current'
              ? 'clean'
              : 'unavailable',
        reasons: [...coverage.reasons],
        evidence: coverage.evidence,
      },
      findings: [],
    },
    stateHash: '',
    proposals: [],
    receipts: [],
    dryRun: options.dryRun ?? false,
  };
  const defer = (reason: string): KnowledgeDoctorResult => {
    coverage.maintenanceState = 'pending';
    coverage.nextAction = 'cleo doctor knowledge';
    if (!coverage.reasons.includes(reason)) coverage.reasons.push(reason);
    return result;
  };
  if (coverage.maintenanceState === 'pending' || Date.now() >= deadline)
    return defer('Knowledge maintenance exceeded its budget; no automatic repair was applied.');
  try {
    await getBrainDb(projectRoot);
    await getNexusDb(projectRoot);
    const db = getBrainNativeDb(projectRoot);
    if (!db)
      throw new KnowledgeRepairError('E_REPAIR_STORE', 'Project knowledge store is unavailable.');
    if (Date.now() >= deadline)
      return defer('Knowledge record assessment was deferred by the maintenance budget.');
    const volume = db
      .prepare(
        'SELECT (SELECT COUNT(*) FROM main.brain_decisions) + (SELECT COUNT(*) FROM main.brain_observations) AS total',
      )
      .get();
    if (
      !options.proposal &&
      !options.rollback &&
      (options.budgetMs ?? 2000) <= 2000 &&
      typeof volume?.total === 'number' &&
      volume.total > 2000
    ) {
      if (coverage.status === 'current') coverage.status = 'partial';
      return defer(
        'More than 2000 knowledge records require explicit doctor assessment with a larger budget; bounded maintenance did not scan all records.',
      );
    }
    const state = readState(db);
    result.stateHash = hash(JSON.stringify(state));
    if (Date.now() >= deadline)
      return defer('Knowledge state assessment exceeded the maintenance budget.');
    const orphanFinding = scanBrainGraphOrphans(db);
    const structuralEvidence: KnowledgeEvidenceRef[] = orphanFinding
      ? [
          {
            id: 'brain_page_edges',
            projectId: coverage.projectId,
            source: 'memory',
            revision: coverage.assessedRevision,
            precision: 'project',
          },
        ]
      : [];
    result.health.structure = {
      status: orphanFinding ? 'findings' : 'clean',
      reasons: orphanFinding
        ? [orphanFinding.description]
        : [
            'Canonical knowledge records are readable and every brain graph edge has both endpoints.',
          ],
      evidence: structuralEvidence,
    };
    if (orphanFinding)
      result.health.findings.push({
        id: `brain-orphan-edges:${coverage.projectId}`,
        projectId: coverage.projectId,
        affectedRecordIds: orphanFinding.sampleIds,
        description: orphanFinding.description,
        evidence: structuralEvidence,
        repairClass: 'agent-resolvable',
        state: 'unresolved',
        proposedAction: {
          operation: 'memory.backfill.run',
          arguments: { source: 'knowledge-doctor-orphan-review' },
          prerequisites: [
            'Capture a canonical backup before any graph repair.',
            'Select exact qualified nodeIds for source-backed missing endpoints; exclude unrelated dispatch traces and quarantined noise.',
            'Inspect staged candidate IDs and confirm each has an existing typed source record.',
            'Approve only the reviewed staged run with memory.backfill.approve; retain missing-source history as unresolved.',
          ],
        },
        verification: [
          'Rerun memory.doctor and verify both endpoints for reconstructed graph references.',
          'Preserve all historical edges; report any endpoints without backing records as unresolved.',
          'Retain the staged run ID for memory.backfill.rollback and verify only reviewed nodes were inserted.',
        ],
        recovery: null,
      });
    const decisionIds = new Set(state.decisions.map((row) => row.id));
    const dangling = state.decisions.filter(
      (row) => row.superseded_by && !decisionIds.has(row.superseded_by),
    );
    result.health.semantics = {
      status: dangling.length ? 'findings' : 'unavailable',
      reasons: dangling.length
        ? dangling.map((row) => `Decision ${row.id} references a missing successor.`)
        : [
            'Explicit successor references checked; semantic reconciliation requires the calling agent.',
          ],
      evidence: [],
    };
    if (coverage.status !== 'current')
      result.health.findings.push({
        id: `graph-coverage:${coverage.projectId}`,
        projectId: coverage.projectId,
        affectedRecordIds: [],
        description: coverage.reasons.join(' '),
        evidence: coverage.evidence,
        repairClass: 'agent-resolvable',
        state: coverage.status === 'failed' ? 'failed' : 'unresolved',
        proposedAction: {
          operation: 'nexus.analyze',
          arguments: {},
          prerequisites: ['Confirm the intended source root and repository inclusions.'],
        },
        verification: ['Reassess graph revision, extraction outcomes, and source freshness.'],
        recovery: null,
      });
    const preview = pruneObservationStubs(db, false);
    if (preview.matched) {
      const evidence: [KnowledgeEvidenceRef, ...KnowledgeEvidenceRef[]] = [
        {
          id: 'confirmed-observation-stubs',
          projectId: coverage.projectId,
          source: 'memory',
          revision: coverage.assessedRevision,
          precision: 'record',
        },
      ];
      const proposal: KnowledgeRepairProposal = {
        id: `quarantine-${result.stateHash.slice(0, 24)}`,
        findingId: `observation-stubs:${coverage.projectId}`,
        projectId: coverage.projectId,
        expectedRevision: coverage.assessedRevision,
        expectedStateHash: result.stateHash,
        action: {
          operation: 'knowledge.quarantine-stubs',
          arguments: {},
          prerequisites: ['Only the existing narrow stub predicates may match.'],
        },
        evidence,
      };
      result.proposals.push(proposal);
      const previousAttempt = readReceipt(db, proposal.id);
      if (previousAttempt?.receipt.state === 'failed')
        result.receipts.push(previousAttempt.receipt);
      result.health.findings.push({
        id: proposal.findingId,
        projectId: coverage.projectId,
        affectedRecordIds: [...(preview.candidateIds ?? preview.sample.map((row) => row.id))],
        description: `${preview.matched} confirmed content-free observation stubs.`,
        evidence,
        repairClass: 'automatic',
        state: previousAttempt?.receipt.state ?? 'pending',
        proposedAction: proposal.action,
        verification: [
          'All matched rows are retained with a quarantine timestamp and excluded from current retrieval.',
        ],
        recovery: null,
      });
    }
    if (options.decisionId && Date.now() < deadline) {
      const decision = await linkDecisionToCodeEvidence(projectRoot, options.decisionId);
      result.health.findings.push(...decision.findings);
      for (const link of decision.links)
        result.health.findings.push({
          id: `decision-link:${link.decisionId}:${link.targetId}`,
          projectId: coverage.projectId,
          affectedRecordIds: [
            link.decisionId,
            ...(link.taskId ? [link.taskId] : []),
            link.targetId,
          ],
          description: `Explicit ${link.precision}-level decision evidence can be reconciled through memory.code.link.`,
          evidence: link.evidence,
          repairClass: 'automatic',
          state: 'pending',
          proposedAction: {
            operation: 'memory.code.link',
            arguments: { memoryId: `decision:${link.decisionId}`, codeSymbol: link.targetId },
            prerequisites: [
              'The accepted decision, task evidence, target file, and graph generation must still match.',
            ],
          },
          verification: [
            'Read code links and inspect retained source, revision, generation, and precision metadata.',
          ],
          recovery: null,
        });
    }
    if (options.taskId && Date.now() < deadline) {
      const taskEvidence = await getTaskKnowledgeEvidence(
        options.taskId,
        projectRoot,
        coverage,
        deadline,
      );
      result.health.findings.push(...taskEvidence.findings);
      if (taskEvidence.files.length)
        result.health.findings.push({
          id: `live-evidence:${options.taskId}`,
          projectId: coverage.projectId,
          affectedRecordIds: [options.taskId],
          description:
            'Explicit task evidence is resolved live; no persistent backfill is required.',
          evidence: taskEvidence.files.flatMap((file) => file.evidence),
          repairClass: 'automatic',
          state: taskEvidence.findings.length ? 'unresolved' : 'repaired',
          proposedAction: null,
          verification: [
            'Footprints consume current task verification, commit references, and canonical attachments with file-level precision.',
          ],
          recovery: null,
        });
    }
    if (Date.now() >= deadline)
      return defer('Knowledge maintenance exceeded its budget; no automatic repair was applied.');
    if (options.fix && !options.proposal && preview.matched > 25)
      return defer(
        'More than 25 confirmed stubs require explicit proposal submission; no automatic repair was applied.',
      );
    if (options.dryRun) return result;
    const exhausted = result.receipts.find(
      (receipt) => receipt.state === 'failed' && receipt.attempt >= 3,
    );
    if (options.fix && exhausted && !options.proposal)
      return defer(
        'Automatic repair failed three times for unchanged source state; inspect the failed receipt before retrying.',
      );
    if (options.rollback) result.receipts.push(rollback(db, options.rollback));
    else if (options.proposal)
      result.receipts.push(
        applyProposal(db, proposalSchema.parse(options.proposal), result, projectRoot),
      );
    else if (options.fix && result.proposals[0])
      result.receipts.push(applyProposal(db, result.proposals[0], result, projectRoot));
    result.receipts = [
      ...new Map(result.receipts.map((receipt) => [receipt.id, receipt])).values(),
    ];
    for (const receipt of result.receipts) {
      const finding = result.health.findings.find((entry) => entry.id === receipt.findingId);
      if (finding) {
        finding.state = receipt.state;
        finding.recovery = receipt.recovery;
      }
    }
    return result;
  } catch (error) {
    if (error instanceof KnowledgeRepairError) throw error;
    const reason = `Knowledge diagnostics failed: ${error instanceof Error ? error.message : String(error)}`;
    result.health.structure = { status: 'failed', reasons: [reason], evidence: [] };
    result.health.coverage.status = 'failed';
    result.health.coverage.reasons.push(reason);
    return result;
  }
}
