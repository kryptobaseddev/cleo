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
import { ConduitHandler } from './conduit.js';
import { DiagnosticsHandler } from './diagnostics.js';
import { DocsHandler } from './docs.js';
import { IntelligenceHandler } from './intelligence.js';
import { MemoryHandler } from './memory.js';
import { NexusHandler } from './nexus.js';
import { OrchestrateHandler } from './orchestrate.js';
import { PipelineHandler } from './pipeline.js';
import { PlaybookHandler } from './playbook.js';
import { ReleaseHandler } from './release.js';
import { SentientHandler } from './sentient.js';
import { SessionHandler } from './session.js';
import { StickyHandler } from './sticky.js';
import { TasksHandler } from './tasks.js';
import { ToolsHandler } from './tools.js';

export {
  AdminHandler,
  CheckHandler,
  ConduitHandler,
  DiagnosticsHandler,
  DocsHandler,
  IntelligenceHandler,
  MemoryHandler,
  NexusHandler,
  OrchestrateHandler,
  PipelineHandler,
  PlaybookHandler,
  ReleaseHandler,
  SentientHandler,
  SessionHandler,
  StickyHandler,
  TasksHandler,
  ToolsHandler,
};

/**
 * Create a Map of all canonical domain handlers.
 */
export function createDomainHandlers(): Map<string, DomainHandler> {
  const handlers = new Map<string, DomainHandler>();

  handlers.set('tasks', new TasksHandler());
  handlers.set('session', new SessionHandler());
  handlers.set('memory', new MemoryHandler());
  handlers.set('intelligence', new IntelligenceHandler());
  handlers.set('check', new CheckHandler());
  handlers.set('pipeline', new PipelineHandler());
  handlers.set('orchestrate', new OrchestrateHandler());
  handlers.set('tools', new ToolsHandler());
  handlers.set('admin', new AdminHandler());
  handlers.set('nexus', new NexusHandler());
  handlers.set('sticky', new StickyHandler());
  handlers.set('diagnostics', new DiagnosticsHandler());
  handlers.set('docs', new DocsHandler());
  // T935: HITL playbook runtime + approvals surface
  handlers.set('playbook', new PlaybookHandler());
  // T964: conduit promoted to first-class canonical domain
  // (supersedes ADR-042 Decision 1). ConduitHandler owns agent-to-agent
  // messaging (status, peek, start, stop, send) via pluggable transports.
  handlers.set('conduit', new ConduitHandler());
  // T1008: sentient domain — Tier-2 proposal queue management.
  handlers.set('sentient', new SentientHandler());
  // T1416: release domain — IVTR gate check (RELEASE-03) + auto-suggest (RELEASE-07).
  handlers.set('release', new ReleaseHandler());
  return handlers;
}
