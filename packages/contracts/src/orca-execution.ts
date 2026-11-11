/**
 * Local Orca execution contracts, independent of model/provider registration.
 *
 * @task T14455
 * @packageDocumentation
 */
import { z } from 'zod';

/** Current public Orca launch APIs cannot carry the native lead's enforced guards. */
export const ORCA_LEAD_LAUNCH_REFUSAL = {
  code: 'E_LEAD_TOOLS_UNSTRIPPED',
  message:
    'Orca cannot enforce lead tool/permission restrictions (--restricted, --tools, --allowedTools, --disallowedTools, --permission-mode, --setting-sources), strict MCP isolation (--mcp-config, --strict-mcp-config), or the owner channel and own session (--session-id, --settings, inherited owner terminal or validated user-only mbx) before launch.',
  fix: 'Run cleo orchestrate lead <epicId> --adapter claude-code for the enforced native lead route, including inside Orca, with validated user-scope mbx for --detached; keep orchestrate.leadWorker.v1 enabled. The Orca backend needs a constrained launch API carrying these argv/settings before it can start a lead.',
} as const;

const identifier = z.string().min(1);

/** Orca server agent ids supported by the local routing contract. */
export const orcaAgentSchema = z.enum(['codex', 'opencode2', 'claude', 'grok']);

/** Server agent identity, separate from CLEO harness and model identity. */
export type OrcaAgent = z.infer<typeof orcaAgentSchema>;

/** Ordered rotation defaults; availability is verified on the execution host. */
export const DEFAULT_ORCA_AGENTS: OrcaAgent[] = ['codex', 'opencode2', 'claude'];

/** Harness identity for each supported Orca server agent. */
export const ORCA_AGENT_HARNESSES = {
  codex: 'codex',
  opencode2: 'opencode',
  claude: 'claude-code',
  grok: 'grok',
} as const;

/** Account inventory provider; Grok uses its server-side sign-in. */
export const ORCA_AGENT_PROVIDERS = {
  codex: 'codex',
  opencode2: 'opencode',
  claude: 'claude',
  grok: null,
} as const;

/** Project rotation configuration; duplicates and unsupported ids refuse. */
export const orchestrateOrcaConfigSchema = z.object({
  agents: z
    .array(orcaAgentSchema)
    .min(1)
    .refine((agents) => new Set(agents).size === agents.length, 'Agent ids must be unique.')
    .default(DEFAULT_ORCA_AGENTS),
});

/** Configuration for `orchestrate.orca`, independent of native provider discovery. */
export type OrchestrateOrcaConfig = z.input<typeof orchestrateOrcaConfigSchema>;

/** Explicit execution endpoint and caller; never inferred from the newest Run. */
export const orcaContextSchema = z.object({
  runtimeId: identifier,
  coordinatorHandle: identifier,
  executionHostId: z.literal('local'),
});

/** Verified local endpoint used for every operation, including recovery. */
export type OrcaContext = z.infer<typeof orcaContextSchema>;

/** Nonsecret account availability; private account rows never leave the adapter. */
export interface OrcaAccountAvailability {
  /** Provider understood by `orca account list`. */
  provider: 'codex' | 'opencode' | 'claude';
  /** Number of configured accounts, excluding their private fields. */
  accountCount: number;
  /** An active account or the provider's `system` sign-in is selected. */
  activeAccountPresent: boolean;
}

/** Verified caller and the sanitized local account inventory. */
export interface OrcaDiscovery {
  /** Runtime and coordinator proven through read-only host calls. */
  context: OrcaContext;
  /** Availability only; no emails, homes, credentials or exact account placement. */
  accounts: OrcaAccountAvailability[];
}

/** Durable routing state for one exact runtime/coordinator Run. */
export const orcaRoutingRunSchema = z.object({
  runId: identifier.nullable(),
  unconfiguredAgents: z.array(orcaAgentSchema),
});

/** Persisted execution Run and its confirmed prelaunch refusals. */
export type OrcaRoutingRun = z.infer<typeof orcaRoutingRunSchema>;

/** Canonically prepared CLEO assignment consumed without allocating another session. */
export const orcaLaunchSchema = z.object({
  projectId: identifier,
  projectRoot: identifier,
  taskId: identifier,
  instanceId: identifier,
  workerSessionId: identifier,
  agentId: identifier,
  role: z.enum(['worker', 'lead']),
  protocol: identifier,
  worktreePath: identifier,
  worktreeBranch: identifier,
  projectHash: identifier,
  lockToken: identifier,
  prompt: identifier,
  harness: z.enum(['claude-code', 'codex', 'opencode', 'grok', 'kimi']),
  leadMailbox: identifier.nullable(),
  model: identifier.optional(),
  effort: identifier.optional(),
  accountId: identifier.optional(),
});

/** Input from canonical CLEO spawn preparation; Orca does not create its checkout. */
export type OrcaLaunch = z.infer<typeof orcaLaunchSchema>;

/** Original launch addressing, retained even when a partial receipt supplies ids. */
export const orcaStartBindingSchema = z.object({
  runId: identifier.nullable(),
  orcaTaskId: identifier.nullable(),
  retryOf: identifier.nullable(),
});

/** Durable attempt, stored in the existing local worker record before launch. */
export const orcaAttemptSchema = z.object({
  backend: z.literal('orca'),
  version: z.literal(1),
  /** Monotonic local CAS revision; repeated identical observations still serialize. */
  revision: z.number().int().nonnegative(),
  context: orcaContextSchema,
  launch: orcaLaunchSchema,
  promptDigest: z.string().regex(/^[a-f0-9]{64}$/),
  workspaceId: identifier,
  workspaceSelector: identifier,
  state: z.enum([
    'prepared',
    'launching',
    'ready',
    'turn_unobserved',
    'outcome_unknown',
    'stop_pending',
    'stop_unknown',
    'stopped',
    'failed',
    'circuit_broken',
  ]),
  runId: identifier.nullable(),
  orcaTaskId: identifier.nullable(),
  dispatchId: identifier.nullable(),
  retryOf: identifier.nullable(),
  /** Absent on legacy records, whose original argv cannot safely be reconstructed. */
  startBinding: orcaStartBindingSchema.optional(),
  /** UUID reserved before committing a retry; its first send and every replay use this key. */
  startRequestKey: z.string().uuid().optional(),
  startRequestId: identifier.nullable(),
  /** UUID reserved before committing a stop; its first send and every replay use this key. */
  stopRequestKey: z.string().uuid().optional(),
  /** Orca-issued stop request id, retained only when the stop receipt was received. */
  stopRequestId: identifier.nullable(),
  /**
   * Set when the worker-stop reply came from a runtime that proved it enumerates
   * every helper it stopped, so an omitted helper list means the worker had none.
   */
  stopHelperEvidence: z.literal('enumerated').optional(),
  failureCount: z.number().int().nonnegative(),
  resourceState: z.string(),
  /** Full receipts retain effects, residual resources and recovery advice. */
  lastReceipt: z.string().nullable(),
  lastError: z.string().nullable(),
  /** Confirmed pre-dispatch refusal; never inferred from a process exit. */
  startRefusal: z.literal('agent_unconfigured').optional(),
  observedAt: z.string(),
});

/** An exact execution attempt; uncertain states always retain worker custody. */
export type OrcaAttempt = z.infer<typeof orcaAttemptSchema>;

/** Selected worker_done transport, independent of the canonical CLEO report bytes. */
export const orcaWorkerDoneSchema = z.object({
  messageId: identifier,
  runtimeId: identifier,
  runId: identifier,
  orcaTaskId: identifier,
  dispatchId: identifier,
  senderHandle: identifier,
  outcome: z.enum(['succeeded', 'failed']),
  body: z.string(),
  reportPath: identifier,
});

/** Provenance returned by the read-only Orca report transport. */
export type OrcaWorkerDone = z.infer<typeof orcaWorkerDoneSchema>;

/** Durable report settlement; no task acceptance or process-release state is implied. */
export const orcaWorkerReportSchema = z.object({
  event: orcaWorkerDoneSchema,
  manifestId: identifier,
  manifestDigest: z.string().regex(/^[a-f0-9]{64}$/),
  reportText: z.string().min(1).max(65_536),
  reportDigest: z.string().regex(/^[a-f0-9]{64}$/),
  ingestedAt: z.string().datetime(),
});

/** Validated original report and manifest link, stored on the local worker record. */
export type OrcaWorkerReport = z.infer<typeof orcaWorkerReportSchema>;

/** Full inbox rows; unrelated message bodies are discarded after selecting the requested id. */
export const orcaReportSourceSchema = z.object({
  ok: z.literal(true),
  _meta: z.object({ runtimeId: identifier }),
  result: z.object({
    messages: z
      .array(
        z.object({
          id: identifier,
          run_id: z.string().nullable(),
          delivery_contract: z.string(),
          from_handle: z.string(),
          to_handle: z.string(),
          type: z.string(),
          body: z.string(),
          payload: z.string().nullable(),
          sender_pane_key: z.string().nullable(),
        }),
      )
      .optional(),
    dispatch: z
      .object({
        id: identifier,
        run_id: identifier,
        task_id: identifier,
        assignee_handle: identifier,
        assignee_pane_key: z.string().nullable(),
        status: z.string(),
      })
      .optional(),
  }),
});

/** Fields Orca records from worker_done flags; prose never supplies a report or proof. */
export const orcaWorkerDonePayloadSchema = z.object({
  taskId: identifier,
  dispatchId: identifier,
  outcome: z.enum(['succeeded', 'failed']),
  reportPath: identifier,
});

/** Exact-record supervision request; recovery never chooses a task's newest attempt. */
export const orcaWorkerRequestSchema = z
  .object({
    action: z.enum([
      'show',
      'read',
      'recover-start',
      'recover-stop',
      'retry',
      'stop',
      'ingest-report',
    ]),
    recordId: identifier,
    cursor: identifier.optional(),
    messageId: identifier.optional(),
  })
  .refine(({ action, cursor }) => cursor === undefined || action === 'read', {
    message: 'A source-pinned cursor is accepted only for read.',
    path: ['cursor'],
  })
  .refine(({ action, messageId }) => (action === 'ingest-report') === (messageId !== undefined), {
    message: 'ingest-report requires an exact message id; other actions do not accept one.',
    path: ['messageId'],
  });

/** CLI and SDK input for inspecting or recovering one durable Orca attempt. */
export type OrcaWorkerRequest = z.infer<typeof orcaWorkerRequestSchema>;

/**
 * Process-side execution port. Core owns persistence and receives this port from
 * its caller, so it never imports an adapter that builds after core.
 */
export interface OrcaExecutionAdapter {
  /** Verify installed commands, runtime and existing workspace before admission. */
  preflight(
    launch: OrcaLaunch,
    context: OrcaContext,
  ): Promise<Pick<OrcaAttempt, 'workspaceId' | 'workspaceSelector'>>;
  /** Start a durably reserved attempt, preserving uncertain outcomes. */
  start(attempt: OrcaAttempt): Promise<OrcaAttempt>;
  /** Replay only the original mutation identity, including a pre-reserved retry. */
  replayStart(attempt: OrcaAttempt): Promise<OrcaAttempt>;
  /** Read the exact stored Dispatch identity. */
  show(attempt: OrcaAttempt): Promise<OrcaAttempt>;
  /** Read a bounded output page without consuming coordinator mail. */
  read(attempt: OrcaAttempt, cursor?: string): Promise<string>;
  /** Fetch one current-dispatch worker_done without consuming coordinator mail. */
  readReport(attempt: OrcaAttempt, messageId: string): Promise<OrcaWorkerDone>;
  /** Request guarded cancellation after core reserves it durably. */
  stop(attempt: OrcaAttempt): Promise<OrcaAttempt>;
  /** Replay only the issued stop request on its original exact Dispatch. */
  replayStop(attempt: OrcaAttempt): Promise<OrcaAttempt>;
}

/** Host discovery port injected by product dispatch, outside the model registry. */
export interface OrcaRoutingAdapter extends OrcaExecutionAdapter {
  /** Process-free admission hint; backend selection still requires verified discovery. */
  hasContextHints(): boolean;
  /** Null outside Orca; partial, unavailable or ambiguous contexts throw a refusal. */
  discover(projectRoot: string): Promise<OrcaDiscovery | null>;
  /** Inspect the exact coordinator's current Run; explicit null proves no binding. */
  currentRun(projectRoot: string, context: OrcaContext): Promise<string | null>;
}

/** Result from one bounded subprocess invocation, including nonzero JSON receipts. */
export interface OrcaCommandResult {
  /** Entire stdout, with no shell or human-output parsing. */
  stdout: string;
  /** Diagnostic stderr. */
  stderr: string;
  /** Null for a transport failure or timeout; never proof of worker exit. */
  exitCode: number | null;
}

/** Process boundary; fixtures inject this instead of launching real workers. */
export type OrcaCommandRunner = (
  executable: string,
  args: readonly string[],
  cwd: string,
  input?: string,
) => Promise<OrcaCommandResult>;

const effectSchema = z.object({
  kind: z.string(),
  role: z.string().optional(),
  action: z.string().optional(),
  id: z.string().optional(),
});
const selectionSchema = z.object({
  agent: z.string().nullable().optional(),
  model: z.string().nullable().optional(),
  effort: z.string().nullable().optional(),
});

/**
 * Validates the wire fields used for admission and fencing. Unknown fields are
 * ignored here and preserved in the original receipt, never treated as evidence.
 * Audited against the installed Orca 1.4.255 full CLI views.
 */
export const orcaReplySchema = z.object({
  ok: z.boolean(),
  _meta: z.object({ runtimeId: z.string().nullable() }).optional(),
  error: z
    .object({
      code: z.string(),
      message: z.string(),
      data: z
        .object({
          requestId: identifier.optional(),
          orchestrationRequestId: identifier.optional(),
          dispatchId: identifier.optional(),
        })
        .optional(),
    })
    .optional(),
  result: z
    .object({
      state: z.string().optional(),
      requestId: identifier.optional(),
      /**
       * Mutation ledger identity Orca stamps on every successful mutation result.
       * @remarks Installed Orca 1.4.255 attaches `{ requestId, replayed }` to the
       * result it records (`Jy` in the retained source), so a successful stop can
       * be bound to the request key this attempt issued.
       */
      mutation: z
        .object({
          requestId: identifier.optional(),
          replayed: z.boolean().optional(),
        })
        .optional(),
      stage: z.string().optional(),
      turnStart: z.string().optional(),
      runId: identifier.optional(),
      run: z.object({ id: identifier }).nullable().optional(),
      taskId: identifier.optional(),
      dispatchId: identifier.optional(),
      failureCount: z.number().int().nonnegative().optional(),
      effects: z.array(effectSchema).optional(),
      residualResources: z.array(effectSchema).optional(),
      launch: z.object({ effective: selectionSchema.optional() }).optional(),
      lastError: z.string().nullable().optional(),
      processAction: z.string().optional(),
      helpers: z
        .array(
          z.object({
            dispatchId: identifier.optional(),
            creatorDispatchId: identifier.optional(),
            outcome: z.string(),
            keptOpenBy: identifier.optional(),
            state: z.string().optional(),
            lastError: z.string().nullable().optional(),
          }),
        )
        .optional(),
      helperStopError: z.string().nullable().optional(),
      status: z.string().optional(),
      terminal: z
        .object({
          handle: identifier,
          connected: z.boolean(),
          writable: z.boolean(),
          executionHostId: identifier,
        })
        .optional(),
      runtime: z
        .object({
          runtimeId: identifier,
          reachable: z.boolean(),
          state: z.string(),
          capabilities: z.array(z.string()),
        })
        .optional(),
      worktree: z
        .object({
          id: identifier,
          path: identifier,
          branch: identifier,
          hostId: identifier,
          address: z.object({ worktree: identifier }).optional(),
        })
        .optional(),
      dispatch: z
        .object({
          id: identifier,
          runId: identifier,
          taskId: identifier,
          /** Direct creator Dispatch that started this one; null for a Run root. */
          creatorDispatchId: identifier.nullable().optional(),
          failureCount: z.number().int().nonnegative(),
        })
        .optional(),
      worker: z
        .object({
          dispatchId: identifier,
          runtimeEpoch: identifier,
          state: z.string(),
          stage: z.string(),
          worktreeId: identifier.nullable(),
        })
        .optional(),
      observation: z.object({ status: z.string(), exactWorker: z.boolean().optional() }).optional(),
      projection: z
        .object({
          resource: z
            .object({
              state: z.string(),
              terminalState: z.string(),
              ownerDispatchId: identifier.optional(),
              releaseState: z.string().optional(),
            })
            .optional(),
        })
        .optional(),
    })
    .optional(),
});

/** Validated subset of a full Orca response. */
export type OrcaReply = z.infer<typeof orcaReplySchema>;

/** Parsed fields alongside the original receipt, kept per call during parallel fanout. */
export type OrcaCommandReply = OrcaReply & { rawReceipt: string };

/** Installed command declarations; PATH presence alone never authorizes a launch. */
export const orcaCommandRegistrySchema = z.object({
  schemaVersion: z.number().int().positive(),
  commands: z.array(z.object({ command: identifier, flags: z.array(z.string()) })),
});

const accountProviderSchema = z.object({
  accounts: z.array(z.object({})),
  activeAccountId: identifier.nullable(),
});

/** Private account wire fields: account attributes are discarded during parsing. */
export const orcaAccountReplySchema = z.object({
  ok: z.literal(true),
  _meta: z.object({ runtimeId: identifier }),
  result: z.object({
    codex: accountProviderSchema,
    opencode: accountProviderSchema,
    claude: accountProviderSchema,
  }),
});
