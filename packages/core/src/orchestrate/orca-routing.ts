/**
 * Project routing policy for canonically prepared Orca workers.
 * @packageDocumentation
 */
import { createHash } from 'node:crypto';
import { ExitCode } from '@cleocode/contracts/exit-codes.js';
import {
  ORCA_AGENT_HARNESSES,
  ORCA_AGENT_PROVIDERS,
  type OrcaAgent,
  type OrcaDiscovery,
  type OrcaLaunch,
  type OrcaRoutingAdapter,
  type OrcaRoutingRun,
  orcaAgentSchema,
  orcaRoutingRunSchema,
  orchestrateOrcaConfigSchema,
} from '@cleocode/contracts/orca-execution.js';
import { getConfigValue } from '../config/registry.js';
import { CleoError } from '../errors.js';
import { getTaskAccessor } from '../store/data-accessor.js';
import { launchOrcaWorker } from './orca-execution.js';
import {
  listWorkerRecords,
  newWorkerInstanceId,
  retirePreDispatchOrcaWorker,
  type WorkerRecord,
} from './worker-records.js';

/**
 * Rotate across usable configured agents, retaining every sent attempt durably.
 * @remarks Only a proven pre-dispatch `agent_unconfigured` refusal may advance
 * to another candidate. Unknown outcomes fence the task; retries keep their harness.
 * @param prepared - Canonical prompt, worker identity and worktree lock.
 * @param discovery - Proven local caller and sanitized account availability.
 * @param backend - Injected host execution port, never a model provider.
 * @param adapterId - Optional explicit CLEO harness restriction.
 * @returns The exact durable worker, including any uncertain launch outcome.
 */
export async function launchRoutedOrcaWorker(
  prepared: Omit<OrcaLaunch, 'instanceId' | 'harness'>,
  discovery: OrcaDiscovery,
  backend: OrcaRoutingAdapter,
  adapterId?: string,
): Promise<WorkerRecord> {
  const config = orchestrateOrcaConfigSchema.safeParse(
    (await getConfigValue('orchestrate.orca', { projectRoot: prepared.projectRoot })) ?? {},
  );
  if (!config.success) {
    // @sync-invariant none:input-shape malformed rotation policy never falls through to a native launch
    throw new CleoError(
      ExitCode.SPAWN_VALIDATION_FAILED,
      'Invalid orchestrate.orca.agents configuration.',
      {
        fix: 'Set orchestrate.orca.agents to a nonempty unique ordered list of codex, opencode2, claude or grok.',
      },
    );
  }
  const agents = config.data.agents.filter((agent) => {
    const provider = ORCA_AGENT_PROVIDERS[agent];
    return (
      (adapterId === undefined || ORCA_AGENT_HARNESSES[agent] === adapterId) &&
      (provider === null ||
        discovery.accounts.some(
          (account) => account.provider === provider && account.activeAccountPresent,
        ))
    );
  });
  const accessor = await getTaskAccessor(prepared.projectRoot);
  const runKey = `orchestrate.orca.run:${createHash('sha256').update(JSON.stringify(discovery.context)).digest('hex')}`;
  const readRun = async (): Promise<OrcaRoutingRun> => {
    const state = await accessor.getMetaValue<OrcaRoutingRun>(runKey);
    const saved = orcaRoutingRunSchema.safeParse(state ?? { runId: null, unconfiguredAgents: [] });
    if (!saved.success) {
      // @sync-invariant none:local-only an unreadable Run binding cannot authorize a replacement or reset exclusions
      throw new CleoError(
        ExitCode.SPAWN_VALIDATION_FAILED,
        'The saved Orca routing Run is invalid.',
        {
          fix: 'Inspect the saved Orca worker bindings for this coordinator; repair the routing state without replacing unresolved attempts.',
        },
      );
    }
    return saved.data;
  };
  const currentRunId = await backend.currentRun(prepared.projectRoot, discovery.context);
  if (currentRunId === null) {
    const pending = (await listWorkerRecords(prepared.projectRoot, true)).find(
      ({ execution, stoppedAt }) =>
        stoppedAt === null &&
        execution &&
        execution.runId === null &&
        !execution.startRefusal &&
        execution.context.runtimeId === discovery.context.runtimeId &&
        execution.context.coordinatorHandle === discovery.context.coordinatorHandle &&
        execution.context.executionHostId === discovery.context.executionHostId,
    );
    if (pending) {
      // @sync-invariant none:local-only an unresolved first launch may still create this coordinator's Run
      throw new CleoError(
        ExitCode.SPAWN_VALIDATION_FAILED,
        'The coordinator has an unresolved start with no proven Run.',
        {
          details: { field: 'recordId', recordId: pending.recordId },
          fix: `Recover the original start for ${pending.recordId} before another dispatch; preserve its claim and worktree.`,
        },
      );
    }
  }
  await accessor.transaction(async (tx) => {
    const run = await readRun();
    if (run.runId !== currentRunId || currentRunId === null) {
      await tx.setMetaValue(runKey, { runId: currentRunId, unconfiguredAgents: [] });
    }
  });
  // Refusals before any Run exists belong only to this invocation.
  const refused = new Set<OrcaAgent>();
  for (;;) {
    const route = await accessor.transaction(async () => {
      const run = await readRun();
      const last = orcaAgentSchema
        .nullable()
        .safeParse(await accessor.getMetaValue<string>('orchestrate.orca.lastAgent'));
      if (!last.success) {
        // @sync-invariant none:local-only corrupt rotation history refuses instead of silently resetting placement
        throw new CleoError(
          ExitCode.SPAWN_VALIDATION_FAILED,
          'The saved Orca rotation history is invalid.',
          {
            fix: 'Inspect orchestrate.orca.agents and the saved project rotation; repair its last selected supported agent before dispatch.',
          },
        );
      }
      const lastIndex = last.data === null ? -1 : config.data.agents.indexOf(last.data);
      const ordered = [
        ...config.data.agents.slice(lastIndex + 1),
        ...config.data.agents.slice(0, lastIndex + 1),
      ];
      const agent = ordered.find(
        (candidate) =>
          agents.includes(candidate) &&
          !refused.has(candidate) &&
          !run.unconfiguredAgents.includes(candidate),
      );
      if (!agent) {
        // @sync-invariant none:local-only account or configured server-route unavailability cannot authorize another backend
        throw new CleoError(
          ExitCode.SPAWN_VALIDATION_FAILED,
          'No usable configured Orca agent is available for this Run.',
          {
            fix: `Inspect orca account list --json and orchestrate.orca.agents; select an active account or system sign-in for a configured enabled agent${adapterId ? ` matching the explicit ${adapterId} harness` : ''}. Bound-Run exclusions clear when orca orchestration run-current reports a different Run: use orca orchestration run-create --from ${discovery.context.coordinatorHandle} --objective <new-goal> after enabling the agent. Refusals with no bound Run apply only to this dispatch.`,
          },
        );
      }
      return { agent, runId: run.runId };
    });
    const harness = ORCA_AGENT_HARNESSES[route.agent];
    const record = await launchOrcaWorker(
      {
        ...prepared,
        harness,
        instanceId: newWorkerInstanceId(harness),
      },
      discovery.context,
      backend,
      route.runId,
    );
    const execution = record.execution;
    // @sync-invariant none:local-only no routing progress is inferred without a persisted attempt
    if (!execution) throw new Error('The routed worker has no persisted Orca execution.');
    await accessor.transaction(async (tx) => {
      const run = await readRun();
      if (run.runId !== null && execution.runId !== null && run.runId !== execution.runId) {
        // @sync-invariant none:local-only a changed owning Run cannot authorize replacement or release of pending custody
        throw new CleoError(
          ExitCode.SPAWN_VALIDATION_FAILED,
          'The Orca coordinator Run binding changed.',
          {
            details: { field: 'recordId', recordId: record.recordId },
            fix: `Inspect the exact worker ${record.recordId} and original coordinator; retain its claim and worktree while reconciling the Run.`,
          },
        );
      }
      await tx.setMetaValue(runKey, {
        runId: execution.runId ?? run.runId,
        unconfiguredAgents:
          run.runId !== null && execution.startRefusal === 'agent_unconfigured'
            ? [...new Set([...run.unconfiguredAgents, route.agent])]
            : run.unconfiguredAgents,
      });
      if (
        ['ready', 'turn_unobserved'].includes(execution.state) &&
        execution.runId &&
        execution.orcaTaskId &&
        execution.dispatchId
      ) {
        await tx.setMetaValue('orchestrate.orca.lastAgent', route.agent);
      }
    });
    if (execution.startRefusal !== 'agent_unconfigured') return record;
    refused.add(route.agent);
    // Record the unusable route before retiring custody; a crash between them stays fenced.
    await retirePreDispatchOrcaWorker(record, prepared.projectRoot);
  }
}
