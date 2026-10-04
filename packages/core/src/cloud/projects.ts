import { type RegisterProjectRequest, RegisterProjectResult } from '@cleocode/contracts/cloud';
import type { Http } from './http.js';
import { isSendableWrap } from './keys.js';

/**
 * Register a project, or update its metadata when it is already registered. Organizations own
 * projects (ADR-095): pass `organizationId` to register into one the caller belongs to, or omit it
 * for the caller's personal organization. Re-registering into a different organization is refused
 * with `E_CONFLICT`. The server records no filesystem path. `created` is `true` on 201 (new
 * registration) and `false` on 200 (the id was already registered; its label is updated).
 * `initialKey` stores a new project's first data key in the same call; `initialKeyVersion` says
 * whether it was stored (1) or not (null), and is absent from servers older than it.
 *
 * @throws {Error} Before any request, when `initialKey` holds an empty or padding-only wrap
 *   (Cleo Nexus refuses it with 400; T13101).
 */
export async function registerProject(
  http: Http,
  req: RegisterProjectRequest,
): Promise<RegisterProjectResult & { created: boolean }> {
  if (req.initialKey !== undefined && !isSendableWrap(req.initialKey.wrappedProjectKey)) {
    throw new Error('refusing to register a project with an empty initialKey wrap');
  }
  const { data, status } = await http.requestWithStatus(
    'POST',
    '/v1/projects',
    RegisterProjectResult,
    req,
  );
  return { ...data, created: status === 201 };
}
