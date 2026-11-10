/**
 * `cleo orchestrate lead <epic>`: the no-hands lead entrypoint (T14363).
 *
 * {@link orchestrateLead} composes the lead/worker pieces of epic T14351
 * behind `orchestrate.leadWorker.v1`:
 *
 * - the lead spawns with {@link LEAD_DENIED_TOOLS} stripped: the spawn bridge
 *   refuses a provider that cannot enforce the strip (T14357);
 * - its only way to run a command is the allow-listed runner
 *   {@link LEAD_RUNNER_TOOL} (T14374), wired by the provider adapter;
 * - the project lead mailbox is claimed for the lead's provider session before
 *   it starts, so worker reports have a holder (T14379);
 * - the workers it dispatches go through `orchestrateSpawnExecute`, which
 *   applies fail-closed isolation (T14358), durable worker records (T14359)
 *   and the report contract in their prompt (T14361).
 *
 * @task T14363
 * @epic T14351
 */

import { randomUUID } from 'node:crypto';
import type { LeadDeniedTool, LeadMcpReport } from '@cleocode/contracts';
import { LEAD_DENIED_TOOLS, LEAD_RUNNER_TOOL } from '@cleocode/contracts/operations/orchestrate.js';
import { type EngineResult, engineError, engineSuccess } from '../engine-result.js';
import { getProjectRoot } from '../paths.js';
import { getTaskAccessor } from '../store/data-accessor.js';
import { resolveBoundSessionId } from '../store/session-store.js';
import { type AgentMbxClient, claimLeadMailbox, createAgentMbxClient } from './agentmbx.js';
import { isLeadWorkerV1Enabled } from './isolation-policy.js';
import { orchestrateSpawnExecute } from './spawn-ops.js';

/**
 * Provider CLI the lead mailbox is claimed under. Only Claude providers
 * enforce the lead tool strip (T14357), so a lead always runs under `claude`.
 */
const LEAD_PROVIDER_CLI = 'claude';

/** Options for {@link orchestrateLead}. */
export interface OrchestrateLeadOptions {
  /** Project root. @defaultValue the resolved project root */
  readonly projectRoot?: string;
  /** Spawn adapter id. @defaultValue the first spawn-capable adapter */
  readonly adapterId?: string;
  /** AgentMBX adapter. @defaultValue {@link createAgentMbxClient} */
  readonly mbxClient?: AgentMbxClient;
  /** Spawn function, injected in tests. @defaultValue {@link orchestrateSpawnExecute} */
  readonly spawn?: typeof orchestrateSpawnExecute;
}

/** The lead block of a successful {@link orchestrateLead} result. */
export interface OrchestrateLeadInfo {
  /** Tools the lead was spawned without. */
  readonly deniedTools: readonly LeadDeniedTool[];
  /** The one command tool the lead has. */
  readonly runnerTool: typeof LEAD_RUNNER_TOOL;
  /** Provider session id the lead runs under. */
  readonly sessionId: string;
  /** Lead mailbox claim: the held name, or the warning when it failed closed. */
  readonly mailbox:
    | { readonly claimed: true; readonly name: string | null }
    | {
        readonly claimed: false;
        readonly warning: string;
      };
  /**
   * MCP servers the lead loaded (T14423): the runner and, when configured,
   * mbx; nothing else. `null` when the provider did not report them.
   */
  readonly mcp: LeadMcpReport | null;
  /** Set when the lead runs without the mbx server: it cannot read worker mail. */
  readonly mcpWarning?: string;
}

/** The provider's {@link LeadMcpReport} from a spawn's data, if it sent one. */
function leadMcpOf(data: object): LeadMcpReport | null {
  const report = 'leadMcp' in data ? data.leadMcp : undefined;
  if (typeof report !== 'object' || report === null) return null;
  if (!('servers' in report) || !Array.isArray(report.servers)) return null;
  const mailbox = 'mailbox' in report ? report.mailbox : undefined;
  if (mailbox !== 'loaded' && mailbox !== 'not-configured' && mailbox !== 'refused') return null;
  const warning = 'warning' in report ? report.warning : undefined;
  return {
    servers: report.servers.filter((s): s is string => typeof s === 'string'),
    mailbox,
    ...(typeof warning === 'string' ? { warning } : {}),
  };
}

/**
 * Spawn the no-hands lead for an epic.
 *
 * Refuses unless `orchestrate.leadWorker.v1` is on (`E_LEAD_WORKER_DISABLED`)
 * and the id names an epic (`E_VALIDATION`). The lead mailbox is claimed only
 * after the lead is admitted and running; a failed claim does not stop it and
 * is reported under `data.lead.mailbox`. The MCP servers
 * the lead loaded (runner plus mbx only, T14423) are under `data.lead.mcp`.
 *
 * @param epicId - Epic the lead runs.
 * @param options - See {@link OrchestrateLeadOptions}.
 * @returns The spawn result with a `lead` block ({@link OrchestrateLeadInfo}).
 *
 * @example
 * ```ts
 * const result = await orchestrateLead('T14351');
 * if (result.success) console.log(result.data.lead.deniedTools);
 * ```
 *
 * @task T14363
 */
export async function orchestrateLead(
  epicId: string,
  options: OrchestrateLeadOptions = {},
): Promise<EngineResult> {
  const root = getProjectRoot(options.projectRoot);
  if (!(await isLeadWorkerV1Enabled(root))) {
    // @sync-invariant none:input-shape the lead entrypoint runs only with the lead/worker flag on
    return engineError('E_LEAD_WORKER_DISABLED', 'orchestrate.leadWorker.v1 is off', {
      exitCode: 6,
      details: { epicId, flag: 'orchestrate.leadWorker.v1' },
      fix: 'cleo config set orchestrate.leadWorker.v1 true',
    });
  }
  const task = await (await getTaskAccessor(root)).loadSingleTask(epicId);
  if (task?.type !== 'epic') {
    // @sync-invariant none:input-shape a lead runs an epic; any other id is refused before a spawn
    return engineError(
      task ? 'E_VALIDATION' : 'E_NOT_FOUND',
      task ? `${epicId} is a ${task.type}, not an epic` : `Task ${epicId} not found`,
      { exitCode: task ? 6 : 4, fix: 'cleo orchestrate lead <epicId>' },
    );
  }

  // T14363 — one lead per epic: a live claim held by another session (a
  // running lead holds its epic) refuses, so a second lead never starts or
  // takes the running lead's mailbox. The lead's exit ends its session,
  // which releases the claim.
  const holder = task.claim;
  if (holder && Date.parse(holder.leaseExpiresAt) > Date.now()) {
    const caller = await resolveBoundSessionId(root);
    if (holder.sessionId !== caller) {
      // @sync-invariant none:input-shape a second lead on a claimed epic is refused before a spawn
      return engineError('E_LEAD_RUNNING', `${epicId} is held by session ${holder.sessionId}`, {
        exitCode: 6,
        details: { epicId, holder },
        fix: `Wait for the running lead to exit, or end session ${holder.sessionId} (cleo session end)`,
      });
    }
  }

  const sessionId = randomUUID();
  const spawn = options.spawn ?? orchestrateSpawnExecute;
  const result = await spawn(epicId, options.adapterId, undefined, root, 1, {
    lead: { deniedTools: LEAD_DENIED_TOOLS, sessionId },
  });
  if (!result.success) return result;
  const data = typeof result.data === 'object' && result.data !== null ? result.data : {};
  const mcp = leadMcpOf(data);
  // T14363 — claim the mailbox only once the lead is admitted and running: a
  // refused spawn, or a second lead refused for the same epic, never takes
  // it. The lead's SessionEnd hook releases it when the lead exits.
  const running = 'status' in data && data.status !== 'failed';
  const claim = running
    ? await claimLeadMailbox(
        root,
        { cli: LEAD_PROVIDER_CLI, session: sessionId },
        options.mbxClient ?? createAgentMbxClient(),
      )
    : ({ ok: false, warning: 'the lead did not start, so no mailbox was claimed' } as const);
  const mailbox: OrchestrateLeadInfo['mailbox'] = claim.ok
    ? { claimed: true, name: claim.value.name }
    : { claimed: false, warning: claim.warning };
  const lead: OrchestrateLeadInfo = {
    deniedTools: LEAD_DENIED_TOOLS,
    runnerTool: LEAD_RUNNER_TOOL,
    sessionId,
    mailbox,
    mcp,
    ...(mcp?.mailbox === 'not-configured'
      ? {
          mcpWarning:
            'No user-level mbx MCP server is configured, so the lead loads only the runner and cannot read worker mail. Configure the mbx server (agentmbx mcp) in ~/.claude.json and re-run.',
        }
      : mcp?.mailbox === 'refused'
        ? {
            mcpWarning: `The mbx MCP server was refused, so the lead loads only the runner: ${mcp.warning ?? 'it failed the checks'}.`,
          }
        : {}),
  };
  return engineSuccess({ ...data, lead });
}
