/**
 * Local Orca execution contracts, independent of model/provider registration.
 *
 * @task T14455
 * @packageDocumentation
 */
import { z } from 'zod';

const identifier = z.string().min(1);

/** Explicit execution endpoint and caller; never inferred from the newest Run. */
export const orcaContextSchema = z.object({
  runtimeId: identifier,
  coordinatorHandle: identifier,
  executionHostId: z.literal('local'),
});

/** Verified local endpoint used for every operation, including recovery. */
export type OrcaContext = z.infer<typeof orcaContextSchema>;

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
  stopRequestId: identifier.nullable(),
  failureCount: z.number().int().nonnegative(),
  resourceState: z.string(),
  /** Full receipts retain effects, residual resources and recovery advice. */
  lastReceipt: z.string().nullable(),
  lastError: z.string().nullable(),
  observedAt: z.string(),
});

/** An exact execution attempt; uncertain states always retain worker custody. */
export type OrcaAttempt = z.infer<typeof orcaAttemptSchema>;

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
  /** Replay only the original issued mutation request. */
  replayStart(attempt: OrcaAttempt): Promise<OrcaAttempt>;
  /** Read the exact stored Dispatch identity. */
  show(attempt: OrcaAttempt): Promise<OrcaAttempt>;
  /** Read a bounded output page without consuming coordinator mail. */
  read(attempt: OrcaAttempt, cursor?: string): Promise<string>;
  /** Request guarded cancellation after core reserves it durably. */
  stop(attempt: OrcaAttempt): Promise<OrcaAttempt>;
  /** Replay only the issued stop request on its original exact Dispatch. */
  replayStop(attempt: OrcaAttempt): Promise<OrcaAttempt>;
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
      stage: z.string().optional(),
      turnStart: z.string().optional(),
      runId: identifier.optional(),
      run: z.object({ id: identifier }).optional(),
      taskId: identifier.optional(),
      dispatchId: identifier.optional(),
      failureCount: z.number().int().nonnegative().optional(),
      effects: z.array(effectSchema).optional(),
      residualResources: z.array(effectSchema).optional(),
      launch: z.object({ effective: selectionSchema.optional() }).optional(),
      lastError: z.string().nullable().optional(),
      processAction: z.string().optional(),
      helpers: z.array(z.object({ outcome: z.string() })).optional(),
      helperStopError: z.string().nullable().optional(),
      status: z.string().optional(),
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
