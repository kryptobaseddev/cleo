/**
 * Spawn provider interface for CLEO provider adapters.
 *
 * @task T5240
 * @task T9214 — orchestrator-defer waiver field (W4 UX hardening)
 * @task T9215 — DelegateTaskEnvelope discriminated-union type (W1 wiring)
 * @task T11998 — per-session suite containment (AgentSuiteOwnership)
 */

// =============================================================================
// Agent suite ownership handle (T11998 — suite containment)
// =============================================================================

/**
 * Containment mode used when spawning an agent process tree.
 *
 * - `'systemd'` — the agent and its MCP children run inside a transient
 *   `systemd --user` scope unit.  The scope is the kill handle.
 * - `'pgid'` — the agent runs in its own POSIX process group.  Negative-PID
 *   kill (`kill(-pgid, SIGTERM)`) reaps the whole group.
 * - `'none'` — no containment (detached+unref legacy path).  The janitor
 *   (T11995) is the only backstop.
 */
export type AgentContainmentMode = 'systemd' | 'pgid' | 'none';

/**
 * Ownership/cleanup handle recorded per spawned agent session.
 *
 * This record is stored alongside the {@link SpawnResult} so that
 * `terminate()` and session-end flows can reap the entire process tree
 * (including indirectly-spawned MCP grandchildren) via a single kill.
 *
 * ## Systemd path
 * `systemctl --user stop <unitName>` stops the scope and all processes
 * inside it.  If the scope has already exited, use `reset-failed` to clear
 * the failed-unit ledger; ESRCH / no-such-unit errors are no-ops.
 *
 * ## Pgid path
 * `process.kill(-pgid, 'SIGTERM')` sends SIGTERM to every process in the
 * group.  After a grace period, `process.kill(-pgid, 'SIGKILL')` cleans
 * up survivors.  ESRCH is a no-op (group already gone).
 *
 * @task T11998
 */
export interface AgentSuiteOwnership {
  /**
   * Containment mode in effect for this agent spawn.
   *
   * Determines which reap primitive to use on session end.
   */
  readonly mode: AgentContainmentMode;

  /**
   * Systemd transient scope unit name (e.g. `cleo-agent-session-T1234.scope`).
   *
   * Present only when `mode === 'systemd'`.  Use as the argument to
   * `systemctl --user stop <unitName>`.
   */
  readonly unitName?: string;

  /**
   * POSIX process-group ID of the spawned agent root process.
   *
   * Present only when `mode === 'pgid'`.  Use as negative-PID with kill:
   * `process.kill(-pgid, 'SIGTERM')`.
   *
   * When `mode === 'systemd'` the pgid is also populated as a fallback
   * handle (e.g. if the scope unit is unavailable at reap time).
   */
  readonly pgid?: number;

  /**
   * PID of the direct child process spawned by cleo.
   *
   * Informational — prefer `unitName` or `pgid` for reaping.
   */
  readonly pid?: number;
}

export interface AdapterSpawnProvider {
  canSpawn(): Promise<boolean>;
  spawn(context: SpawnContext): Promise<SpawnResult>;
  listRunning(): Promise<SpawnResult[]>;
  terminate(instanceId: string): Promise<void>;
}

export interface SpawnContext {
  taskId: string;
  prompt: string;
  workingDirectory?: string;
  options?: Record<string, unknown>;
  /**
   * Atomicity scope declaration for the spawned worker.
   *
   * When set to `'orchestrator-defer'`, a tier-1+ orchestrator signals that
   * the spawned worker will declare its own file scope at commit time. This
   * bypasses `E_ATOMICITY_NO_SCOPE` for the child task while preserving
   * auditability via the `atomicity_waiver` field in the returned
   * {@link AtomicityResult}.
   *
   * MUST NOT be set by tier-0 (direct user / CLI) callers — only by
   * orchestrators making delegated tier-1 dispatch calls.
   *
   * @task T9214
   */
  scope?: 'orchestrator-defer';
}

export interface SpawnResult {
  instanceId: string;
  taskId: string;
  providerId: string;
  /** Output captured from the spawned process. Optional for detached/fire-and-forget spawns. */
  output?: string;
  /** Exit code of the spawned process. Optional for detached/fire-and-forget spawns. */
  exitCode?: number;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
  startTime: string;
  endTime?: string;
  /** Error message when status is 'failed'. Contains details about what went wrong. */
  error?: string;
  /**
   * Suite containment ownership handle (T11998).
   *
   * Present when the spawn provider recorded containment info.
   * Use this to reap the entire MCP suite tree on session end or terminate().
   * Absent for legacy spawns that used detached+unref without containment.
   */
  ownership?: AgentSuiteOwnership;
}

// =============================================================================
// delegate_task JSON envelope (T9215 / W1 — ADR-070 hierarchical orchestration)
// =============================================================================

/**
 * Descriptor for a single child task within a `delegate_task` batch.
 *
 * Each child carries its task ID, agent role, and optional spawn parameters.
 * The adapter recognizer uses this to call `orchestrateSpawnExecute` for each.
 *
 * @task T9215
 */
export interface DelegateTaskChild {
  /** Task ID of the child to spawn (e.g. 'T9101'). */
  taskId: string;
  /** Agent role assigned to the child ('leaf' | 'worker'). */
  role: 'leaf' | 'worker';
  /** Subagent type for the spawn provider (e.g. 'cleo-subagent'). */
  subagent_type?: string;
  /** LLM model to use for this child (e.g. 'sonnet'). */
  model?: string;
}

/**
 * Parent identity block within a `delegate_task` envelope.
 *
 * Identifies the calling Lead agent for hierarchy validation.
 *
 * @task T9215
 */
export interface DelegateTaskParent {
  /** Task ID of the calling Lead agent. */
  taskId: string;
  /** Role of the calling agent ('orchestrator' | 'lead'). */
  role: 'orchestrator' | 'lead';
}

/**
 * Discriminated-union JSON envelope emitted by Lead agents to fan out workers.
 *
 * The `tool` field discriminates this type from arbitrary JSON in adapter
 * stdout. Adapters scan their stdout stream for lines containing this sentinel
 * and dispatch via `orchestrateSpawnExecute` for each child in `tasks`.
 *
 * Shape aligned with `ct-lead/references/spawn-pattern.md` (T9082).
 *
 * @task T9215 — W1 delegate_task wiring
 * @adr ADR-070
 */
export interface DelegateTaskEnvelope {
  /** Discriminant — always 'delegate_task'. */
  tool: 'delegate_task';
  args: {
    /** Identity of the calling Lead agent. Used for hierarchy validation. */
    parent: DelegateTaskParent;
    /** Conduit topic for wave coordination (e.g. 'epic-T9080.wave-2'). */
    conduitTopic?: string;
    /** Total timeout in seconds for the entire batch. */
    timeoutSeconds?: number;
    /** Array of child task descriptors to spawn in parallel. */
    tasks: DelegateTaskChild[];
  };
}

/**
 * Parse and validate a `delegate_task` JSON envelope from adapter stdout.
 *
 * Scans a line of stdout for the sentinel `"tool":"delegate_task"` and
 * attempts to parse the full envelope. Returns `null` if the line is not
 * a valid `DelegateTaskEnvelope` — callers should pass through non-matching
 * lines without transformation.
 *
 * Validation checks:
 * - `tool` equals `'delegate_task'`
 * - `args.tasks` is a non-empty array
 * - Each task has a non-empty `taskId`
 * - `args.parent` has a valid `taskId` and `role`
 *
 * @param line - Single line of stdout from the spawned agent process.
 * @returns Parsed envelope or `null` if the line is not a sentinel.
 *
 * @task T9215
 */
export function parseDelegateTaskEnvelope(line: string): DelegateTaskEnvelope | null {
  if (!line.includes('"delegate_task"')) return null;

  let parsed: unknown;
  try {
    // Find the first JSON object on the line
    const start = line.indexOf('{');
    const end = line.lastIndexOf('}');
    if (start === -1 || end === -1 || end <= start) return null;
    parsed = JSON.parse(line.slice(start, end + 1));
  } catch {
    return null;
  }

  if (typeof parsed !== 'object' || parsed === null) return null;
  const obj = parsed as Record<string, unknown>;

  if (obj['tool'] !== 'delegate_task') return null;

  const args = obj['args'];
  if (typeof args !== 'object' || args === null) return null;
  const argsObj = args as Record<string, unknown>;

  const tasks = argsObj['tasks'];
  if (!Array.isArray(tasks) || tasks.length === 0) return null;

  for (const t of tasks) {
    if (typeof t !== 'object' || t === null) return null;
    const task = t as Record<string, unknown>;
    if (typeof task['taskId'] !== 'string' || task['taskId'].length === 0) return null;
  }

  const parent = argsObj['parent'];
  if (typeof parent !== 'object' || parent === null) return null;
  const parentObj = parent as Record<string, unknown>;
  if (typeof parentObj['taskId'] !== 'string' || parentObj['taskId'].length === 0) return null;
  if (parentObj['role'] !== 'orchestrator' && parentObj['role'] !== 'lead') return null;

  return parsed as DelegateTaskEnvelope;
}
