import type { StreamId } from '@cleocode/contracts/cloud';

/** Journal stream for a project's portable·project ops. */
export const projectStream = (projectId: string): StreamId => `project:${projectId}`;

/** Journal stream for one account's portable·personal ops (home journal). */
export const homeStream = (userId: string): StreamId => `home:${userId}`;
