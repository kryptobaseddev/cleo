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
import { LlmHandler } from './llm/index.js';
import { MemoryHandler } from './memory.js';
import { NexusHandler } from './nexus.js';
import { OrchestrateHandler } from './orchestrate.js';
import { PipelineHandler } from './pipeline.js';
import { PlaybookHandler } from './playbook.js';
import { ProvenanceHandler } from './provenance.js';
import { ReleaseHandler } from './release.js';
import { SentientHandler } from './sentient.js';
import { SessionHandler } from './session.js';
import { StickyHandler } from './sticky.js';
import { TasksHandler } from './tasks.js';
import { ToolsHandler } from './tools.js';
import { UpgradeHandler } from './upgrade.js';
import { WorktreeHandler } from './worktree.js';

export {
  AdminHandler,
  CheckHandler,
  ConduitHandler,
  DiagnosticsHandler,
  DocsHandler,
  IntelligenceHandler,
  LlmHandler,
  MemoryHandler,
  NexusHandler,
  OrchestrateHandler,
  PipelineHandler,
  PlaybookHandler,
  ProvenanceHandler,
  ReleaseHandler,
  SentientHandler,
  SessionHandler,
  StickyHandler,
  TasksHandler,
  ToolsHandler,
  UpgradeHandler,
  WorktreeHandler,
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
  // T9528: provenance domain — backfill the 11 provenance tables for historical
  // releases. Verify + repair verbs land in T9529+.
  handlers.set('provenance', new ProvenanceHandler());
  // T9258: `cleo llm` CLI surface — credential pool + role-aware resolver + config writer.
  handlers.set('llm', new LlmHandler());
  // T9546: `cleo worktree` CLI surface — structured worktree enumeration with status classification
  // (T9515 worktree-lifecycle bug fix epic, 2 of 5).
  handlers.set('worktree', new WorktreeHandler());
  // T9536: `cleo upgrade workflows` — re-render the four release-pipeline
  // workflow templates and report drift with 3-way merge against
  // .workflow-overrides.yml (Phase 4 / 4 of 4 of T9497).
  handlers.set('upgrade', new UpgradeHandler());
  return handlers;
}
