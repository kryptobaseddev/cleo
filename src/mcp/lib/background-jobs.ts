/**
 * Background Job Manager for Long-Running Operations
 *
 * Per MCP-SERVER-SPECIFICATION.md Section 10, operations that may take >30s
 * should support async execution. This module provides a job manager that
 * tracks background operations with status, progress, and auto-cleanup.
 *
 * @task T3080
 */

import { randomUUID } from 'crypto';

/**
 * Background job status
 */
export type JobStatus = 'running' | 'completed' | 'failed' | 'cancelled';

/**
 * Background job representation
 */
export interface BackgroundJob {
  id: string;
  operation: string;
  status: JobStatus;
  startedAt: string;
  completedAt?: string;
  result?: unknown;
  error?: string;
  progress?: number;
}

/**
 * Configuration for BackgroundJobManager
 */
export interface BackgroundJobManagerConfig {
  maxJobs?: number;
  retentionMs?: number;
}

/**
 * Manages background jobs for long-running operations
 */
export class BackgroundJobManager {
  private jobs: Map<string, BackgroundJob>;
  private abortControllers: Map<string, AbortController>;
  private maxJobs: number;
  private retentionMs: number;
  private cleanupTimer: ReturnType<typeof setInterval> | null;

  constructor(config?: BackgroundJobManagerConfig) {
    this.jobs = new Map();
    this.abortControllers = new Map();
    this.maxJobs = config?.maxJobs ?? 10;
    this.retentionMs = config?.retentionMs ?? 3600000; // 1 hour default
    this.cleanupTimer = null;

    // Start periodic cleanup every 5 minutes
    this.cleanupTimer = setInterval(() => this.cleanup(), 300000);
    // Don't prevent process exit
    if (this.cleanupTimer.unref) {
      this.cleanupTimer.unref();
    }
  }

  /**
   * Start a new background job
   *
   * @param operation - The operation identifier (e.g. "validate.test.run")
   * @param executor - Async function to execute in the background
   * @returns The job ID
   * @throws Error if max concurrent jobs reached
   */
  async startJob(operation: string, executor: () => Promise<unknown>): Promise<string> {
    // Check concurrent job limit (only count running jobs)
    const runningCount = this.listJobs('running').length;
    if (runningCount >= this.maxJobs) {
      throw new Error(
        `Maximum concurrent jobs reached (${this.maxJobs}). Cancel or wait for existing jobs to complete.`
      );
    }

    const jobId = randomUUID();
    const abortController = new AbortController();

    const job: BackgroundJob = {
      id: jobId,
      operation,
      status: 'running',
      startedAt: new Date().toISOString(),
    };

    this.jobs.set(jobId, job);
    this.abortControllers.set(jobId, abortController);

    // Execute async - don't await
    this.executeJob(jobId, executor, abortController.signal);

    return jobId;
  }

  /**
   * Get a specific job by ID
   */
  getJob(jobId: string): BackgroundJob | undefined {
    return this.jobs.get(jobId);
  }

  /**
   * List all jobs, optionally filtered by status
   */
  listJobs(status?: string): BackgroundJob[] {
    const all = Array.from(this.jobs.values());
    if (!status) {
      return all;
    }
    return all.filter((job) => job.status === status);
  }

  /**
   * Cancel a running job
   *
   * @returns true if the job was cancelled, false if not found or not running
   */
  cancelJob(jobId: string): boolean {
    const job = this.jobs.get(jobId);
    if (!job || job.status !== 'running') {
      return false;
    }

    const controller = this.abortControllers.get(jobId);
    if (controller) {
      controller.abort();
      this.abortControllers.delete(jobId);
    }

    job.status = 'cancelled';
    job.completedAt = new Date().toISOString();

    return true;
  }

  /**
   * Update job progress (0-100)
   */
  updateProgress(jobId: string, progress: number): boolean {
    const job = this.jobs.get(jobId);
    if (!job || job.status !== 'running') {
      return false;
    }
    job.progress = Math.max(0, Math.min(100, progress));
    return true;
  }

  /**
   * Cleanup old completed/failed/cancelled jobs past retention period
   *
   * @returns Number of jobs cleaned up
   */
  cleanup(): number {
    const now = Date.now();
    let cleaned = 0;

    for (const [id, job] of this.jobs.entries()) {
      if (job.status === 'running') {
        continue;
      }
      if (job.completedAt) {
        const completedTime = new Date(job.completedAt).getTime();
        if (now - completedTime > this.retentionMs) {
          this.jobs.delete(id);
          this.abortControllers.delete(id);
          cleaned++;
        }
      }
    }

    return cleaned;
  }

  /**
   * Destroy the manager: cancel all running jobs and clear state
   */
  destroy(): void {
    // Cancel all running jobs
    for (const [id, job] of this.jobs.entries()) {
      if (job.status === 'running') {
        const controller = this.abortControllers.get(id);
        if (controller) {
          controller.abort();
        }
      }
    }

    this.jobs.clear();
    this.abortControllers.clear();

    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
  }

  /**
   * Execute a job's executor function and update status on completion/failure
   */
  private async executeJob(
    jobId: string,
    executor: () => Promise<unknown>,
    signal: AbortSignal
  ): Promise<void> {
    const job = this.jobs.get(jobId);
    if (!job) {
      return;
    }

    try {
      const result = await executor();

      // Check if cancelled during execution
      if (signal.aborted) {
        return;
      }

      job.status = 'completed';
      job.completedAt = new Date().toISOString();
      job.result = result;
      job.progress = 100;
    } catch (error) {
      // Check if this was a cancellation
      if (signal.aborted) {
        return;
      }

      job.status = 'failed';
      job.completedAt = new Date().toISOString();
      job.error = error instanceof Error ? error.message : String(error);
    } finally {
      this.abortControllers.delete(jobId);
    }
  }
}
