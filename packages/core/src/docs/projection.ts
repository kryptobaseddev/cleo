/** Captured, durable preparation of optional projections after canonical docs storage. */
import { createHash, randomUUID } from 'node:crypto';
import type { OperationExecutionContext } from '@cleocode/contracts/jobs';
import {
  DOCS_PROJECTION_PROPOSAL_SCHEMA,
  DOCS_PROJECTION_RECEIPT_SCHEMA,
  type DocsProjectionOutcome,
  type DocsProjectionPreparation,
  type DocsProjectionProposal,
  type DocsProjectionReceipt,
  type DocsProjectionSource,
} from '@cleocode/contracts/operations/docs';
import { enqueueBrainWrite } from '../memory/brain-writer-thread.js';
import { ensureLlmtxtNodeScoped } from '../memory/graph-auto-populate.js';
import { worktreeScope } from '../paths.js';
import { createAttachmentStore } from '../store/attachment-store.js';
import { assertOperationWriteFence, DurableJobStore } from '../store/background-jobs.js';
import {
  bindOperationWriteFence,
  observeOperation,
  trackBackgroundOp,
} from '../store/background-ops.js';
import { resolveDualScopeDbPath } from '../store/dual-scope-db.js';
import { getBrainAccessor } from '../store/memory-accessor.js';
import { getDb } from '../store/sqlite.js';

/** Load actual canonical evidence without changing it or admitting an executor. */
async function readProjectionProposal(
  context: OperationExecutionContext,
  captured: DocsProjectionSource,
): Promise<DocsProjectionProposal> {
  const root = context.identity.projectRoot;
  const attachments = createAttachmentStore();
  context.assertActive();
  const owners = await attachments.listByOwner(captured.ownerType, captured.ownerId, root);
  context.assertActive();
  const metadata = owners.find((entry) => entry.id === captured.attachmentId);
  if (!metadata || metadata.sha256 !== captured.sha256) {
    throw new Error('Document projection source or owner no longer matches canonical evidence');
  }
  if ('size' in metadata.attachment) context.consume({ bytes: metadata.attachment.size });
  const stored = await attachments.get(captured.sha256, root);
  context.assertActive();
  if (!stored || stored.metadata.id !== captured.attachmentId) {
    throw new Error('Document projection canonical bytes are unavailable');
  }
  if (createHash('sha256').update(stored.bytes).digest('hex') !== captured.sha256) {
    throw new Error('Document projection canonical bytes fail SHA-256 verification');
  }
  const extras = await attachments.getExtras(captured.attachmentId, root);
  context.assertActive();
  const proposal: DocsProjectionProposal = {
    version: 1,
    operation: 'docs.projection',
    identity: context.identity,
    source: captured,
    observation: {
      kind: 'doc-attachment',
      attachmentId: metadata.id,
      ownerId: captured.ownerId,
      addedAt: metadata.createdAt,
      ...(extras?.slug ? { slug: extras.slug } : {}),
      ...(extras?.type ? { type: extras.type } : {}),
    },
  };
  return proposal;
}

/**
 * Persist authentic optional work before an executor can be scheduled.
 *
 * @param context - Captured project, actor, retry identity and shared deadline.
 * @param source - Canonical attachment and owner to independently verify.
 * @returns Durable pending or coalesced job identity, never projection completion.
 * @throws Error - Missing/changed canonical evidence, cancellation, storage or retry conflict.
 * @remarks Canonical bytes are only read. The existing job store owns the atomic
 * proposal insertion and immutable retry check. No executor, embedding or model
 * starts here. An admitted synchronous store call cannot be timer-preempted;
 * committed preparation is returned with its actual deadline observation.
 * @example
 * ```ts
 * const pending = await prepareDocumentProjection(context, source);
 * // Inspect pending.jobId before explicitly resuming this domain operation.
 * ```
 */
export async function prepareDocumentProjection(
  context: OperationExecutionContext,
  source: DocsProjectionSource,
): Promise<DocsProjectionPreparation> {
  context.assertActive();
  if (context.identity.operation !== 'docs.projection') {
    throw new Error('Document projection requires its captured docs.projection operation');
  }
  const captured = Object.freeze({ ...source });
  if (!/^[a-f0-9]{64}$/.test(captured.sha256)) {
    throw new Error('Document projection requires a canonical SHA-256');
  }
  return worktreeScope.run(
    {
      worktreeRoot: context.identity.projectRoot,
      projectHash: context.identity.projectId,
      execution: context,
    },
    async () => {
      const root = context.identity.projectRoot;
      const proposal = await readProjectionProposal(context, captured);
      const proposalJson = JSON.stringify(DOCS_PROJECTION_PROPOSAL_SCHEMA.parse(proposal));
      context.consume({ bytes: Buffer.byteLength(proposalJson, 'utf8'), items: 1 });
      const db = await getDb(root);
      context.assertActive();
      const store = new DurableJobStore(db, {
        projectId: context.identity.projectId,
        actor: context.identity.actor,
      });
      const job = store.defer(randomUUID(), proposal.operation, Date.now(), {
        projectId: context.identity.projectId,
        idempotencyKey: context.identity.idempotencyKey,
        proposalJson,
      });
      return {
        jobId: job.id,
        proposalHash: createHash('sha256').update(proposalJson).digest('hex'),
        projectId: context.identity.projectId,
        projectRoot: root,
        jobStatus: job.status,
        deadlineAt: context.deadlineAt,
        deadlineExceeded: Date.now() >= context.deadlineAt,
      };
    },
  );
}

/** Verify actual domain records after writes or when inspecting a completed operation. */
async function verifyProjection(
  context: OperationExecutionContext,
  proposal: DocsProjectionProposal,
  receipt: DocsProjectionReceipt,
): Promise<void> {
  context.assertActive();
  const accessor = await getBrainAccessor(context.identity.projectRoot);
  context.assertActive();
  const observation = await accessor.getObservation(receipt.observationId);
  context.assertActive();
  if (
    !observation ||
    observation.narrative !== JSON.stringify(proposal.observation) ||
    observation.project !== context.identity.projectId ||
    observation.invalidAt !== null ||
    observation.expiredAt !== null ||
    receipt.sourceHash !== proposal.source.sha256
  ) {
    throw new Error('Document observation verification failed');
  }
  if (receipt.graph === 'completed') {
    const nodeId = `llmtxt:${proposal.source.sha256}`;
    const node = await accessor.getPageNode(nodeId);
    context.assertActive();
    const edges = await accessor.getPageEdges(nodeId, 'in');
    context.assertActive();
    if (
      !node ||
      node.nodeType !== 'llmtxt' ||
      node.label !== proposal.source.label ||
      !edges.some(
        (edge) =>
          edge.fromId === `${proposal.source.ownerType}:${proposal.source.ownerId}` &&
          edge.edgeType === 'embeds' &&
          edge.provenance === 'auto:docs-add',
      )
    ) {
      throw new Error('Document graph verification failed');
    }
  }
}

/**
 * Execute only the authentic supported document proposal using its original foreground scope.
 * @param context - Captured routing and shared lifetime; a resume may use a new caller lifetime.
 * @param jobId - Existing durable pending or explicitly expired job identity.
 * @returns Actual verified domain result after the existing job store records completion.
 * @throws Error on stale inputs, ownership, cancellation, unavailable workers or verification failure.
 * @remarks Graph and observation writes commit separately. Lost acknowledgements leave the
 * job inspectable and require explicit resume after expiry; observation replay is idempotent.
 * No uncertain worker write is replayed inline and no model is used. The receipt is not an
 * atomic cross-database repair guarantee. Synchronous SQLite is cooperatively guarded only.
 * @example
 * ```ts
 * const receipt = await resumeDocumentProjection(capturedContext, pending.jobId);
 * ```
 */
export async function resumeDocumentProjection(
  context: OperationExecutionContext,
  jobId: string,
): Promise<DocsProjectionReceipt> {
  context.assertActive();
  return worktreeScope.run(
    {
      worktreeRoot: context.identity.projectRoot,
      projectHash: context.identity.projectId,
      execution: context,
    },
    async () => {
      const db = await getDb(context.identity.projectRoot);
      context.assertActive();
      const store = new DurableJobStore(db, {
        projectId: context.identity.projectId,
        actor: context.identity.actor,
      });
      const job = store.get(jobId);
      if (
        !job?.proposalJson ||
        !job.proposalHash ||
        job.operation !== 'docs.projection' ||
        createHash('sha256').update(job.proposalJson).digest('hex') !== job.proposalHash
      ) {
        throw new Error('Document projection requires authentic persisted proposal bytes');
      }
      const proposal = DOCS_PROJECTION_PROPOSAL_SCHEMA.parse(JSON.parse(job.proposalJson));
      if (
        proposal.identity.projectId !== context.identity.projectId ||
        proposal.identity.projectRoot !== context.identity.projectRoot ||
        context.identity.operation !== proposal.operation ||
        proposal.identity.idempotencyKey !== context.identity.idempotencyKey
      ) {
        throw new Error('Document projection scope differs from the immutable proposal');
      }
      const actual = await readProjectionProposal(context, proposal.source);
      if (JSON.stringify(actual.observation) !== JSON.stringify(proposal.observation)) {
        throw new Error('Document projection source metadata changed after preparation');
      }
      if (job.status === 'complete') {
        const receipt = DOCS_PROJECTION_RECEIPT_SCHEMA.parse(job.result);
        await verifyProjection(context, proposal, receipt);
        return receipt;
      }
      context.assertActive();
      const lease = store.claim(job.id, Date.now());
      const execution = bindOperationWriteFence(context, {
        dbPath: resolveDualScopeDbPath('project', context.identity.projectRoot),
        proposalHash: job.proposalHash,
        lease,
      });
      return worktreeScope.run(
        {
          worktreeRoot: context.identity.projectRoot,
          projectHash: context.identity.projectId,
          execution,
        },
        async () => {
          execution.assertActive();
          store.checkpoint(
            job.id,
            JSON.stringify({ stage: 'graph', sourceHash: proposal.source.sha256 }),
            Date.now(),
          );
          const graph = await ensureLlmtxtNodeScoped(
            execution,
            proposal.source.sha256,
            `${proposal.source.ownerType}:${proposal.source.ownerId}`,
            proposal.source.label,
          );
          execution.assertActive();
          store.checkpoint(
            job.id,
            JSON.stringify({ stage: 'observation', graph: graph.status }),
            Date.now(),
          );
          const observation = await enqueueBrainWrite(
            {
              kind: 'observe',
              projectRoot: context.identity.projectRoot,
              params: {
                text: JSON.stringify(proposal.observation),
                title: `Doc attached: ${proposal.observation.slug ?? proposal.source.attachmentId}`,
                type: 'feature',
                sourceType: 'agent',
                sourceConfidence: 'agent',
                agent: proposal.identity.actor,
                project: proposal.identity.projectId,
                attachmentRefs: [proposal.source.sha256],
                origin: 'docs.projection',
                _skipGate: true,
              },
            },
            execution,
          );
          if (observation.kind !== 'observe')
            throw new Error('Document writer returned an unrelated result');
          const receipt: DocsProjectionReceipt = {
            version: 1,
            sourceHash: proposal.source.sha256,
            graph: graph.status,
            observationId: observation.result.id,
            verifiedAt: new Date().toISOString(),
            actor: context.identity.actor,
          };
          await verifyProjection(execution, proposal, receipt);
          const finalSource = await readProjectionProposal(execution, proposal.source);
          if (JSON.stringify(finalSource.observation) !== JSON.stringify(proposal.observation)) {
            throw new Error('Document source changed before completion');
          }
          execution.assertActive();
          // Finalization uses the existing store transaction. The earlier domain commits
          // remain separately inspectable if ownership/cancellation blocks finalization.
          assertOperationWriteFence(db, execution);
          store.complete(job.id, receipt, Date.now());
          return receipt;
        },
      );
    },
  );
}

/**
 * Prepare authentic optional work and observe its execution within one shared budget.
 * @param context - Context captured before canonical attachment storage or other awaits.
 * @param source - The accepted canonical attachment, preserved on every optional failure.
 * @returns Explicit completion, durable pending identity, or a diagnostic with missing preparation.
 * @remarks A timeout ends observation, not arbitrary work. The hardcoded domain executor
 * guards later handles and writes; teardown cancellation reaches its worker. No model starts.
 * @example
 * ```ts
 * const projection = await projectDocumentAttachment(context, acceptedSource);
 * ```
 */
export async function projectDocumentAttachment(
  context: OperationExecutionContext,
  source: DocsProjectionSource,
): Promise<DocsProjectionOutcome> {
  let prepared: DocsProjectionPreparation | undefined;
  const work = (async () => {
    prepared = await prepareDocumentProjection(context, source);
    context.assertActive();
    return resumeDocumentProjection(context, prepared.jobId);
  })();
  trackBackgroundOp(work);
  const observed = await observeOperation(context, work);
  const base = {
    projectId: context.identity.projectId,
    projectRoot: context.identity.projectRoot,
    deadlineAt: context.deadlineAt,
    deadlineExceeded: observed.deadlineExceeded,
    ...(prepared
      ? {
          jobId: prepared.jobId,
        }
      : {}),
  };
  if (observed.settled && observed.success)
    return {
      ...base,
      status: 'completed',
      coverage: 'current',
      receipt: observed.value,
      diagnostics: [],
    };
  const diagnostics: string[] = [];
  if (observed.settled) {
    // Preserve nested SQLite diagnostics without allowing cyclic causes to loop.
    let error: Error | undefined = observed.error;
    for (let depth = 0; error && depth < 16; depth++) {
      diagnostics.push(error.message);
      error = error.cause instanceof Error ? error.cause : undefined;
    }
  } else {
    diagnostics.push(
      `Foreground observation ended (${observed.reason}); underlying outcome remains unresolved`,
    );
  }
  if (!prepared)
    diagnostics.push(
      'No durable pending identity was observed; inspect the accepted attachment before retrying',
    );
  return {
    ...base,
    status: observed.settled ? 'failed' : 'pending',
    coverage: prepared ? (observed.settled ? 'failed' : 'partial') : 'missing',
    diagnostics,
  };
}
