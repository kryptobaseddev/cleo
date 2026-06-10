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
import { AttentionHandler } from './attention.js';
import { CheckHandler } from './check.js';
import { ConduitHandler } from './conduit.js';
import { DiagnosticsHandler } from './diagnostics.js';
import { DocsHandler } from './docs.js';
import { FocusHandler } from './focus.js';
import { IntelligenceHandler } from './intelligence.js';
import { LlmHandler } from './llm/index.js';
import { MemoryHandler } from './memory.js';
import { NexusHandler } from './nexus.js';
import { OrchestrateHandler } from './orchestrate.js';
import { PipelineHandler } from './pipeline.js';
import { PlaybookHandler } from './playbook.js';
import { ProvenanceHandler } from './provenance.js';
import { ReleaseHandler } from './release.js';
import { SelfimproveHandler } from './selfimprove.js';
import { SentientHandler } from './sentient.js';
import { ServiceHandler } from './service.js';
import { SessionHandler } from './session.js';
import { StickyHandler } from './sticky.js';
import { TasksHandler } from './tasks.js';
import { ToolsHandler } from './tools.js';
import { UpgradeHandler } from './upgrade.js';
import { WorktreeHandler } from './worktree.js';

export {
  AdminHandler,
  AttentionHandler,
  CheckHandler,
  ConduitHandler,
  DiagnosticsHandler,
  DocsHandler,
  FocusHandler,
  IntelligenceHandler,
  LlmHandler,
  MemoryHandler,
  NexusHandler,
  OrchestrateHandler,
  PipelineHandler,
  PlaybookHandler,
  ProvenanceHandler,
  ReleaseHandler,
  SelfimproveHandler,
  SentientHandler,
  ServiceHandler,
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
  // T11373: attention domain — Tier-2 scope-keyed working-memory jots (Epic T11288)
  handlers.set('attention', new AttentionHandler());
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
  // T9973: focus domain — single-envelope task orientation (8 calls → 1)
  handlers.set('focus', new FocusHandler());
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
  // T11889 (T11889-D): selfimprove domain — the self-dogfooding loop verb
  // (`cleo selfimprove run`). Thin delegate to the CORE `runSelfImprove` engine.
  handlers.set('selfimprove', new SelfimproveHandler());
  // T11939 (epic T11765): service domain — universal service-vault OAuth flow
  // (`cleo service auth-url|exchange|refresh|self-heal`). Thin delegate to the
  // CORE `store/service-oauth.ts` functions, driven by SERVICE_PROVIDERS.
  handlers.set('service', new ServiceHandler());
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
