/**
 * Progress indicator utilities for CLI commands.
 * Provides human-friendly progress output for long-running operations.
 * 
 * @task T5243
 */

import { stderr, stdout } from 'node:process';

export interface ProgressOptions {
  /** Whether to show progress (true for human mode, false for JSON mode) */
  enabled: boolean;
  /** Prefix for progress messages */
  prefix?: string;
}

/**
 * Simple progress tracker for CLI operations.
 */
export class ProgressTracker {
  private enabled: boolean;
  private prefix: string;
  private currentStep = 0;
  private totalSteps: number;
  private steps: string[];

  constructor(options: ProgressOptions & { steps: string[] }) {
    this.enabled = options.enabled;
    this.prefix = options.prefix ?? 'CLEO';
    this.steps = options.steps;
    this.totalSteps = options.steps.length;
  }

  /**
   * Start the progress tracker.
   */
  start(): void {
    if (!this.enabled) return;
    this.currentStep = 0;
    stderr.write(`\n${this.prefix}: Starting...\n`);
  }

  /**
   * Update to a specific step.
   */
  step(index: number, message?: string): void {
    if (!this.enabled) return;
    this.currentStep = index;
    const stepName = this.steps[index] ?? message ?? 'Working...';
    const progress = `[${index + 1}/${this.totalSteps}]`;
    stderr.write(`  ${progress} ${stepName}...\n`);
  }

  /**
   * Move to next step.
   */
  next(message?: string): void {
    this.step(this.currentStep + 1, message);
  }

  /**
   * Mark as complete with optional summary.
   */
  complete(summary?: string): void {
    if (!this.enabled) return;
    if (summary) {
      stdout.write(`\n${this.prefix}: ✓ ${summary}\n\n`);
    } else {
      stdout.write(`\n${this.prefix}: ✓ Complete\n\n`);
    }
  }

  /**
   * Report an error.
   */
  error(message: string): void {
    if (!this.enabled) return;
    stderr.write(`\n${this.prefix}: ✗ ${message}\n\n`);
  }
}

/**
 * Simple spinner for indeterminate progress.
 */
export class Spinner {
  private enabled: boolean;
  private message: string;
  private timer: ReturnType<typeof setInterval> | null = null;
  private frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  private frameIndex = 0;

  constructor(options: { enabled: boolean; message: string }) {
    this.enabled = options.enabled;
    this.message = options.message;
  }

  /**
   * Start the spinner.
   */
  start(): void {
    if (!this.enabled) return;
    this.timer = setInterval(() => {
      const frame = this.frames[this.frameIndex];
      stderr.write(`\r${frame} ${this.message}`);
      this.frameIndex = (this.frameIndex + 1) % this.frames.length;
    }, 80);
  }

  /**
   * Stop the spinner.
   */
  stop(finalMessage?: string): void {
    if (!this.enabled) return;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (finalMessage) {
      stderr.write(`\r✓ ${finalMessage}\n`);
    } else {
      stderr.write('\r'.padEnd(this.message.length + 2) + '\r');
    }
  }

  /**
   * Update the spinner message.
   */
  update(message: string): void {
    this.message = message;
  }
}

/**
 * Create a progress tracker for self-update operations.
 */
export function createSelfUpdateProgress(enabled: boolean): ProgressTracker {
  return new ProgressTracker({
    enabled,
    prefix: 'CLEO',
    steps: [
      'Detecting installation type',
      'Checking current version',
      'Querying npm registry',
      'Comparing versions',
      'Running post-update checks',
      'Finalizing',
    ],
  });
}

/**
 * Create a progress tracker for doctor operations.
 */
export function createDoctorProgress(enabled: boolean): ProgressTracker {
  return new ProgressTracker({
    enabled,
    prefix: 'CLEO Doctor',
    steps: [
      'Checking CLEO directory',
      'Verifying tasks database',
      'Checking configuration',
      'Validating schemas',
      'Running health checks',
    ],
  });
}

/**
 * Create a progress tracker for upgrade operations.
 */
export function createUpgradeProgress(enabled: boolean): ProgressTracker {
  return new ProgressTracker({
    enabled,
    prefix: 'CLEO Upgrade',
    steps: [
      'Analyzing current state',
      'Checking storage migration needs',
      'Validating schemas',
      'Applying fixes',
      'Verifying results',
    ],
  });
}
