/**
 * Foreground knowledge assessment and transactional, sourced repair.
 *
 * Code placed in `packages/core/` per Package-Boundary Check — verified
 * against AGENTS.md. No repair reasoning is delegated to a background model.
 */

import { createHash, randomUUID } from 'node:crypto';
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
import type { OperationExecutionContext } from '@cleocode/contracts/jobs';
import type {
  KnowledgePreparedRepairProposal,
  KnowledgeRepairAttemptFailure,
  KnowledgeRepairAttemptOutcome,
  KnowledgeRepairCancellation,
  KnowledgeRepairExecution,
  KnowledgeRepairInspection,
  KnowledgeRepairPreparation,
  KnowledgeRepairRecoveredState,
  KnowledgeRepairResource,
} from '@cleocode/contracts/knowledge-health';
import { z } from 'zod';
import { loadProjectInfo } from '../config/registry.js';
import { scanBrainGraphOrphans } from '../memory/brain-doctor.js';
import { pruneObservationStubs, restoreObservationStubs } from '../memory/brain-stub-prune.js';
import { linkDecisionToCodeEvidence } from '../memory/decision-cross-link.js';
import { generateProjectHash } from '../nexus/hash.js';
import { assessKnowledgeCoverage, readKnowledgeIndexAssessment } from '../nexus/knowledge.js';
import { getTaskKnowledgeEvidence } from '../nexus/task-evidence.js';
import { worktreeScope } from '../paths.js';
import {
  type BackgroundJob,
  BackgroundJobError,
  DurableJobStore,
} from '../store/background-jobs.js';
import {
  bindOperationWriteFence,
  createOperationExecutionContext,
  OperationExecutionError,
} from '../store/background-ops.js';
import { resolveDualScopeDbPath } from '../store/dual-scope-db.js';
import { getBrainDb, getBrainNativeDb } from '../store/memory-sqlite.js';
import { getNexusDb } from '../store/nexus-sqlite.js';
import { getDb, getNativeDb } from '../store/sqlite.js';

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
const executionIdentitySchema = z
  .object({
    projectId: z.string().min(1),
    projectRoot: z.string().min(1),
    actor: z.string().min(1),
    operation: z.literal('doctor.knowledge'),
    idempotencyKey: z.string().min(1),
  })
  .strict();
const resourceSchema = z
  .object({
    kind: z.enum(['decision', 'observation', 'file']),
    id: z.string().min(1),
    role: z.enum(['affected', 'source']),
    beforeHash: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
const rollbackReferenceSchema = z.object({
  receiptId: z.string().min(1),
  receiptHash: z.string().regex(/^[a-f0-9]{64}$/),
});
const repairExecutionSchema = z.object({
  rollback: rollbackReferenceSchema.optional(),
  identity: executionIdentitySchema,
  jobId: z.string(),
  ownerId: z.string(),
  fencingEpoch: z.number().int().positive(),
  proposalHash: z.string().regex(/^[a-f0-9]{64}$/),
  generation: z.string().nullable(),
  resources: z.array(resourceSchema.extend({ afterHash: z.string().regex(/^[a-f0-9]{64}$/) })),
  eventIds: z.array(z.string()),
});
const receiptSchema = z.object({
  execution: repairExecutionSchema.optional(),
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

const preparedProposalSchema = proposalSchema
  .extend({
    version: z.literal(1),
    rollback: rollbackReferenceSchema.optional(),
    identity: executionIdentitySchema,
    databasePath: z.string().min(1),
    sourceRoot: z.string().min(1),
    expectedGeneration: z.string().nullable(),
    assessmentHash: z.string().regex(/^[a-f0-9]{64}$/),
    resources: z.array(resourceSchema),
  })
  .strict();

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
  /** Observed owned-attempt outcome and truthful persistence status. @defaultValue undefined */
  readonly attemptFailure?: KnowledgeRepairAttemptFailure;
  /** Current recovery state, separate from an unmodified historical receipt. @defaultValue undefined */
  readonly recoveryState?: KnowledgeRepairRecoveredState;
  /**
   * Construct an actionable validation or concurrency error.
   * @param code - Stable repair validation failure code.
   * @param message - Observable reason the repair was rejected.
   * @param attemptFailure - Optional observed attempt with committed or pending finalization.
   * @param recoveryState - Optional current rollback disclosure retaining authentic historical receipts.
   */
  constructor(
    code: string,
    message: string,
    attemptFailure?: KnowledgeRepairAttemptFailure,
    recoveryState?: KnowledgeRepairRecoveredState,
  ) {
    super(message);
    this.name = 'KnowledgeRepairError';
    this.code = code;
    this.attemptFailure = attemptFailure;
    this.recoveryState = recoveryState;
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

/** Read the complete authentic original snapshot; legacy receipts require their conservative recovery path. */
function rollbackSnapshot(db: DatabaseSync, proposal: KnowledgeRepairProposal, root: string) {
  const id = proposal.action.arguments.receiptId;
  if (typeof id !== 'string' || id === proposal.id)
    throw new KnowledgeRepairError(
      'E_REPAIR_INPUT',
      'Rollback requires a distinct original receiptId.',
    );
  const bytes = db
    .prepare('SELECT value FROM main._nexus_meta WHERE key=?')
    .get(`knowledge_repair:${id}`)?.value;
  if (typeof bytes !== 'string')
    throw new KnowledgeRepairError(
      'E_REPAIR_NOT_FOUND',
      'Original rollback snapshot is unavailable.',
    );
  const stored = storedRepairSchema.parse(JSON.parse(bytes));
  const execution = stored.receipt.execution;
  if (
    !execution ||
    stored.receipt.state !== 'repaired' ||
    stored.receipt.id !== id ||
    stored.receipt.action?.operation === 'knowledge.rollback' ||
    stored.receipt.projectId !== proposal.projectId ||
    execution.identity.projectId !== proposal.projectId ||
    execution.identity.projectRoot !== root ||
    stored.rolledBack ||
    db.prepare('SELECT 1 FROM main._nexus_meta WHERE key=?').get(`knowledge_rollback:${id}`)
  )
    throw new KnowledgeRepairError(
      'E_REPAIR_RECOVERY',
      'Receipt lacks current scoped recovery authority; inspect its retained history.',
    );
  const affected = execution.resources.filter((resource) => resource.role === 'affected');
  const expectedIds = stored.quarantine?.quarantinedIds ?? stored.decisions.map((row) => row.id);
  if (
    !affected.length ||
    affected.some((resource) => resource.kind === 'file') ||
    affected.length !== expectedIds.length ||
    affected.some((resource) => !expectedIds.includes(resource.id)) ||
    new Set(affected.map((resource) => `${resource.kind}:${resource.id}`)).size !== affected.length
  )
    throw new KnowledgeRepairError(
      'E_REPAIR_RECOVERY',
      'Retained snapshot does not cover every affected resource.',
    );
  return { stored, affected, reference: { receiptId: id, receiptHash: hash(bytes) } };
}

/** Capture exact row identities and complete images without broadening the existing action. */
function repairResources(
  db: DatabaseSync,
  proposal: KnowledgeRepairProposal,
  projectRoot: string,
): KnowledgeRepairResource[] {
  const resources: KnowledgeRepairResource[] = [];
  const capture = (kind: 'decision' | 'observation', id: string, role: 'affected' | 'source') => {
    if (resources.some((resource) => resource.kind === kind && resource.id === id)) return;
    const row =
      kind === 'decision'
        ? db.prepare('SELECT * FROM main.brain_decisions WHERE id = ?').get(id)
        : db.prepare('SELECT * FROM main.brain_observations WHERE id = ?').get(id);
    if (!row) throw new KnowledgeRepairError('E_REPAIR_SOURCE', `Missing ${kind} resource ${id}`);
    resources.push({ kind, id, role, beforeHash: hash(JSON.stringify(row)) });
  };
  if (proposal.action.operation === 'knowledge.rollback') {
    const original = rollbackSnapshot(db, proposal, projectRoot);
    for (const resource of original.affected) {
      if (resourceHash(db, resource, projectRoot) !== resource.afterHash)
        throw new KnowledgeRepairError(
          'E_REPAIR_STALE',
          `Affected resource ${resource.id} changed after repair.`,
        );
      resources.push({
        kind: resource.kind,
        id: resource.id,
        role: 'affected',
        beforeHash: resource.afterHash,
      });
    }
  } else if (proposal.action.operation === 'knowledge.quarantine-stubs') {
    for (const id of pruneObservationStubs(db, false).candidateIds ?? [])
      capture('observation', id, 'affected');
  } else if (proposal.action.operation === 'knowledge.supersede-decision') {
    const previousId = proposal.action.arguments.previousId;
    const successorId = proposal.action.arguments.successorId;
    if (
      typeof previousId !== 'string' ||
      typeof successorId !== 'string' ||
      previousId === successorId
    )
      throw new KnowledgeRepairError(
        'E_REPAIR_INPUT',
        'Distinct previousId and successorId are required.',
      );
    const state = readState(db);
    const previous = state.decisions.find((row) => row.id === previousId);
    const successor = state.decisions.find((row) => row.id === successorId);
    if (!previous || !successor)
      throw new KnowledgeRepairError('E_REPAIR_SOURCE', 'Missing authority record.');
    validateAuthoritySources(db, proposal, previous, successor, projectRoot);
    capture('decision', previousId, 'affected');
    capture('decision', successorId, 'affected');
    for (const source of proposal.evidence) {
      if (source.source === 'file') {
        resources.push({
          kind: 'file',
          id: source.id,
          role: 'source',
          beforeHash: hash(readFileSync(resolve(projectRoot, source.id), 'utf8')),
        });
      } else if (source.source === 'memory') {
        const kind = state.decisions.some((row) => row.id === source.id)
          ? 'decision'
          : 'observation';
        capture(kind, source.id, 'source');
      }
    }
  } else throw new KnowledgeRepairError('E_REPAIR_INPUT', 'Unsupported repair resource action.');
  return resources.sort(
    (left, right) => left.kind.localeCompare(right.kind) || left.id.localeCompare(right.id),
  );
}

/**
 * Prepare a sourced existing knowledge repair without starting an executor.
 * @param context - Captured project, actor, retry identity, cancellation and shared deadline.
 * @param input - Existing supported proposal whose revision and state must still match.
 * @returns Authentic immutable pending work or the identical existing submission.
 * @throws KnowledgeRepairError when scope, source evidence or preconditions are invalid.
 * @remarks The existing job store commits proposal bytes and their digest atomically.
 * Cancellation is cooperative at guarded boundaries; admitted synchronous SQLite work
 * cannot be preempted by a timer. Preparation never changes authority or quarantine.
 * @example
 * ```ts
 * const pending = await prepareKnowledgeRepair(context, report.proposals[0]);
 * ```
 */
export async function prepareKnowledgeRepair(
  context: OperationExecutionContext,
  input: KnowledgeRepairProposal,
): Promise<KnowledgeRepairPreparation> {
  context.assertActive();
  const proposal = proposalSchema.parse(input);
  if (
    context.identity.operation !== 'doctor.knowledge' ||
    proposal.projectId !== context.identity.projectId ||
    proposal.id !== context.identity.idempotencyKey
  )
    throw new KnowledgeRepairError(
      'E_REPAIR_SCOPE',
      'Repair proposal and captured operation identity must match.',
    );
  return worktreeScope.run(
    {
      worktreeRoot: context.identity.projectRoot,
      projectHash: generateProjectHash(context.identity.projectRoot),
      execution: context,
    },
    async () => {
      const root = context.identity.projectRoot;
      const info = await loadProjectInfo(root);
      context.assertActive();
      if (
        !info ||
        info.projectId !== context.identity.projectId ||
        (info.projectRoot !== undefined && info.projectRoot !== root)
      )
        throw new KnowledgeRepairError(
          'E_REPAIR_SCOPE',
          'Canonical project metadata differs from the captured repair scope.',
        );
      const taskDb = await getDb(root);
      context.assertActive();
      const store = new DurableJobStore(taskDb, {
        projectId: context.identity.projectId,
        actor: context.identity.actor,
      });
      // Existing exact submissions remain inspectable even after a later repair changes source state.
      const prior = store.findSubmission(context.identity.operation, {
        projectId: context.identity.projectId,
        idempotencyKey: context.identity.idempotencyKey,
        proposalJson: JSON.stringify(proposal),
      });
      if (prior) {
        if (
          !prior.proposalJson ||
          !prior.proposalHash ||
          hash(prior.proposalJson) !== prior.proposalHash
        )
          throw new KnowledgeRepairError(
            'E_REPAIR_SOURCE',
            'Existing job lacks authentic prepared input.',
          );
        const prepared = preparedProposalSchema.parse(JSON.parse(prior.proposalJson));
        if (
          JSON.stringify(proposalSchema.parse(prepared)) !== JSON.stringify(proposal) ||
          JSON.stringify(prepared.identity) !==
            JSON.stringify(preparedProposalSchema.shape.identity.parse(context.identity))
        )
          throw new KnowledgeRepairError(
            'E_REPAIR_ID_REUSED',
            'Retry identity already belongs to different immutable inputs.',
          );
        return {
          jobId: prior.id,
          jobStatus: prior.status,
          proposalHash: prior.proposalHash,
          proposal: prepared,
          deadlineAt: context.deadlineAt,
          deadlineExceeded: Date.now() >= context.deadlineAt,
        };
      }
      const coverage = await assessKnowledgeCoverage(
        root,
        context.identity.projectId,
        Math.max(0, context.deadlineAt - Date.now()),
      );
      context.assertActive();
      if (coverage.maintenanceState === 'pending' || coverage.status === 'failed')
        throw new KnowledgeRepairError('E_REPAIR_ASSESSMENT', coverage.reasons.join('; '));
      await getBrainDb(root);
      const assessment = await readKnowledgeIndexAssessment(root);
      context.assertActive();
      const db = getBrainNativeDb(root);
      if (!db)
        throw new KnowledgeRepairError('E_REPAIR_STORE', 'Project knowledge store is unavailable.');
      if (
        proposal.action.operation !== 'knowledge.rollback' &&
        (proposal.expectedRevision !== coverage.assessedRevision ||
          proposal.expectedStateHash !== stateHash(db))
      )
        throw new KnowledgeRepairError(
          'E_REPAIR_STALE',
          'Repair preconditions changed; reassess before preparation.',
        );
      const resources = repairResources(db, proposal, root);
      const prepared: KnowledgePreparedRepairProposal = preparedProposalSchema.parse({
        ...proposal,
        version: 1,
        identity: context.identity,
        databasePath: resolveDualScopeDbPath('project', root),
        sourceRoot: assessment?.sourceRoot ?? root,
        expectedGeneration: assessment?.generation ?? null,
        assessmentHash: hash(JSON.stringify(assessment)),
        resources,
        rollback:
          proposal.action.operation === 'knowledge.rollback'
            ? rollbackSnapshot(db, proposal, root).reference
            : undefined,
      });
      const proposalJson = JSON.stringify(prepared);
      context.consume({ bytes: Buffer.byteLength(proposalJson, 'utf8'), items: resources.length });
      context.assertActive();
      const job = store.defer(
        randomUUID(),
        context.identity.operation,
        Date.now(),
        {
          projectId: context.identity.projectId,
          idempotencyKey: context.identity.idempotencyKey,
          proposalJson,
        },
        context,
      );
      return {
        jobId: job.id,
        jobStatus: job.status,
        proposalHash: hash(proposalJson),
        proposal: prepared,
        deadlineAt: context.deadlineAt,
        deadlineExceeded: Date.now() >= context.deadlineAt,
      };
    },
  );
}

/** Read a complete resource image using only fixed supported tables and captured paths. */
function resourceHash(db: DatabaseSync, resource: KnowledgeRepairResource, root: string): string {
  if (resource.kind === 'file') return hash(readFileSync(resolve(root, resource.id), 'utf8'));
  const row =
    resource.kind === 'decision'
      ? db.prepare('SELECT * FROM main.brain_decisions WHERE id=?').get(resource.id)
      : db.prepare('SELECT * FROM main.brain_observations WHERE id=?').get(resource.id);
  if (!row)
    throw new KnowledgeRepairError('E_REPAIR_STALE', `Resource ${resource.id} disappeared.`);
  return hash(JSON.stringify(row));
}

/** Append immutable ledger bytes and verify their persisted image inside the caller-owned transaction. */
function appendVerifiedMetadata(db: DatabaseSync, key: string, bytes: string): void {
  db.prepare('INSERT INTO main._nexus_meta(key,value) VALUES (?,?)').run(key, bytes);
  if (db.prepare('SELECT value FROM main._nexus_meta WHERE key=?').get(key)?.value !== bytes)
    throw new KnowledgeRepairError(
      'E_REPAIR_VERIFY',
      'Append-only ledger readback differs from observed bytes.',
    );
}

/**
 * Construct a repair invocation using a root and deadline captured before caller asynchronous work.
 * @param projectRoot - Explicit project identity root captured by the foreground caller.
 * @param actor - Explicit stable caller attribution; never copied from stored proposal ownership.
 * @param proposalId - Immutable proposal/retry key supplied by the caller.
 * @param deadlineAt - Original absolute invocation deadline including earlier file reads.
 * @returns Validated execution context that the caller must close in a finally block.
 * @throws KnowledgeRepairError when actor, identity or deadline input is invalid.
 * @remarks Metadata reads do not renew the deadline. This attribution is not an owner signature.
 * @example
 * ```ts
 * const context = await createKnowledgeRepairInvocation(root, actor, proposalId, deadlineAt);
 * ```
 */
export async function createKnowledgeRepairInvocation(
  projectRoot: string,
  actor: string,
  proposalId: string,
  deadlineAt: number,
): Promise<OperationExecutionContext> {
  const root = resolve(projectRoot);
  if (!actor.trim() || !proposalId.trim() || !Number.isSafeInteger(deadlineAt))
    throw new KnowledgeRepairError(
      'E_REPAIR_INPUT',
      'Explicit actor, proposal identity and original deadline are required.',
    );
  const info = await worktreeScope.run(
    { worktreeRoot: root, projectHash: generateProjectHash(root) },
    () => loadProjectInfo(root),
  );
  if (
    typeof info?.projectId !== 'string' ||
    !info.projectId ||
    (info.projectRoot !== undefined && info.projectRoot !== root)
  )
    throw new KnowledgeRepairError(
      'E_REPAIR_SCOPE',
      'Canonical project identity is required for repair execution.',
    );
  const context = createOperationExecutionContext(
    {
      projectId: info.projectId,
      projectRoot: root,
      actor,
      operation: 'doctor.knowledge',
      idempotencyKey: proposalId,
    },
    { budgetMs: Math.max(0, deadlineAt - Date.now()), deadlineAt },
  );
  try {
    context.assertActive();
    return context;
  } catch (error) {
    context.close();
    throw error;
  }
}

/**
 * Prepare guarded recovery from a retained original receipt without applying it.
 * @param context - Explicit recovery actor, new immutable proposal identity and original deadline.
 * @param receiptId - Successful scoped original receipt whose complete affected images are retained.
 * @returns Durable immutable pending rollback through the existing preparation service.
 * @throws KnowledgeRepairError when the receipt, evidence or affected resources cannot authorize recovery.
 * @remarks Historical receipt bytes are retained; unrelated changes do not authorize overwriting an affected edit.
 * @example
 * ```ts
 * const pending = await prepareKnowledgeRollback(context, originalReceiptId);
 * ```
 */
export async function prepareKnowledgeRollback(
  context: OperationExecutionContext,
  receiptId: string,
): Promise<KnowledgeRepairPreparation> {
  context.assertActive();
  return worktreeScope.run(
    {
      worktreeRoot: context.identity.projectRoot,
      projectHash: generateProjectHash(context.identity.projectRoot),
      execution: context,
    },
    async () => {
      await getBrainDb(context.identity.projectRoot);
      context.assertActive();
      const db = getBrainNativeDb(context.identity.projectRoot);
      if (!db) throw new KnowledgeRepairError('E_REPAIR_STORE', 'Recovery store is unavailable.');
      const store = new DurableJobStore(await getDb(context.identity.projectRoot), {
        projectId: context.identity.projectId,
        actor: context.identity.actor,
      });
      const prior = store.findSubmission(context.identity.operation, {
        projectId: context.identity.projectId,
        idempotencyKey: context.identity.idempotencyKey,
        proposalJson: '{}',
      });
      if (prior) {
        const { prepared } = validatePreparedJob(context, prior);
        if (
          prepared.action.operation !== 'knowledge.rollback' ||
          prepared.rollback?.receiptId !== receiptId
        )
          throw new KnowledgeRepairError(
            'E_REPAIR_ID_REUSED',
            'Recovery identity already belongs to different immutable inputs.',
          );
        return prepareKnowledgeRepair(context, proposalSchema.parse(prepared));
      }
      const original = readReceipt(db, receiptId);
      const first = original?.receipt.verificationEvidence[0];
      if (!original || !first)
        throw new KnowledgeRepairError(
          'E_REPAIR_SOURCE',
          'Original sourced receipt is unavailable.',
        );
      return prepareKnowledgeRepair(context, {
        id: context.identity.idempotencyKey,
        findingId: `rollback:${receiptId}`,
        projectId: context.identity.projectId,
        expectedRevision: null,
        expectedStateHash: stateHash(db),
        action: { operation: 'knowledge.rollback', arguments: { receiptId }, prerequisites: [] },
        evidence: [first, ...original.receipt.verificationEvidence.slice(1)],
      });
    },
  );
}

/** Read exact persisted generation bytes for an immediate transactional recheck. */
function assessmentBytes(db: DatabaseSync): string | null {
  const row = db.prepare("SELECT value FROM main._nexus_meta WHERE key='graph_assessment'").get();
  if (!row) return null;
  if (typeof row.value !== 'string')
    throw new KnowledgeRepairError('E_REPAIR_SOURCE', 'Invalid generation metadata.');
  return row.value;
}

/**
 * Apply an authentic prepared repair through the established owned job transaction.
 * @param context - Captured scope and one deadline shared by this foreground attempt.
 * @param jobId - Existing durable pending proposal or inspectable completed operation.
 * @returns Verified receipt committed with the source mutation and terminal job state.
 * @throws KnowledgeRepairError when immutable inputs, resources, generation or identity changed.
 * @remarks Uses the existing domain validators and repair ledger. Synchronous database
 * work cannot be preempted; cancellation is checked at cooperating write boundaries.
 * File hashes are rechecked around mutation but SQLite cannot lock external file edits.
 * A later explicit invocation may supply a new bounded context for the same immutable
 * proposal; an active attempt never renews its deadline. Interrupted uncommitted work
 * records observed failure/cancellation atomically when the original budget and
 * ownership permit; otherwise the error explicitly reports pending finalization
 * and retains the lease/checkpoint. No automatic retry or background reasoning runs.
 * @example
 * ```ts
 * const receipt = await applyPreparedKnowledgeRepair(context, pending.jobId);
 * ```
 */
export async function applyPreparedKnowledgeRepair(
  context: OperationExecutionContext,
  jobId: string,
): Promise<KnowledgeRepairReceipt> {
  return executePreparedKnowledgeRepair(context, jobId, false);
}

/**
 * Explicitly resume immutable repair work, preserving terminal or expired running attempts before retry.
 * @param context - Fresh bounded invocation with the same explicit actor and proposal identity.
 * @param jobId - Authentic prepared job to inspect and revalidate before retry.
 * @returns Existing committed receipt or the newly committed repair receipt.
 * @throws KnowledgeRepairError when actor, source, recovery snapshot or resource preconditions changed.
 * @remarks Terminal retries retain the complete prior stored attempt atomically with a new claim.
 * An active attempt is never stolen and an expired context is never renewed. Already committed
 * effects are not reapplied. Historical outcomes and original repair evidence remain inspectable.
 * @example
 * ```ts
 * const receipt = await resumePreparedKnowledgeRepair(newInvocation, jobId);
 * ```
 */
export async function resumePreparedKnowledgeRepair(
  context: OperationExecutionContext,
  jobId: string,
): Promise<KnowledgeRepairReceipt> {
  return executePreparedKnowledgeRepair(context, jobId, true);
}

/** Parse immutable scoped job input without borrowing its actor or trusting its proposal hash alone. */
function validatePreparedJob(context: OperationExecutionContext, job: BackgroundJob) {
  const root = context.identity.projectRoot;
  if (!job.proposalJson || !job.proposalHash || hash(job.proposalJson) !== job.proposalHash)
    throw new KnowledgeRepairError(
      'E_REPAIR_SOURCE',
      'Authentic prepared repair input is unavailable.',
    );
  const prepared = preparedProposalSchema.parse(JSON.parse(job.proposalJson));
  if ((prepared.action.operation === 'knowledge.rollback') !== Boolean(prepared.rollback))
    throw new KnowledgeRepairError(
      'E_REPAIR_INPUT',
      'Recovery reference must match the supported rollback action.',
    );
  if (prepared.identity.actor !== context.identity.actor)
    throw new KnowledgeRepairError(
      'E_REPAIR_ACTOR',
      'Explicit actor differs from the immutable repair proposal; retain the original actor or prepare a separately authorized proposal.',
    );
  if (
    JSON.stringify(prepared.identity) !==
      JSON.stringify(executionIdentitySchema.parse(context.identity)) ||
    prepared.id !== context.identity.idempotencyKey ||
    prepared.projectId !== context.identity.projectId ||
    prepared.databasePath !== resolveDualScopeDbPath('project', root) ||
    job.operation !== context.identity.operation ||
    job.idempotencyKey !== context.identity.idempotencyKey
  )
    throw new KnowledgeRepairError(
      'E_REPAIR_SCOPE',
      'Prepared repair does not match the captured operation.',
    );
  return { prepared, proposalHash: job.proposalHash };
}

/** Open read/metadata services under the original captured execution scope. */
async function openPreparedKnowledgeRepair(context: OperationExecutionContext, jobId: string) {
  context.assertActive();
  return worktreeScope.run(
    {
      worktreeRoot: context.identity.projectRoot,
      projectHash: generateProjectHash(context.identity.projectRoot),
      execution: context,
    },
    async () => {
      const root = context.identity.projectRoot;
      const metadata = await loadProjectInfo(root);
      context.assertActive();
      if (
        !metadata ||
        metadata.projectId !== context.identity.projectId ||
        (metadata.projectRoot !== undefined && metadata.projectRoot !== root)
      )
        throw new KnowledgeRepairError('E_REPAIR_SCOPE', 'Canonical repair identity changed.');
      const taskDb = await getDb(root);
      await getBrainDb(root);
      context.assertActive();
      const db = getBrainNativeDb(root);
      if (!db || getNativeDb(root) !== db)
        throw new KnowledgeRepairError(
          'E_REPAIR_STORE',
          'Repair inspection requires the same scoped database handle.',
        );
      const store = new DurableJobStore(taskDb, {
        projectId: context.identity.projectId,
        actor: context.identity.actor,
      });
      const job = store.get(jobId);
      if (!job)
        throw new KnowledgeRepairError(
          'E_REPAIR_NOT_FOUND',
          'Prepared job was not found in this project.',
        );
      return { db, store, job, ...validatePreparedJob(context, job) };
    },
  );
}

/** Read a bounded page while disclosing all retained matching evidence. */
function inspectPreparedState(
  db: DatabaseSync,
  job: BackgroundJob,
  prepared: KnowledgePreparedRepairProposal,
  proposalHash: string,
  limit: number,
  offset: number,
): KnowledgeRepairInspection {
  if (
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 1000 ||
    !Number.isSafeInteger(offset) ||
    offset < 0
  )
    throw new KnowledgeRepairError(
      'E_REPAIR_INPUT',
      'Inspection limit must be 1–1000 and offset must be a nonnegative integer.',
    );
  const prefixes = [
    'knowledge_repair_event:',
    'knowledge_repair_attempt:',
    'knowledge_repair_retry:',
  ].map((prefix) => `${prefix}${job.id}:`);
  const total = db
    .prepare(
      'SELECT COUNT(*) AS total FROM main._nexus_meta WHERE instr(key,?)=1 OR instr(key,?)=1 OR instr(key,?)=1',
    )
    .get(...prefixes)?.total;
  if (typeof total !== 'number')
    throw new KnowledgeRepairError(
      'E_REPAIR_STORE',
      'Cannot enumerate the retained repair ledger.',
    );
  const ledger = db
    .prepare(
      'SELECT key,value FROM main._nexus_meta WHERE instr(key,?)=1 OR instr(key,?)=1 OR instr(key,?)=1 ORDER BY rowid LIMIT ? OFFSET ?',
    )
    .all(...prefixes, limit, offset)
    .map((row) => {
      if (typeof row.key !== 'string' || typeof row.value !== 'string')
        throw new KnowledgeRepairError('E_REPAIR_STORE', 'Invalid retained lifecycle entry.');
      return { key: row.key, valueJson: row.value };
    });
  const receipt = readReceipt(db, prepared.id)?.receipt ?? null;
  let rollbackReceipt: KnowledgeRepairReceipt | null = null;
  const marker = db
    .prepare('SELECT value FROM main._nexus_meta WHERE key=?')
    .get(`knowledge_rollback:${prepared.id}`)?.value;
  if (marker !== undefined) {
    if (typeof marker !== 'string')
      throw new KnowledgeRepairError('E_REPAIR_VERIFY', 'Invalid rollback marker.');
    const parsed = z
      .object({ receiptId: z.string(), original: rollbackReferenceSchema })
      .parse(JSON.parse(marker));
    rollbackReceipt = readReceipt(db, parsed.receiptId)?.receipt ?? null;
    if (
      !rollbackReceipt ||
      rollbackReceipt.execution?.rollback?.receiptId !== prepared.id ||
      JSON.stringify(rollbackReceipt.execution.rollback) !== JSON.stringify(parsed.original)
    )
      throw new KnowledgeRepairError(
        'E_REPAIR_VERIFY',
        'Rollback marker and retained recovery receipt disagree.',
      );
  }
  if (
    job.status === 'complete' &&
    (!receipt ||
      JSON.stringify(receiptSchema.parse(job.result)) !== JSON.stringify(receipt) ||
      receipt.execution?.jobId !== job.id ||
      receipt.execution?.proposalHash !== job.proposalHash)
  )
    throw new KnowledgeRepairError(
      'E_REPAIR_VERIFY',
      'Completed job and retained receipt disagree.',
    );
  return {
    jobId: job.id,
    status: job.status,
    proposalHash,
    proposal: prepared,
    attempts: job.attempts,
    fencingEpoch: job.fencingEpoch,
    ownerId: job.ownerId,
    leaseExpiresAt: job.leaseExpiresAt,
    cancellationRequestedAt: job.cancellationRequestedAt,
    checkpointJson: job.checkpointJson,
    receipt,
    rollbackReceipt,
    diagnosticError: job.diagnosticError ?? null,
    ledger,
    ledgerTotal: total,
    ledgerComplete: offset === 0 && ledger.length === total,
  };
}

/**
 * Inspect authentic prepared work, its receipt and separate append-only attempt history.
 * @param context - Captured project, explicit original actor and immutable proposal identity.
 * @param jobId - Existing durable operation identity.
 * @param limit - Maximum lifecycle entries, default 100 and bounded to 1000.
 * @param offset - Zero-based ledger page offset, default zero.
 * @returns Actual job state and a page whose completeness is explicit.
 * @throws KnowledgeRepairError when scope, actor, proposal or persisted evidence is inconsistent.
 * @remarks This does not infer a failed outcome from lease expiry or count a cancellation request as rollback.
 * @example
 * ```ts
 * const state = await inspectPreparedKnowledgeRepair(context, jobId, 100, 0);
 * ```
 */
export async function inspectPreparedKnowledgeRepair(
  context: OperationExecutionContext,
  jobId: string,
  limit = 100,
  offset = 0,
): Promise<KnowledgeRepairInspection> {
  const { db, job, prepared, proposalHash } = await openPreparedKnowledgeRepair(context, jobId);
  const result = inspectPreparedState(db, job, prepared, proposalHash, limit, offset);
  context.consume({
    bytes: Buffer.byteLength(JSON.stringify(result), 'utf8'),
    items: result.ledger.length,
  });
  context.assertActive();
  return result;
}

/**
 * Persist an explicit cancellation request under the original invocation budget.
 * @param context - Captured project, explicit actor and immutable proposal identity.
 * @param jobId - Existing prepared work to cancel or signal.
 * @returns Committed request status and actual observed job/receipt state.
 * @throws KnowledgeRepairError when scope or authentic prepared input is invalid.
 * @remarks Running work remains running until its owner acknowledges cancellation; completed
 * effects and receipts are preserved. Cancellation observed after commit cannot erase the request.
 * @example
 * ```ts
 * const cancellation = await cancelPreparedKnowledgeRepair(context, jobId);
 * ```
 */
export async function cancelPreparedKnowledgeRepair(
  context: OperationExecutionContext,
  jobId: string,
): Promise<KnowledgeRepairCancellation> {
  const { db, store, prepared, proposalHash } = await openPreparedKnowledgeRepair(context, jobId);
  const requested = store.requestCancel(jobId, Date.now(), context);
  try {
    context.assertActive();
    const job = store.get(jobId);
    if (!job)
      throw new KnowledgeRepairError(
        'E_REPAIR_VERIFY',
        'Cancellation target disappeared after persistence.',
      );
    const inspection = inspectPreparedState(db, job, prepared, proposalHash, 100, 0);
    context.consume({
      bytes: Buffer.byteLength(JSON.stringify(inspection), 'utf8'),
      items: inspection.ledger.length,
    });
    return {
      requested,
      inspection,
      diagnosticError: null,
      deadlineAt: context.deadlineAt,
      deadlineExceeded: Date.now() >= context.deadlineAt,
    };
  } catch (error) {
    return {
      requested,
      inspection: null,
      diagnosticError: `Cancellation request transaction completed; inspection failed: ${error instanceof Error ? error.message : String(error)}`,
      deadlineAt: context.deadlineAt,
      deadlineExceeded: Date.now() >= context.deadlineAt,
    };
  }
}

/** Execute existing prepared work; explicit terminal retries share the same original invocation deadline. */
async function executePreparedKnowledgeRepair(
  context: OperationExecutionContext,
  jobId: string,
  allowTerminalRetry: boolean,
): Promise<KnowledgeRepairReceipt> {
  context.assertActive();
  return worktreeScope.run(
    {
      worktreeRoot: context.identity.projectRoot,
      projectHash: generateProjectHash(context.identity.projectRoot),
      execution: context,
    },
    async () => {
      const root = context.identity.projectRoot;
      const metadata = await loadProjectInfo(root);
      context.assertActive();
      if (
        !metadata ||
        metadata.projectId !== context.identity.projectId ||
        (metadata.projectRoot !== undefined && metadata.projectRoot !== root)
      )
        throw new KnowledgeRepairError('E_REPAIR_SCOPE', 'Canonical repair identity changed.');
      const taskDb = await getDb(root);
      await getBrainDb(root);
      context.assertActive();
      const db = getBrainNativeDb(root);
      if (!db || getNativeDb(root) !== db)
        throw new KnowledgeRepairError(
          'E_REPAIR_STORE',
          'Repair and job store must share the same native transaction handle.',
        );
      const store = new DurableJobStore(taskDb, {
        projectId: context.identity.projectId,
        actor: context.identity.actor,
      });
      const job = store.get(jobId);
      if (!job)
        throw new KnowledgeRepairError(
          'E_REPAIR_NOT_FOUND',
          'Prepared job was not found in this project.',
        );
      const { prepared, proposalHash } = validatePreparedJob(context, job);
      if (job.status === 'complete') {
        const stored = readReceipt(db, prepared.id);
        const result = receiptSchema.parse(job.result);
        if (
          !stored ||
          stored.receipt.execution?.proposalHash !== job.proposalHash ||
          stored.receipt.execution.jobId !== jobId ||
          JSON.stringify(stored.receipt) !== JSON.stringify(result)
        )
          throw new KnowledgeRepairError(
            'E_REPAIR_VERIFY',
            'Completed job and retained receipt disagree.',
          );
        const current = inspectPreparedState(db, job, prepared, proposalHash, 1, 0);
        if (stored.rolledBack || current.rollbackReceipt)
          throw new KnowledgeRepairError(
            'E_REPAIR_ROLLED_BACK',
            'This historical repair was rolled back; inspect its recovery evidence and reassess before proposing new effects.',
            undefined,
            {
              state: 'rolled-back',
              originalReceipt: result,
              rollbackReceipt: current.rollbackReceipt,
            },
          );
        return result;
      }
      if (readReceipt(db, prepared.id))
        throw new KnowledgeRepairError(
          'E_REPAIR_ID_REUSED',
          'A retained repair receipt already owns this proposal identity.',
        );
      const originalAssessment = assessmentBytes(db);
      const assessment = await readKnowledgeIndexAssessment(root);
      const report = await runKnowledgeDoctor(root, {
        dryRun: true,
        budgetMs: context.remainingMs(),
      });
      context.assertActive();
      if (
        report.health.coverage.maintenanceState === 'pending' ||
        report.health.coverage.status === 'failed'
      )
        throw new KnowledgeRepairError(
          'E_REPAIR_ASSESSMENT',
          report.health.coverage.reasons.join('; '),
        );
      if (
        prepared.action.operation !== 'knowledge.rollback' &&
        (hash(JSON.stringify(assessment)) !== prepared.assessmentHash ||
          (assessment?.generation ?? null) !== prepared.expectedGeneration ||
          (assessment?.sourceRoot ?? root) !== prepared.sourceRoot ||
          assessmentBytes(db) !== originalAssessment)
      )
        throw new KnowledgeRepairError(
          'E_REPAIR_STALE',
          'Published generation changed after preparation.',
        );
      const recheckResources = () => {
        if (
          (prepared.action.operation !== 'knowledge.rollback' &&
            (assessmentBytes(db) !== originalAssessment ||
              stateHash(db) !== prepared.expectedStateHash)) ||
          JSON.stringify(repairResources(db, prepared, root)) !==
            JSON.stringify(prepared.resources) ||
          (prepared.rollback !== undefined &&
            JSON.stringify(rollbackSnapshot(db, prepared, root).reference) !==
              JSON.stringify(prepared.rollback))
        )
          throw new KnowledgeRepairError(
            'E_REPAIR_STALE',
            'Prepared resource or generation changed before mutation.',
          );
      };
      const lease =
        allowTerminalRetry &&
        (job.status === 'failed' || job.status === 'cancelled' || job.status === 'running')
          ? store.retryAtomically(jobId, Date.now(), context, (previousAttemptJson) => {
              recheckResources();
              const prior = z
                .object({ id: z.string(), fencingEpoch: z.number().int().nonnegative() })
                .parse(JSON.parse(previousAttemptJson));
              const key = `knowledge_repair_retry:${prior.id}:${prior.fencingEpoch}`;
              appendVerifiedMetadata(db, key, previousAttemptJson);
              return JSON.stringify({ retainedAttemptKey: key, proposalHash });
            })
          : store.claim(jobId, Date.now(), undefined, context);
      const attemptStartedAt = Date.now();
      const startedAt = new Date(attemptStartedAt).toISOString();
      let execution: OperationExecutionContext | undefined;
      try {
        execution = bindOperationWriteFence(
          context,
          {
            lease,
            proposalHash,
            dbPath: prepared.databasePath,
          },
          context.signal.aborted,
        );
        const activeExecution = execution;
        const receiptJson = store.completeAtomically(activeExecution, () => {
          recheckResources();
          const receipt =
            prepared.action.operation === 'knowledge.rollback'
              ? applyRollbackBody(db, prepared, root, store.get(jobId)!.attempts, startedAt)
              : applyProposalBody(
                  db,
                  proposalSchema.parse(prepared),
                  report,
                  root,
                  store.get(jobId)!.attempts,
                  startedAt,
                );
          const eventIds = ['started', 'verified', 'committed'].map(
            (stage) => `${jobId}:${lease.epoch}:${stage}`,
          );
          const provenance: KnowledgeRepairExecution = {
            rollback: prepared.rollback,
            identity: prepared.identity,
            jobId,
            ownerId: lease.ownerId,
            fencingEpoch: lease.epoch,
            proposalHash,
            generation: assessment?.generation ?? null,
            resources: prepared.resources.map((resource) => ({
              ...resource,
              afterHash: resourceHash(db, resource, root),
            })),
            eventIds,
          };
          if (
            provenance.resources.some(
              (resource) =>
                resource.role === 'source' && resource.beforeHash !== resource.afterHash,
            )
          )
            throw new KnowledgeRepairError(
              'E_REPAIR_STALE',
              'Cited evidence changed during mutation.',
            );
          receipt.execution = provenance;
          const stored = readReceipt(db, prepared.id);
          if (!stored)
            throw new KnowledgeRepairError(
              'E_REPAIR_VERIFY',
              'Repair receipt disappeared during verification.',
            );
          writeReceipt(db, storedRepairSchema.parse({ ...stored, receipt }));
          for (const [index, id] of eventIds.entries()) {
            appendVerifiedMetadata(
              db,
              `knowledge_repair_event:${id}`,
              JSON.stringify({
                id,
                jobId,
                receiptId: receipt.id,
                actor: context.identity.actor,
                fencingEpoch: lease.epoch,
                stage: ['started', 'verified', 'committed'][index],
                at: index === 0 ? startedAt : receipt.completedAt,
                proposalHash,
              }),
            );
          }
          for (const resource of provenance.resources)
            if (resourceHash(db, resource, root) !== resource.afterHash)
              throw new KnowledgeRepairError(
                'E_REPAIR_VERIFY',
                'Affected resources changed during receipt persistence.',
              );
          if (prepared.rollback) {
            const originalBytes = db
              .prepare('SELECT value FROM main._nexus_meta WHERE key=?')
              .get(`knowledge_repair:${prepared.rollback.receiptId}`)?.value;
            if (
              typeof originalBytes !== 'string' ||
              hash(originalBytes) !== prepared.rollback.receiptHash
            )
              throw new KnowledgeRepairError(
                'E_REPAIR_VERIFY',
                'Rollback changed the original retained receipt.',
              );
          }
          activeExecution.assertActive();
          return JSON.stringify(receiptSchema.parse(receipt));
        });
        return receiptSchema.parse(JSON.parse(receiptJson));
      } catch (error) {
        const observedAt = new Date().toISOString();
        const errorCode =
          error instanceof KnowledgeRepairError ||
          error instanceof BackgroundJobError ||
          error instanceof OperationExecutionError
            ? error.code
            : 'E_REPAIR_APPLY';
        const reason = error instanceof Error ? error.message : String(error);
        const status = context.signal.aborted ? 'cancelled' : 'failed';
        const attemptId = `${jobId}:${lease.epoch}`;
        const attempt: KnowledgeRepairAttemptOutcome = {
          id: attemptId,
          proposalId: prepared.id,
          proposalHash,
          identity: prepared.identity,
          jobId,
          ownerId: lease.ownerId,
          fencingEpoch: lease.epoch,
          status,
          errorCode,
          reason,
          startedAt,
          observedAt,
          eventIds: [`${attemptId}:started`, `${attemptId}:${status}`],
        };
        const finalization = execution
          ? store.finalizeAtomically(execution, { status, message: reason }, () => {
              const bytes = JSON.stringify(attempt);
              const key = `knowledge_repair_attempt:${attemptId}`;
              appendVerifiedMetadata(db, key, bytes);
              for (const [index, id] of attempt.eventIds.entries()) {
                const eventKey = `knowledge_repair_event:${id}`;
                const eventBytes = JSON.stringify({
                  id,
                  jobId,
                  attemptId,
                  actor: context.identity.actor,
                  fencingEpoch: lease.epoch,
                  stage: index === 0 ? 'started' : status,
                  at: index === 0 ? startedAt : observedAt,
                  proposalHash,
                });
                appendVerifiedMetadata(db, eventKey, eventBytes);
              }
              return bytes;
            })
          : {
              state: 'pending-finalization' as const,
              reason: 'No usable owned fence could be attached after claim.',
              elapsedMs: Date.now() - attemptStartedAt,
              deadlineExceeded: Date.now() >= context.deadlineAt,
            };
        throw new KnowledgeRepairError(errorCode, reason, { attempt, finalization });
      }
    },
  );
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
  const bytes = JSON.stringify(repair);
  const key = `knowledge_repair:${repair.receipt.id}`;
  db.prepare(
    'INSERT INTO main._nexus_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  ).run(key, bytes);
  if (db.prepare('SELECT value FROM main._nexus_meta WHERE key=?').get(key)?.value !== bytes)
    throw new KnowledgeRepairError(
      'E_REPAIR_VERIFY',
      'Repair receipt readback differs from verified bytes.',
    );
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

/** Existing domain preconditions, mutation and verification inside an owned transaction. */
function applyProposalBody(
  db: DatabaseSync,
  proposal: KnowledgeRepairProposal,
  result: KnowledgeDoctorResult,
  projectRoot: string,
  attempt: number,
  startedAt: string,
): KnowledgeRepairReceipt {
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
  return receipt;
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
    const priorAttempt = readReceipt(db, proposal.id)?.receipt.attempt;
    if (priorAttempt !== undefined) attempt = priorAttempt + 1;
    const receipt = applyProposalBody(db, proposal, result, projectRoot, attempt, startedAt);
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
      return !repair.rolledBack &&
        repair.receipt.state === 'repaired' &&
        !db
          .prepare('SELECT 1 FROM main._nexus_meta WHERE key=?')
          .get(`knowledge_rollback:${repair.receipt.id}`)
        ? [repair.receipt]
        : [];
    });
}

/** Restore only proven affected images inside the existing owned job transaction. */
function applyRollbackBody(
  db: DatabaseSync,
  prepared: KnowledgePreparedRepairProposal,
  root: string,
  attempt: number,
  startedAt: string,
): KnowledgeRepairReceipt {
  const original = rollbackSnapshot(db, prepared, root);
  if (
    !prepared.rollback ||
    JSON.stringify(original.reference) !== JSON.stringify(prepared.rollback)
  )
    throw new KnowledgeRepairError(
      'E_REPAIR_STALE',
      'Original recovery snapshot changed after preparation.',
    );
  if (original.stored.quarantine) {
    if (restoreObservationStubs(db, original.stored.quarantine) !== original.affected.length)
      throw new KnowledgeRepairError(
        'E_REPAIR_VERIFY',
        'Rollback did not restore every quarantined record.',
      );
  }
  for (const row of original.stored.decisions)
    db.prepare(
      'UPDATE main.brain_decisions SET invalid_at=?,superseded_by=?,supersedes=?,confirmation_state=? WHERE id=?',
    ).run(row.invalid_at, row.superseded_by, row.supersedes, row.confirmation_state, row.id);
  for (const resource of original.affected)
    if (resourceHash(db, resource, root) !== resource.beforeHash)
      throw new KnowledgeRepairError(
        'E_REPAIR_VERIFY',
        `Restored ${resource.id} differs from its complete original image.`,
      );
  const receipt: KnowledgeRepairReceipt = {
    id: prepared.id,
    proposalId: prepared.id,
    findingId: prepared.findingId,
    projectId: prepared.projectId,
    action: prepared.action,
    state: 'repaired',
    attempt,
    startedAt,
    completedAt: new Date().toISOString(),
    recovery: {
      snapshotId: `knowledge_repair:${original.reference.receiptId}`,
      restoreAction: {
        operation: 'knowledge.rollback',
        arguments: { receiptId: prepared.id },
        prerequisites: [
          'This recovery is already complete. Reapplying authority requires a new sourced repair proposal.',
        ],
      },
    },
    verificationEvidence: original.stored.receipt.verificationEvidence,
    reasons: [
      'Affected resources match their complete original images; original repair evidence remains retained unchanged.',
    ],
  };
  writeReceipt(
    db,
    storedRepairSchema.parse({
      receipt,
      postHash: stateHash(db),
      proposalHash: hash(JSON.stringify(proposalSchema.parse(prepared))),
      rolledBack: false,
      decisions: [],
      quarantine: null,
    }),
  );
  appendVerifiedMetadata(
    db,
    `knowledge_rollback:${original.reference.receiptId}`,
    JSON.stringify({
      receiptId: prepared.id,
      original: original.reference,
      completedAt: receipt.completedAt,
    }),
  );
  return receipt;
}

function rollback(db: DatabaseSync, id: string): KnowledgeRepairReceipt {
  db.exec('BEGIN IMMEDIATE');
  try {
    const stored = readReceipt(db, id);
    if (!stored)
      throw new KnowledgeRepairError('E_REPAIR_NOT_FOUND', `Receipt ${id} was not found.`);
    if (db.prepare('SELECT 1 FROM main._nexus_meta WHERE key=?').get(`knowledge_rollback:${id}`))
      throw new KnowledgeRepairError(
        'E_REPAIR_RECOVERY',
        'Repair already has a separate verified rollback receipt.',
      );
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
