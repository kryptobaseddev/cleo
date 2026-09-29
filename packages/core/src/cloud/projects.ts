import {
  type Project,
  type RegisterProjectRequest,
  RegisterProjectResult,
  type StreamId,
} from '@cleocode/contracts/cloud';
import type { Http } from './http.js';

/**
 * Register a project, or update its metadata when it is already registered. Organizations own
 * projects (ADR-095): pass `organizationId` to register into one the caller belongs to, or omit it
 * for the caller's personal organization. Re-registering into a different organization is refused
 * with `E_CONFLICT`. The server records no filesystem path. `created` is `true` on 201 (new
 * registration) and `false` on 200 (the id was already registered; its label is updated).
 */
export async function registerProject(
  http: Http,
  req: RegisterProjectRequest,
): Promise<{ project: Project; streamId: StreamId; created: boolean }> {
  const { data, status } = await http.requestWithStatus(
    'POST',
    '/v1/projects',
    RegisterProjectResult,
    req,
  );
  return { ...data, created: status === 201 };
}
