/**
 * CLI command group for multi-agent orchestration operations.
 *
 * Exposes all orchestration operations as a native citty subcommand group:
 *
 *   cleo orchestrate start <epicId>       — start orchestrator session
 *   cleo orchestrate status               — epic/project status
 *   cleo orchestrate analyze <epicId>     — dependency structure analysis
 *   cleo orchestrate ready <epicId>       — parallel-safe ready tasks
 *   cleo orchestrate next <epicId>        — next task to spawn
 *   cleo orchestrate waves <epicId>       — dependency wave computation
 *   cleo orchestrate spawn <taskId>       — prepare subagent spawn context
 *   cleo orchestrate validate <taskId>    — validate subagent output
 *   cleo orchestrate context <epicId>     — orchestrator context summary
 *   cleo orchestrate ivtr <taskId>        — IVTR phased loop
 *   cleo orchestrate parallel <action> <epicId> — parallel wave execution
 *   cleo orchestrate tessera              — tessera template operations
 *   cleo orchestrate unblock              — unblocking opportunities
 *   cleo orchestrate bootstrap            — brain state for agent bootstrap
 *   cleo orchestrate classify <request>   — CANT prompt-based routing
 *   cleo orchestrate fanout-status        — fanout manifest lookup
 *   cleo orchestrate handoff <taskId>     — session handoff + successor spawn
 *   cleo orchestrate spawn-execute <taskId> — adapter-registry spawn
 *   cleo orchestrate fanout <epicId>      — parallel fan-out spawn
 *   cleo orchestrate worktree-complete <taskId> — canonical git merge --no-ff integration (ADR-062)
 *   cleo orchestrate conduit-status       — conduit messaging status (legacy, prefer `cleo conduit status`)
 *   cleo orchestrate conduit-peek         — peek queued conduit messages (legacy)
 *   cleo orchestrate conduit-start        — start conduit message loop (legacy)
 *   cleo orchestrate conduit-stop         — stop conduit message loop (legacy)
 *   cleo orchestrate conduit-send <content> — send conduit message (legacy)
 *
 * Note: T964 promoted `conduit` to its own canonical dispatch domain. The
 * `conduit-*` subcommands here remain as backward-compatible aliases that
 * dispatch to the `conduit` domain directly.
 *
 * @task T4466, T478, T483, T811, T964
 * @epic T4454
 */

import { defineCommand, showUsage } from 'citty';
import { dispatchFromCli } from '../../dispatch/adapters/cli.js';

/** cleo orchestrate start — start orchestrator session for an epic */
const startCommand = defineCommand({
  meta: { name: 'start', description: 'Start orchestrator session for an epic' },
  args: {
    epicId: {
      type: 'positional',
      description: 'Epic ID to orchestrate',
      required: true,
    },
  },
  async run({ args }) {
    await dispatchFromCli(
      'mutate',
      'orchestrate',
      'start',
      { epicId: args.epicId },
      { command: 'orchestrate' },
    );
  },
});

/** cleo orchestrate status — get orchestration status for an epic or overall project */
const statusCommand = defineCommand({
  meta: { name: 'status', description: 'Get orchestration status for an epic or overall project' },
  args: {
    epic: {
      type: 'string',
      description: 'Epic ID to scope status to',
    },
  },
  async run({ args }) {
    await dispatchFromCli(
      'query',
      'orchestrate',
      'status',
      { epicId: args.epic },
      { command: 'orchestrate' },
    );
  },
});

/** cleo orchestrate analyze — analyze epic dependency structure */
const analyzeCommand = defineCommand({
  meta: { name: 'analyze', description: 'Analyze epic dependency structure' },
  args: {
    epicId: {
      type: 'positional',
      description: 'Epic ID to analyze',
      required: true,
    },
    mode: {
      type: 'string',
      description: 'Analysis mode: critical-path or parallel-safety',
    },
    tasks: {
      type: 'string',
      description: 'Comma-separated task IDs for parallel-safety mode',
    },
  },
  async run({ args }) {
    const taskIds =
      typeof args.tasks === 'string' ? args.tasks.split(',').map((s) => s.trim()) : undefined;
    await dispatchFromCli(
      'query',
      'orchestrate',
      'analyze',
      { epicId: args.epicId, mode: args.mode, taskIds },
      { command: 'orchestrate' },
    );
  },
});

/** cleo orchestrate ready — get parallel-safe ready tasks */
const readyCommand = defineCommand({
  meta: { name: 'ready', description: 'Get parallel-safe ready tasks' },
  args: {
    epicId: {
      type: 'positional',
      description: 'Epic ID to query',
      required: true,
    },
  },
  async run({ args }) {
    await dispatchFromCli(
      'query',
      'orchestrate',
      'ready',
      { epicId: args.epicId },
      { command: 'orchestrate' },
    );
  },
});

/** cleo orchestrate next — get next task to spawn */
const nextCommand = defineCommand({
  meta: { name: 'next', description: 'Get next task to spawn' },
  args: {
    epicId: {
      type: 'positional',
      description: 'Epic ID to query',
      required: true,
    },
  },
  async run({ args }) {
    await dispatchFromCli(
      'query',
      'orchestrate',
      'next',
      { epicId: args.epicId },
      { command: 'orchestrate' },
    );
  },
});

/** cleo orchestrate waves — compute dependency waves for an epic */
const wavesCommand = defineCommand({
  meta: { name: 'waves', description: 'Compute dependency waves for an epic' },
  args: {
    epicId: {
      type: 'positional',
      description: 'Epic ID to compute waves for',
      required: true,
    },
  },
  async run({ args }) {
    await dispatchFromCli(
      'query',
      'orchestrate',
      'waves',
      { epicId: args.epicId },
      { command: 'orchestrate' },
    );
  },
});

/** cleo orchestrate plan — emit a deterministic wave+worker plan for an epic (T889 / W3-6) */
const planCommand = defineCommand({
  meta: {
    name: 'plan',
    description: 'Emit a deterministic wave+worker plan for an epic (machine-readable)',
  },
  args: {
    epicId: {
      type: 'positional',
      description: 'Epic ID to plan',
      required: true,
    },
    tier: {
      type: 'string',
      description: 'Preferred resolver tier (0=project, 1=global, 2=packaged)',
    },
  },
  async run({ args }) {
    const preferTier =
      args.tier !== undefined ? (Number.parseInt(args.tier, 10) as 0 | 1 | 2) : undefined;
    await dispatchFromCli(
      'query',
      'orchestrate',
      'plan',
      { epicId: args.epicId, preferTier },
      { command: 'orchestrate', operation: 'orchestrate.plan' },
    );
  },
});

/** cleo orchestrate spawn — prepare spawn context for a subagent */
const spawnCommand = defineCommand({
  meta: { name: 'spawn', description: 'Prepare spawn context for a subagent' },
  args: {
    taskId: {
      type: 'positional',
      description: 'Task ID to prepare spawn context for',
      required: true,
    },
    protocol: {
      type: 'string',
      description: 'Protocol type override',
    },
    tier: {
      type: 'string',
      description:
        'Protocol tier: 0 (minimal), 1 (standard), 2 (full), or auto (default — inferred from role+size+labels via T892 heuristics)',
    },
    'no-worktree': {
      type: 'boolean',
      description:
        'Skip worktree provisioning for this spawn. The opt-out is logged to the audit log (T1140).',
    },
  },
  async run({ args }) {
    // T892: --tier accepts auto|0|1|2. 'auto' (and undefined) are forwarded
    // as undefined so the engine uses resolveEffectiveTier internally.
    // Explicit numeric values (0/1/2) bypass auto-selection.
    let tier: 0 | 1 | 2 | undefined;
    if (args.tier !== undefined && args.tier !== 'auto') {
      const parsed = Number.parseInt(args.tier, 10);
      if (parsed === 0 || parsed === 1 || parsed === 2) {
        tier = parsed;
      }
    }
    await dispatchFromCli(
      'mutate',
      'orchestrate',
      'spawn',
      {
        taskId: args.taskId,
        protocolType: args.protocol,
        tier,
        noWorktree: args['no-worktree'] === true,
      },
      { command: 'orchestrate' },
    );
  },
});

/** cleo orchestrate validate — validate subagent output */
const validateCommand = defineCommand({
  meta: { name: 'validate', description: 'Validate subagent output' },
  args: {
    taskId: {
      type: 'positional',
      description: 'Task ID to validate output for',
      required: true,
    },
    file: {
      type: 'string',
      description: 'Output file path',
    },
    manifest: {
      type: 'boolean',
      description: 'Manifest entry was appended',
    },
  },
  async run({ args }) {
    await dispatchFromCli(
      'mutate',
      'orchestrate',
      'validate',
      { taskId: args.taskId, file: args.file, manifestEntry: args.manifest },
      { command: 'orchestrate' },
    );
  },
});

/** cleo orchestrate context — get orchestrator context summary */
const contextCommand = defineCommand({
  meta: { name: 'context', description: 'Get orchestrator context summary' },
  args: {
    epicId: {
      type: 'positional',
      description: 'Epic ID to get context for',
      required: true,
    },
  },
  async run({ args }) {
    await dispatchFromCli(
      'query',
      'orchestrate',
      'context',
      { epicId: args.epicId },
      { command: 'orchestrate' },
    );
  },
});

/** cleo orchestrate ivtr — drive Implement→Validate→Test phased loop */
const ivtrCommand = defineCommand({
  meta: {
    name: 'ivtr',
    description: 'Drive an Implement→Validate→Test phased loop on a task with evidence-bound gates',
  },
  args: {
    taskId: {
      type: 'positional',
      description: 'Task ID to drive IVTR loop for',
      required: true,
    },
    start: {
      type: 'boolean',
      description: 'Begin Implement phase',
    },
    next: {
      type: 'boolean',
      description: 'Advance to next phase (requires prior-phase evidence)',
    },
    status: {
      type: 'boolean',
      description: 'Show current IVTR state + history',
    },
    release: {
      type: 'boolean',
      description: 'Final gate — require I+V+T evidence, then release',
    },
    'loop-back': {
      type: 'boolean',
      description: 'Rewind to specified phase on failure',
    },
    phase: {
      type: 'string',
      description: 'Phase for --loop-back (implement|validate|test)',
    },
    reason: {
      type: 'string',
      description: 'Reason for loop-back',
    },
    evidence: {
      type: 'string',
      description: 'Attachment sha256 to attach',
    },
  },
  async run({ args }) {
    const action = args.start
      ? 'start'
      : args.next
        ? 'next'
        : args.release
          ? 'release'
          : args['loop-back']
            ? 'loop-back'
            : 'status';
    const kind = action === 'status' ? 'query' : 'mutate';
    await dispatchFromCli(
      kind,
      'orchestrate',
      `ivtr.${action}`,
      { taskId: args.taskId, phase: args.phase, reason: args.reason, evidence: args.evidence },
      { command: 'orchestrate' },
    );
  },
});

/** cleo orchestrate parallel — manage parallel wave execution */
const parallelCommand = defineCommand({
  meta: { name: 'parallel', description: 'Manage parallel wave execution (action: start | end)' },
  args: {
    action: {
      type: 'positional',
      description: 'Action to perform: start or end',
      required: true,
    },
    epicId: {
      type: 'positional',
      description: 'Epic ID for wave execution',
      required: true,
    },
    wave: {
      type: 'string',
      description: 'Wave number',
    },
  },
  async run({ args }) {
    await dispatchFromCli(
      'mutate',
      'orchestrate',
      'parallel',
      {
        action: args.action,
        epicId: args.epicId,
        wave: args.wave !== undefined ? Number.parseInt(args.wave, 10) : undefined,
      },
      { command: 'orchestrate' },
    );
  },
});

/** cleo orchestrate tessera list — list available tessera templates */
const tesseraListCommand = defineCommand({
  meta: { name: 'list', description: 'List available tessera templates' },
  args: {
    id: {
      type: 'string',
      description: 'Show details for a specific template',
    },
    limit: {
      type: 'string',
      description: 'Max results to return',
    },
    offset: {
      type: 'string',
      description: 'Results offset for pagination',
    },
  },
  async run({ args }) {
    await dispatchFromCli(
      'query',
      'orchestrate',
      'tessera.list',
      {
        id: args.id,
        limit: args.limit !== undefined ? Number.parseInt(args.limit, 10) : undefined,
        offset: args.offset !== undefined ? Number.parseInt(args.offset, 10) : undefined,
      },
      { command: 'orchestrate' },
    );
  },
});

/** cleo orchestrate tessera instantiate — instantiate a tessera template for an epic */
const tesseraInstantiateCommand = defineCommand({
  meta: { name: 'instantiate', description: 'Instantiate a tessera template for an epic' },
  args: {
    templateId: {
      type: 'positional',
      description: 'Template ID to instantiate',
      required: true,
    },
    epicId: {
      type: 'positional',
      description: 'Epic ID to instantiate template for',
      required: true,
    },
    var: {
      type: 'string',
      description: 'Comma-separated key=value variable overrides (e.g. foo=bar,baz=qux)',
    },
  },
  async run({ args }) {
    const variables: Record<string, string> = {};
    const raw = args.var;
    if (typeof raw === 'string') {
      for (const pair of raw.split(',')) {
        const eqIdx = pair.indexOf('=');
        if (eqIdx > 0) {
          variables[pair.slice(0, eqIdx).trim()] = pair.slice(eqIdx + 1).trim();
        }
      }
    }
    await dispatchFromCli(
      'mutate',
      'orchestrate',
      'tessera.instantiate',
      { templateId: args.templateId, epicId: args.epicId, variables },
      { command: 'orchestrate' },
    );
  },
});

/**
 * cleo orchestrate tessera — tessera template operations for multi-agent orchestration.
 */
const tesseraCommand = defineCommand({
  meta: {
    name: 'tessera',
    description: 'Tessera template operations for multi-agent orchestration',
  },
  subCommands: {
    list: tesseraListCommand,
    instantiate: tesseraInstantiateCommand,
  },
});

/** cleo orchestrate unblock — analyze dependency graph for unblocking opportunities */
const unblockCommand = defineCommand({
  meta: { name: 'unblock', description: 'Analyze dependency graph for unblocking opportunities' },
  async run() {
    await dispatchFromCli(
      'query',
      'orchestrate',
      'unblock.opportunities',
      {},
      { command: 'orchestrate' },
    );
  },
});

/** cleo orchestrate bootstrap — load brain state for agent bootstrapping */
const bootstrapCommand = defineCommand({
  meta: { name: 'bootstrap', description: 'Load brain state for agent bootstrapping' },
  args: {
    epic: {
      type: 'string',
      description: 'Epic ID to scope bootstrap context to',
    },
  },
  async run({ args }) {
    await dispatchFromCli(
      'query',
      'orchestrate',
      'bootstrap',
      { epicId: args.epic },
      { command: 'orchestrate' },
    );
  },
});

/** cleo orchestrate classify — classify a request using CANT prompt-based team routing */
const classifyCommand = defineCommand({
  meta: {
    name: 'classify',
    description: 'Classify a request using CANT prompt-based team routing',
  },
  args: {
    request: {
      type: 'positional',
      description: 'Request text to classify',
      required: true,
    },
  },
  async run({ args }) {
    await dispatchFromCli(
      'query',
      'orchestrate',
      'classify',
      { request: args.request },
      { command: 'orchestrate' },
    );
  },
});

/** cleo orchestrate fanout-status — get fanout status by manifest entry ID */
const fanoutStatusCommand = defineCommand({
  meta: { name: 'fanout-status', description: 'Get fanout status by manifest entry ID' },
  args: {
    'manifest-entry-id': {
      type: 'string',
      description: 'Manifest entry ID returned by orchestrate.fanout',
      required: true,
    },
  },
  async run({ args }) {
    await dispatchFromCli(
      'query',
      'orchestrate',
      'fanout.status',
      { manifestEntryId: args['manifest-entry-id'] },
      { command: 'orchestrate' },
    );
  },
});

/** cleo orchestrate handoff — perform session handoff and spawn successor */
const handoffCommand = defineCommand({
  meta: { name: 'handoff', description: 'Perform session handoff and spawn successor for a task' },
  args: {
    taskId: {
      type: 'positional',
      description: 'Task ID to hand off',
      required: true,
    },
    protocol: {
      type: 'string',
      description: 'Protocol type for handoff',
      required: true,
    },
  },
  async run({ args }) {
    await dispatchFromCli(
      'mutate',
      'orchestrate',
      'handoff',
      { taskId: args.taskId, protocolType: args.protocol },
      { command: 'orchestrate' },
    );
  },
});

/** cleo orchestrate spawn-execute — execute spawn for a task via the adapter registry */
const spawnExecuteCommand = defineCommand({
  meta: { name: 'spawn-execute', description: 'Execute spawn for a task via the adapter registry' },
  args: {
    taskId: {
      type: 'positional',
      description: 'Task ID to execute spawn for',
      required: true,
    },
  },
  async run({ args }) {
    await dispatchFromCli(
      'mutate',
      'orchestrate',
      'spawn.execute',
      { taskId: args.taskId },
      { command: 'orchestrate' },
    );
  },
});

/** cleo orchestrate fanout — fan out tasks for an epic using parallel spawn */
const fanoutCommand = defineCommand({
  meta: { name: 'fanout', description: 'Fan out tasks for an epic using parallel spawn' },
  args: {
    epicId: {
      type: 'positional',
      description: 'Epic ID to fan out',
      required: true,
    },
    tasks: {
      type: 'string',
      description: 'Comma-separated task IDs to fan out',
    },
  },
  async run({ args }) {
    const taskIds =
      typeof args.tasks === 'string' ? args.tasks.split(',').map((s) => s.trim()) : undefined;
    const items = taskIds ? taskIds.map((taskId) => ({ taskId, team: 'default' })) : undefined;
    await dispatchFromCli(
      'mutate',
      'orchestrate',
      'fanout',
      { epicId: args.epicId, items },
      { command: 'orchestrate' },
    );
  },
});

/**
 * cleo orchestrate prune — remove stale agent worktrees after task completion.
 *
 * Without a task ID, prunes all orphaned worktrees for the project.
 * With a task ID, prunes that specific worktree (unlocks, removes dir, deletes branch
 * if no commits are ahead of the current HEAD).
 *
 * Safe to call on already-clean repos — returns `status: 'skipped'` when there is
 * nothing to remove.
 *
 * @task T1462
 * @adr ADR-055
 */
const pruneCommand = defineCommand({
  meta: {
    name: 'prune',
    description: 'Remove stale agent worktrees (after task completion or crash)',
  },
  args: {
    taskId: {
      type: 'positional',
      description: 'Task ID whose worktree should be pruned (omit for bulk prune)',
      required: false,
    },
  },
  async run({ args }) {
    const taskId =
      typeof args.taskId === 'string' && args.taskId.length > 0 ? args.taskId : undefined;
    await dispatchFromCli(
      'mutate',
      'orchestrate',
      'worktree.prune',
      { taskId },
      { command: 'orchestrate' },
    );
  },
});

/**
 * cleo orchestrate worktree-complete — integrate a subagent worktree branch into the
 * project's default branch using canonical `git merge --no-ff` (ADR-062).
 *
 * Exposes the existing `worktree.complete` dispatch handler
 * ({@link handleWorktreeComplete} in `dispatch/domains/orchestrate.ts`) as a
 * first-class CLI subcommand so orchestrators can run a single deterministic
 * command instead of composing `git merge --no-ff task/<id>` manually.
 *
 * The handler delegates to {@link completeAgentWorktreeViaMerge} from
 * `@cleocode/core/internal`, which:
 *  - Rebases `task/<taskId>` onto the default branch (fast-forward, no conflict risk)
 *  - Merges with `--no-ff` to preserve all agent commit SHAs and authorship
 *  - Deletes the worktree filesystem entry and the `task/<taskId>` branch
 *
 * Returns the structured {@link WorktreeMergeResult} (mergeCommit, branchDeleted,
 * commitCount, etc.) as a LAFS envelope on stdout.
 *
 * ADR-062: `git merge --no-ff` is the ONLY canonical integration strategy for
 * agent worktrees. Cherry-pick is explicitly forbidden — it destroys commit SHAs
 * and breaks `git log --grep "<taskId>"` traceability.
 *
 * @task T1625
 * @adr ADR-062
 */
const worktreeCompleteCommand = defineCommand({
  meta: {
    name: 'worktree-complete',
    description:
      'Integrate subagent worktree into default branch via canonical git merge --no-ff (ADR-062)',
  },
  args: {
    taskId: {
      type: 'positional',
      description: 'Task ID whose worktree branch should be merged (e.g. T1625)',
      required: true,
    },
  },
  async run({ args }) {
    await dispatchFromCli(
      'mutate',
      'orchestrate',
      'worktree.complete',
      { taskId: args.taskId },
      { command: 'orchestrate' },
    );
  },
});

/**
 * cleo orchestrate conduit-status — legacy alias for `cleo conduit status`.
 *
 * T964: dispatches to the canonical `conduit` domain. The `conduit-*`
 * orchestrate subcommands are kept for backward compatibility; prefer the
 * top-level `cleo conduit <verb>` command group.
 */
const conduitStatusCommand = defineCommand({
  meta: { name: 'conduit-status', description: 'Get conduit messaging status' },
  async run() {
    await dispatchFromCli('query', 'conduit', 'status', {}, { command: 'orchestrate' });
  },
});

/**
 * cleo orchestrate conduit-peek — legacy alias for `cleo conduit peek`.
 *
 * T964: dispatches to the canonical `conduit` domain.
 */
const conduitPeekCommand = defineCommand({
  meta: { name: 'conduit-peek', description: 'Peek at queued conduit messages' },
  args: {
    limit: {
      type: 'string',
      description: 'Maximum number of messages to return',
    },
  },
  async run({ args }) {
    await dispatchFromCli(
      'query',
      'conduit',
      'peek',
      { limit: args.limit !== undefined ? Number.parseInt(args.limit, 10) : undefined },
      { command: 'orchestrate' },
    );
  },
});

/**
 * cleo orchestrate conduit-start — legacy alias for `cleo conduit start`.
 *
 * T964: dispatches to the canonical `conduit` domain.
 */
const conduitStartCommand = defineCommand({
  meta: { name: 'conduit-start', description: 'Start the conduit message loop' },
  args: {
    'poll-interval': {
      type: 'string',
      description: 'Polling interval in milliseconds',
    },
  },
  async run({ args }) {
    await dispatchFromCli(
      'mutate',
      'conduit',
      'start',
      {
        pollIntervalMs:
          args['poll-interval'] !== undefined
            ? Number.parseInt(args['poll-interval'], 10)
            : undefined,
      },
      { command: 'orchestrate' },
    );
  },
});

/**
 * cleo orchestrate conduit-stop — legacy alias for `cleo conduit stop`.
 *
 * T964: dispatches to the canonical `conduit` domain.
 */
const conduitStopCommand = defineCommand({
  meta: { name: 'conduit-stop', description: 'Stop the conduit message loop' },
  async run() {
    await dispatchFromCli('mutate', 'conduit', 'stop', {}, { command: 'orchestrate' });
  },
});

/** cleo orchestrate approve — approve a pending HITL playbook gate (T935) */
const approveCommand = defineCommand({
  meta: {
    name: 'approve',
    description: 'Approve a pending HITL playbook approval gate by its resume token',
  },
  args: {
    resumeToken: {
      type: 'positional',
      description: 'HMAC-signed resume token returned when the gate was created',
      required: true,
    },
    reason: {
      type: 'string',
      description: 'Optional justification note recorded on the audit row',
    },
    approver: {
      type: 'string',
      description: 'Identity of the approver (defaults to cli-user)',
    },
  },
  async run({ args }) {
    await dispatchFromCli(
      'mutate',
      'orchestrate',
      'approve',
      {
        resumeToken: args.resumeToken,
        reason: args.reason,
        approver: args.approver,
      },
      { command: 'orchestrate' },
    );
  },
});

/** cleo orchestrate reject — reject a pending HITL playbook gate with a mandatory reason (T935) */
const rejectCommand = defineCommand({
  meta: {
    name: 'reject',
    description: 'Reject a pending HITL playbook approval gate with a mandatory reason',
  },
  args: {
    resumeToken: {
      type: 'positional',
      description: 'HMAC-signed resume token returned when the gate was created',
      required: true,
    },
    reason: {
      type: 'string',
      description: 'Justification for the rejection (mandatory, recorded on the audit row)',
      required: true,
    },
    approver: {
      type: 'string',
      description: 'Identity of the rejector (defaults to cli-user)',
    },
  },
  async run({ args }) {
    await dispatchFromCli(
      'mutate',
      'orchestrate',
      'reject',
      {
        resumeToken: args.resumeToken,
        reason: args.reason,
        approver: args.approver,
      },
      { command: 'orchestrate' },
    );
  },
});

/** cleo orchestrate pending — list all pending HITL playbook approvals (T935) */
const pendingCommand = defineCommand({
  meta: {
    name: 'pending',
    description: 'List all pending HITL playbook approval gates awaiting a decision',
  },
  async run() {
    await dispatchFromCli('query', 'orchestrate', 'pending', {}, { command: 'orchestrate' });
  },
});

/**
 * cleo orchestrate conduit-send — legacy alias for `cleo conduit send`.
 *
 * T964: dispatches to the canonical `conduit` domain.
 */
const conduitSendCommand = defineCommand({
  meta: {
    name: 'conduit-send',
    description: 'Send a message via conduit to an agent or conversation',
  },
  args: {
    content: {
      type: 'positional',
      description: 'Message content to send',
      required: true,
    },
    to: {
      type: 'string',
      description: 'Target agent ID',
    },
    conversation: {
      type: 'string',
      description: 'Conversation ID to send into',
    },
  },
  async run({ args }) {
    await dispatchFromCli(
      'mutate',
      'conduit',
      'send',
      { content: args.content, to: args.to, conversationId: args.conversation },
      { command: 'orchestrate' },
    );
  },
});

/**
 * Root orchestrate command group — all 25 multi-agent orchestration operations.
 *
 * Dispatches to the `orchestrate` and `pipeline` dispatch domains.
 *
 * @task T4466, T478, T483, T811, T1625
 * @epic T4454
 */
export const orchestrateCommand = defineCommand({
  meta: { name: 'orchestrate', description: 'Multi-agent orchestration commands' },
  subCommands: {
    start: startCommand,
    status: statusCommand,
    analyze: analyzeCommand,
    ready: readyCommand,
    next: nextCommand,
    waves: wavesCommand,
    plan: planCommand,
    spawn: spawnCommand,
    validate: validateCommand,
    context: contextCommand,
    ivtr: ivtrCommand,
    parallel: parallelCommand,
    tessera: tesseraCommand,
    unblock: unblockCommand,
    bootstrap: bootstrapCommand,
    classify: classifyCommand,
    'fanout-status': fanoutStatusCommand,
    handoff: handoffCommand,
    'spawn-execute': spawnExecuteCommand,
    fanout: fanoutCommand,
    prune: pruneCommand,
    'worktree-complete': worktreeCompleteCommand,
    'conduit-status': conduitStatusCommand,
    'conduit-peek': conduitPeekCommand,
    'conduit-start': conduitStartCommand,
    'conduit-stop': conduitStopCommand,
    'conduit-send': conduitSendCommand,
    // T935: HITL playbook approval gates
    approve: approveCommand,
    reject: rejectCommand,
    pending: pendingCommand,
  },
  async run({ cmd, rawArgs }) {
    const firstArg = rawArgs?.find((a) => !a.startsWith('-'));
    if (firstArg && cmd.subCommands && firstArg in cmd.subCommands) return;
    await showUsage(cmd);
  },
});
