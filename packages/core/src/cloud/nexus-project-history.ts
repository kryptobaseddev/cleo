/**
 * Ask Cleo Nexus, read-only, whether it holds ANY history of a project: a
 * checkpoint or a journal segment from any device (T13231). `cleo doctor
 * row-identity --refill` needs this answer before re-deriving the row identity
 * of a Nexus-linked store: a uid in the cloud must never be rewritten locally.
 *
 * Every linked origin is asked with this machine's device credential. Nothing
 * is written, locally or remotely: no lease, no key minting, no replica bind.
 *
 * @task T13231
 * @module cloud/nexus-project-history
 */

import type { NexusProjectLink, RowIdentityNexusAnswer } from '@cleocode/contracts';
import { ListCheckpointsResult } from '@cleocode/contracts/cloud';
import { nexusStreamHeadSchema } from '@cleocode/contracts/nexus-vault.js';
import { NexusError, type ResponseSchema } from './http.js';
import { readNexusProjectLinks } from './nexus-link.js';
import { connectNexusVault, type NexusVaultOptions } from './nexus-vault-keys.js';
import { projectStream } from './streams.js';

/**
 * The read-only slice of a vault connection the probe needs: a request whose
 * failure stays a raw {@link NexusError}, so the probe can tell the server's
 * "stream not found" from every other 404.
 */
export interface NexusStreamReader {
  raw<T>(method: string, path: string, schema: ResponseSchema<T>): Promise<T>;
}

/**
 * The cleo-nexus answer for a project the caller can see whose stream was
 * never created (`requireStreamAccess`: `notFound('stream')`, after project
 * access passed). A non-member gets `project not found`, and an unknown route
 * a bare 404; neither proves the cloud holds nothing.
 */
const STREAM_NEVER_CREATED = 'stream not found';

/** Whether a failure is exactly the server's "this project's stream does not exist". */
function streamNeverCreated(err: unknown): boolean {
  return (
    err instanceof NexusError &&
    err.status === 404 &&
    err.code === 'E_NOT_FOUND' &&
    err.serverMessage === STREAM_NEVER_CREATED
  );
}

/** Opens a reader for one origin; defaults to {@link connectNexusVault}. */
export type NexusStreamReaderFactory = (apiUrl: string) => Promise<NexusStreamReader>;

/**
 * What one stream holds: its head and its checkpoint count. Only two answers
 * count as "nothing": a stream that exists with no checkpoint and head 0, and
 * the server's explicit "stream not found" for a project the caller can see.
 * Every other failure, including any other 404, is thrown (the caller treats
 * it as unknown).
 *
 * @param reader - An authenticated reader.
 * @param streamId - The project's stream.
 * @returns Checkpoint count and head sequence.
 * @task T13231
 */
export async function nexusStreamHistory(
  reader: NexusStreamReader,
  streamId: string,
): Promise<{ checkpoints: number; headSeq: number }> {
  const base = `/v1/streams/${encodeURIComponent(streamId)}`;
  let head: { headSeq: number; headCheckpointId: string | null };
  try {
    head = await reader.raw('GET', base, nexusStreamHeadSchema);
  } catch (err) {
    if (streamNeverCreated(err)) return { checkpoints: 0, headSeq: 0 };
    throw err;
  }
  const list = await reader.raw('GET', `${base}/checkpoints`, ListCheckpointsResult);
  const checkpoints = Math.max(list.checkpoints.length, head.headCheckpointId ? 1 : 0);
  return { checkpoints, headSeq: head.headSeq };
}

/** Ask one origin; any failure is an `error` answer, never "none". */
async function askOrigin(
  link: NexusProjectLink,
  open: NexusStreamReaderFactory,
): Promise<RowIdentityNexusAnswer> {
  const streamId = link.streamId || projectStream(link.remoteProjectId);
  const base = { apiUrl: link.apiUrl, remoteProjectId: link.remoteProjectId, streamId };
  try {
    const history = await nexusStreamHistory(await open(link.apiUrl), streamId);
    const present = history.checkpoints > 0 || history.headSeq > 0;
    return { ...base, answer: present ? 'present' : 'none', ...history };
  } catch (err) {
    return {
      ...base,
      answer: 'error',
      checkpoints: 0,
      headSeq: 0,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Ask every origin the project is linked to whether it holds a checkpoint or
 * a journal segment of the project, from any device.
 *
 * @param projectRoot - Project root (its `nexus-link.json` names the origins).
 * @param options - Connection options, or a reader factory (tests).
 * @returns One answer per linked origin; an unreadable link entry is an `error` answer.
 * @task T13231
 */
export async function askNexusProjectHistory(
  projectRoot: string,
  options: NexusVaultOptions & { readerFor?: NexusStreamReaderFactory } = {},
): Promise<RowIdentityNexusAnswer[]> {
  const { readerFor, ...connectOptions } = options;
  const open: NexusStreamReaderFactory =
    readerFor ?? ((apiUrl) => connectNexusVault({ ...connectOptions, apiUrl }));
  const { links, unreadable } = readNexusProjectLinks(projectRoot);
  const answers: RowIdentityNexusAnswer[] = [];
  for (const link of links) answers.push(await askOrigin(link, open));
  for (const origin of unreadable) {
    answers.push({
      apiUrl: origin,
      remoteProjectId: '',
      streamId: '',
      answer: 'error',
      checkpoints: 0,
      headSeq: 0,
      error: 'this version cannot read the link entry',
    });
  }
  return answers;
}
