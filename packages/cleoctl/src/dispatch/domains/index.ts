/**
 * Domain Handler Registry -- Maps canonical domain names to handler instances.
 *
 * Uses static imports. Will produce compile errors until all handler files
 * are created by parallel agents -- that is expected.
 *
 * @epic T4820
 * @task T5277 - sharing merged into nexus
 */

import type { DomainHandler } from '../types.js';
import { AdminHandler } from './admin.js';
import { CheckHandler } from './check.js';
import { MemoryHandler } from './memory.js';
import { NexusHandler } from './nexus.js';
import { OrchestrateHandler } from './orchestrate.js';
import { PipelineHandler } from './pipeline.js';
import { SessionHandler } from './session.js';
import { StickyHandler } from './sticky.js';
import { TasksHandler } from './tasks.js';
import { ToolsHandler } from './tools.js';

export {
  TasksHandler,
  SessionHandler,
  CheckHandler,
  AdminHandler,
  MemoryHandler,
  OrchestrateHandler,
  PipelineHandler,
  ToolsHandler,
  NexusHandler,
  StickyHandler,
};

/**
 * Create a Map of all canonical domain handlers.
 */
export function createDomainHandlers(): Map<string, DomainHandler> {
  const handlers = new Map<string, DomainHandler>();

  handlers.set('tasks', new TasksHandler());
  handlers.set('session', new SessionHandler());
  handlers.set('memory', new MemoryHandler());
  handlers.set('check', new CheckHandler());
  handlers.set('pipeline', new PipelineHandler());
  handlers.set('orchestrate', new OrchestrateHandler());
  handlers.set('tools', new ToolsHandler());
  handlers.set('admin', new AdminHandler());
  handlers.set('nexus', new NexusHandler());
  handlers.set('sticky', new StickyHandler());
  return handlers;
}
