/**
 * Singleton accessor for BackgroundJobManager.
 *
 * @task T4820
 */

import type { BackgroundJobManager } from './background-jobs.js';

let _instance: BackgroundJobManager | null = null;

export function setJobManager(manager: BackgroundJobManager): void {
  _instance = manager;
}

export function getJobManager(): BackgroundJobManager | null {
  return _instance;
}
