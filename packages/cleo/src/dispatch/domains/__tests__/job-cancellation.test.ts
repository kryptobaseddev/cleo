/** Real manager/admin cancellation contract; no mocked preflight or executor outcomes. */
import { BackgroundJobManager, setJobManager } from '@cleocode/runtime/gateway';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createTestDb,
  type TestDbEnv,
} from '../../../../../core/src/store/__tests__/test-db-helper.js';
import { getDb } from '../../../../../core/src/store/sqlite.js';
import { AdminHandler } from '../admin.js';

let env: TestDbEnv;
let manager: BackgroundJobManager;
const handler = new AdminHandler();
beforeEach(async () => {
  env = await createTestDb();
  manager = new BackgroundJobManager(await getDb(env.tempDir));
  setJobManager(manager);
});
afterEach(async () => {
  manager.destroy();
  setJobManager(null);
  await env.cleanup();
});

describe('admin job cancellation truth', () => {
  it('reports requested cancellation while work runs and preserves a committed result', async () => {
    const work = Promise.withResolvers<{ committed: boolean }>();
    const id = await manager.startJob('repair', () => work.promise);
    try {
      const response = await handler.mutate('job.cancel', { jobId: id });
      expect(response).toMatchObject({
        success: true,
        data: {
          jobId: id,
          cancellationRequested: true,
          cancelled: false,
          status: 'running',
        },
      });
    } finally {
      work.resolve({ committed: true });
      await expect.poll(() => manager.getJob(id)?.status).toBe('complete');
    }
    expect(manager.getJob(id)?.result).toEqual({ committed: true });
    expect(await handler.mutate('job.cancel', { jobId: id })).toMatchObject({
      success: true,
      data: { jobId: id, cancellationRequested: false, cancelled: false, status: 'complete' },
    });
  });

  it('reports terminal cancellation only after executor acknowledgement', async () => {
    const work = Promise.withResolvers<never>();
    const id = await manager.startJob('repair', ({ signal }) => {
      signal.addEventListener(
        'abort',
        () => work.reject(new DOMException('cancelled', 'AbortError')),
        { once: true },
      );
      return work.promise;
    });
    await handler.mutate('job.cancel', { jobId: id });
    await expect.poll(() => manager.getJob(id)?.status).toBe('cancelled');
    expect(await handler.mutate('job.cancel', { jobId: id })).toMatchObject({
      success: true,
      data: { jobId: id, cancellationRequested: false, cancelled: true, status: 'cancelled' },
    });
  });

  it('distinguishes missing work from an unregistered stopped host', async () => {
    expect(await handler.mutate('job.cancel', { jobId: 'missing' })).toMatchObject({
      success: false,
      error: { code: 'E_NOT_FOUND' },
    });
    manager.destroy();
    setJobManager(null);
    expect(await handler.mutate('job.cancel', { jobId: 'missing' })).toMatchObject({
      success: false,
      error: { code: 'E_NOT_AVAILABLE' },
    });
    expect(await handler.query('job', { jobId: 'missing' })).toMatchObject({
      success: false,
      error: { code: 'E_NOT_AVAILABLE' },
    });
  });
});
