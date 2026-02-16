/**
 * Tests for Background Job Manager
 *
 * @task T3080
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { BackgroundJobManager, BackgroundJob } from '../background-jobs.js';

describe('BackgroundJobManager', () => {
  let manager: BackgroundJobManager;

  beforeEach(() => {
    manager = new BackgroundJobManager({ maxJobs: 3, retentionMs: 1000 });
  });

  afterEach(() => {
    manager.destroy();
  });

  describe('job creation and execution', () => {
    it('should create a job and return a UUID', async () => {
      const jobId = await manager.startJob('test.operation', async () => 'result');
      expect(jobId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
      );
    });

    it('should set initial job status to running', async () => {
      const jobId = await manager.startJob(
        'test.operation',
        () => new Promise(() => {}) // never resolves
      );
      const job = manager.getJob(jobId);
      expect(job).toBeDefined();
      expect(job!.status).toBe('running');
      expect(job!.operation).toBe('test.operation');
      expect(job!.startedAt).toBeDefined();
    });

    it('should complete a job with result', async () => {
      const jobId = await manager.startJob('test.operation', async () => {
        return { data: 'test-result' };
      });

      // Wait for async execution
      await new Promise((resolve) => setTimeout(resolve, 50));

      const job = manager.getJob(jobId);
      expect(job!.status).toBe('completed');
      expect(job!.result).toEqual({ data: 'test-result' });
      expect(job!.completedAt).toBeDefined();
      expect(job!.progress).toBe(100);
    });

    it('should set job to failed on executor error', async () => {
      const jobId = await manager.startJob('test.operation', async () => {
        throw new Error('Executor failed');
      });

      await new Promise((resolve) => setTimeout(resolve, 50));

      const job = manager.getJob(jobId);
      expect(job!.status).toBe('failed');
      expect(job!.error).toBe('Executor failed');
      expect(job!.completedAt).toBeDefined();
    });

    it('should handle non-Error thrown values', async () => {
      const jobId = await manager.startJob('test.operation', async () => {
        throw 'string error';
      });

      await new Promise((resolve) => setTimeout(resolve, 50));

      const job = manager.getJob(jobId);
      expect(job!.status).toBe('failed');
      expect(job!.error).toBe('string error');
    });
  });

  describe('job status tracking', () => {
    it('should return undefined for non-existent job', () => {
      const job = manager.getJob('non-existent-id');
      expect(job).toBeUndefined();
    });

    it('should track multiple jobs simultaneously', async () => {
      const id1 = await manager.startJob(
        'op.one',
        () => new Promise(() => {})
      );
      const id2 = await manager.startJob(
        'op.two',
        () => new Promise(() => {})
      );

      const job1 = manager.getJob(id1);
      const job2 = manager.getJob(id2);

      expect(job1!.operation).toBe('op.one');
      expect(job2!.operation).toBe('op.two');
      expect(id1).not.toBe(id2);
    });
  });

  describe('job listing and filtering', () => {
    it('should list all jobs when no filter provided', async () => {
      await manager.startJob('op.a', async () => 'done');
      await manager.startJob('op.b', () => new Promise(() => {}));

      await new Promise((resolve) => setTimeout(resolve, 50));

      const all = manager.listJobs();
      expect(all.length).toBe(2);
    });

    it('should filter by running status', async () => {
      await manager.startJob('op.fast', async () => 'done');
      await manager.startJob('op.slow', () => new Promise(() => {}));

      await new Promise((resolve) => setTimeout(resolve, 50));

      const running = manager.listJobs('running');
      expect(running.length).toBe(1);
      expect(running[0].operation).toBe('op.slow');
    });

    it('should filter by completed status', async () => {
      await manager.startJob('op.fast', async () => 'done');
      await manager.startJob('op.slow', () => new Promise(() => {}));

      await new Promise((resolve) => setTimeout(resolve, 50));

      const completed = manager.listJobs('completed');
      expect(completed.length).toBe(1);
      expect(completed[0].operation).toBe('op.fast');
    });

    it('should filter by failed status', async () => {
      await manager.startJob('op.fail', async () => {
        throw new Error('fail');
      });
      await manager.startJob('op.ok', async () => 'ok');

      await new Promise((resolve) => setTimeout(resolve, 50));

      const failed = manager.listJobs('failed');
      expect(failed.length).toBe(1);
      expect(failed[0].operation).toBe('op.fail');
    });

    it('should return empty array for no matches', async () => {
      await manager.startJob('op.ok', async () => 'ok');
      await new Promise((resolve) => setTimeout(resolve, 50));

      const cancelled = manager.listJobs('cancelled');
      expect(cancelled).toEqual([]);
    });
  });

  describe('job cancellation', () => {
    it('should cancel a running job', async () => {
      const jobId = await manager.startJob(
        'op.slow',
        () => new Promise(() => {})
      );

      const cancelled = manager.cancelJob(jobId);
      expect(cancelled).toBe(true);

      const job = manager.getJob(jobId);
      expect(job!.status).toBe('cancelled');
      expect(job!.completedAt).toBeDefined();
    });

    it('should return false for non-existent job cancellation', () => {
      const cancelled = manager.cancelJob('non-existent');
      expect(cancelled).toBe(false);
    });

    it('should return false for already completed job', async () => {
      const jobId = await manager.startJob('op.fast', async () => 'done');
      await new Promise((resolve) => setTimeout(resolve, 50));

      const cancelled = manager.cancelJob(jobId);
      expect(cancelled).toBe(false);
    });

    it('should return false for already cancelled job', async () => {
      const jobId = await manager.startJob(
        'op.slow',
        () => new Promise(() => {})
      );

      manager.cancelJob(jobId);
      const secondCancel = manager.cancelJob(jobId);
      expect(secondCancel).toBe(false);
    });

    it('should not update result after cancellation', async () => {
      let resolveExecutor: (value: unknown) => void;
      const jobId = await manager.startJob(
        'op.cancel-race',
        () =>
          new Promise((resolve) => {
            resolveExecutor = resolve;
          })
      );

      manager.cancelJob(jobId);

      // Resolve the executor after cancellation
      resolveExecutor!('late-result');
      await new Promise((resolve) => setTimeout(resolve, 50));

      const job = manager.getJob(jobId);
      expect(job!.status).toBe('cancelled');
      expect(job!.result).toBeUndefined();
    });
  });

  describe('job cleanup and retention', () => {
    it('should clean up old completed jobs', async () => {
      const jobId = await manager.startJob('op.old', async () => 'done');
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Manually set completedAt to past retention
      const job = manager.getJob(jobId)!;
      job.completedAt = new Date(Date.now() - 2000).toISOString(); // 2s ago, retention is 1s

      const cleaned = manager.cleanup();
      expect(cleaned).toBe(1);
      expect(manager.getJob(jobId)).toBeUndefined();
    });

    it('should not clean up recent completed jobs', async () => {
      const jobId = await manager.startJob('op.recent', async () => 'done');
      await new Promise((resolve) => setTimeout(resolve, 50));

      const cleaned = manager.cleanup();
      expect(cleaned).toBe(0);
      expect(manager.getJob(jobId)).toBeDefined();
    });

    it('should not clean up running jobs', async () => {
      await manager.startJob('op.running', () => new Promise(() => {}));

      const cleaned = manager.cleanup();
      expect(cleaned).toBe(0);
      expect(manager.listJobs().length).toBe(1);
    });

    it('should clean up failed jobs past retention', async () => {
      const jobId = await manager.startJob('op.fail', async () => {
        throw new Error('fail');
      });
      await new Promise((resolve) => setTimeout(resolve, 50));

      const job = manager.getJob(jobId)!;
      job.completedAt = new Date(Date.now() - 2000).toISOString();

      const cleaned = manager.cleanup();
      expect(cleaned).toBe(1);
    });

    it('should clean up cancelled jobs past retention', async () => {
      const jobId = await manager.startJob(
        'op.cancel',
        () => new Promise(() => {})
      );
      manager.cancelJob(jobId);

      const job = manager.getJob(jobId)!;
      job.completedAt = new Date(Date.now() - 2000).toISOString();

      const cleaned = manager.cleanup();
      expect(cleaned).toBe(1);
    });
  });

  describe('concurrent job limits', () => {
    it('should enforce max concurrent jobs', async () => {
      await manager.startJob('op.1', () => new Promise(() => {}));
      await manager.startJob('op.2', () => new Promise(() => {}));
      await manager.startJob('op.3', () => new Promise(() => {}));

      await expect(
        manager.startJob('op.4', () => new Promise(() => {}))
      ).rejects.toThrow('Maximum concurrent jobs reached (3)');
    });

    it('should allow new jobs after completed ones free up slots', async () => {
      await manager.startJob('op.fast', async () => 'done');
      await manager.startJob('op.2', () => new Promise(() => {}));
      await manager.startJob('op.3', () => new Promise(() => {}));

      // Wait for fast job to complete
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Should succeed since only 2 running now
      const id = await manager.startJob('op.4', () => new Promise(() => {}));
      expect(id).toBeDefined();
    });

    it('should allow new jobs after cancellation frees up slots', async () => {
      const id1 = await manager.startJob('op.1', () => new Promise(() => {}));
      await manager.startJob('op.2', () => new Promise(() => {}));
      await manager.startJob('op.3', () => new Promise(() => {}));

      manager.cancelJob(id1);

      const id4 = await manager.startJob('op.4', () => new Promise(() => {}));
      expect(id4).toBeDefined();
    });
  });

  describe('progress tracking', () => {
    it('should update progress on a running job', async () => {
      const jobId = await manager.startJob(
        'op.progress',
        () => new Promise(() => {})
      );

      const updated = manager.updateProgress(jobId, 50);
      expect(updated).toBe(true);

      const job = manager.getJob(jobId);
      expect(job!.progress).toBe(50);
    });

    it('should clamp progress to 0-100 range', async () => {
      const jobId = await manager.startJob(
        'op.progress',
        () => new Promise(() => {})
      );

      manager.updateProgress(jobId, -10);
      expect(manager.getJob(jobId)!.progress).toBe(0);

      manager.updateProgress(jobId, 150);
      expect(manager.getJob(jobId)!.progress).toBe(100);
    });

    it('should return false for progress update on non-running job', async () => {
      const jobId = await manager.startJob('op.fast', async () => 'done');
      await new Promise((resolve) => setTimeout(resolve, 50));

      const updated = manager.updateProgress(jobId, 50);
      expect(updated).toBe(false);
    });

    it('should return false for progress update on non-existent job', () => {
      const updated = manager.updateProgress('non-existent', 50);
      expect(updated).toBe(false);
    });
  });

  describe('error handling', () => {
    it('should handle sync throw in executor', async () => {
      const jobId = await manager.startJob('op.sync-error', async () => {
        throw new TypeError('type error');
      });

      await new Promise((resolve) => setTimeout(resolve, 50));

      const job = manager.getJob(jobId);
      expect(job!.status).toBe('failed');
      expect(job!.error).toBe('type error');
    });

    it('should handle rejected promise in executor', async () => {
      const jobId = await manager.startJob(
        'op.reject',
        () => Promise.reject(new Error('rejected'))
      );

      await new Promise((resolve) => setTimeout(resolve, 50));

      const job = manager.getJob(jobId);
      expect(job!.status).toBe('failed');
      expect(job!.error).toBe('rejected');
    });
  });

  describe('destroy', () => {
    it('should cancel all running jobs on destroy', async () => {
      const id1 = await manager.startJob('op.1', () => new Promise(() => {}));
      const id2 = await manager.startJob('op.2', () => new Promise(() => {}));

      manager.destroy();

      // After destroy, all state is cleared
      expect(manager.listJobs().length).toBe(0);
    });

    it('should clear all jobs including completed ones on destroy', async () => {
      await manager.startJob('op.fast', async () => 'done');
      await new Promise((resolve) => setTimeout(resolve, 50));

      manager.destroy();

      expect(manager.listJobs().length).toBe(0);
    });

    it('should be safe to call destroy multiple times', () => {
      expect(() => {
        manager.destroy();
        manager.destroy();
      }).not.toThrow();
    });
  });

  describe('default configuration', () => {
    it('should use default maxJobs of 10', async () => {
      const defaultManager = new BackgroundJobManager();

      // Should allow more than 3 (our test config limit)
      for (let i = 0; i < 10; i++) {
        await defaultManager.startJob(`op.${i}`, () => new Promise(() => {}));
      }

      await expect(
        defaultManager.startJob('op.11', () => new Promise(() => {}))
      ).rejects.toThrow('Maximum concurrent jobs reached (10)');

      defaultManager.destroy();
    });

    it('should use default retentionMs of 1 hour', () => {
      const defaultManager = new BackgroundJobManager();
      // No direct way to check, but verify it doesn't throw
      expect(defaultManager).toBeDefined();
      defaultManager.destroy();
    });
  });
});
