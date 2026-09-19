/** Captured, durable preparation of optional projections after canonical docs storage. */
import { createHash, randomUUID } from 'node:crypto';
import type { OperationExecutionContext } from '@cleocode/contracts/jobs';
import type {
  DocsProjectionPreparation,
  DocsProjectionProposal,
  DocsProjectionSource,
} from '@cleocode/contracts/operations/docs';
import { worktreeScope } from '../paths.js';
import { createAttachmentStore } from '../store/attachment-store.js';
import { DurableJobStore } from '../store/background-jobs.js';
import { getDb } from '../store/sqlite.js';

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
      const proposalJson = JSON.stringify(proposal);
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
