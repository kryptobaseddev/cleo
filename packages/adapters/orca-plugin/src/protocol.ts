/**
 * Panel <-> worker contract of the CLEO Orca plugin (T14462).
 *
 * `src/panel.tsx` and `src/worker.ts` both read these types. The plugin folder
 * is self-contained by Orca's packaging rules (no bundler, no `node_modules`),
 * so it cannot import `@cleocode/contracts`: the worker treats every CLI
 * envelope as untrusted JSON and narrows it into the view types below.
 *
 * Everything here is a `type` alias (never an `interface`) so each payload
 * stays assignable to Orca's JSON value type.
 */

/** Epic status the panel filters the top-level list by; `all` sends no filter. */
export type TaskStatusFilter = 'active' | 'pending' | 'blocked' | 'done' | 'all';

/**
 * The explicit workspace choice: Orca's workspace id plus the host and path it
 * named when the person chose it. The worker re-checks all three against a
 * fresh `workspace.list` before every read.
 */
export type WorkspaceSelection = {
  id: string;
  hostId: string | null;
  path: string;
};

/** One row of the workspace picker. */
export type WorkspaceOption = WorkspaceSelection & {
  name: string;
  branch: string | null;
  /** Picker text; carries the path when two workspaces share a name. */
  label: string;
  /** Why CLEO cannot be read there, or `null` when the workspace is selectable. */
  blocked: 'remote' | 'duplicate-id' | null;
  /** True for the one workspace the focused Orca workspace matches exactly. */
  focused: boolean;
};

/** How Orca's focused workspace relates to the listed workspaces. A hint only. */
export type FocusHint = {
  /** Display name of the focused workspace, or `null` when none is focused. */
  name: string | null;
  /** Listed workspaces matching it; above 1 the focus is ambiguous. */
  matches: number;
};

/** Why a read produced no data. */
export type CleoFailureCode =
  | 'cleo-missing'
  | 'not-a-project'
  | 'timeout'
  | 'cancelled'
  | 'malformed-envelope'
  | 'output-too-large'
  | 'cli-error'
  | 'workspace-unavailable'
  | 'workspace-remote'
  | 'workspace-changed'
  | 'invalid-request'
  | 'host-error';

/** A read that failed, with a message safe to show as is. */
export type CleoFailure = {
  ok: false;
  code: CleoFailureCode;
  message: string;
};

/** Answer to `cleo.workspaces`. */
export type WorkspaceList = {
  ok: true;
  workspaces: WorkspaceOption[];
  /** Orca listed only part of its workspaces. */
  truncated: boolean;
  focus: FocusHint;
};

/** One task or epic as the tree shows it. */
export type TaskRow = {
  id: string;
  title: string;
  status: string;
  type: string;
  priority: string | null;
  parentId: string | null;
};

/** Input of `cleo.tasks`: epics of a workspace, or the children of one task. */
export type TaskListRequest = {
  selection: WorkspaceSelection;
  /** Lists this task's direct children; omitted lists epics. */
  parentId?: string;
  /** Applies to the epic list only. */
  status?: TaskStatusFilter;
  /** Rows to skip, for the page after a truncated one. */
  offset?: number;
};

/** Answer to `cleo.tasks`: one bounded page. */
export type TaskPage = {
  ok: true;
  tasks: TaskRow[];
  /** Rows matching the filter in the store. */
  matched: number;
  /** More rows match than this page (and the ones before it) returned. */
  truncated: boolean;
  offset: number;
};

/** One acceptance criterion and the gates whose evidence names it. */
export type AcceptanceRow = {
  alias: string;
  text: string;
  /** Gates carrying a `satisfies` atom for this criterion. */
  gates: string[];
};

/** One evidence gate of a task. */
export type GateRow = {
  gate: string;
  passed: boolean;
  /** Evidence atom kinds recorded for the gate, e.g. `commit, files, satisfies x2`. */
  atoms: string;
  capturedAt: string | null;
};

/** The worker claim CLEO holds on a task. */
export type WorkerClaim = {
  agentId: string | null;
  sessionId: string | null;
  claimedAt: string | null;
  leaseExpiresAt: string | null;
};

/** Input of `cleo.task`. */
export type TaskDetailRequest = {
  selection: WorkspaceSelection;
  taskId: string;
};

/** Answer to `cleo.task`: one task with acceptance, evidence and worker state. */
export type TaskDetail = {
  ok: true;
  task: TaskRow & {
    description: string;
    size: string | null;
    pipelineStage: string | null;
    /** Direct children, from CLEO's relation counts. */
    children: number;
    updatedAt: string | null;
  };
  acceptance: AcceptanceRow[];
  gates: GateRow[];
  /** CLEO's own verdict that every gate passed. */
  verificationPassed: boolean;
  /** `null` when no worker holds the task. */
  claim: WorkerClaim | null;
  nextAction: string | null;
};

declare module 'orca' {
  interface PluginRequests {
    /** Orca's workspaces as picker rows; remote ones are listed but blocked. */
    'cleo.workspaces': { output: WorkspaceList | CleoFailure };
    /** One bounded `cleo list` page for the chosen local workspace. */
    'cleo.tasks': { input: TaskListRequest; output: TaskPage | CleoFailure };
    /** One bounded `cleo show --full` for the chosen local workspace. */
    'cleo.task': { input: TaskDetailRequest; output: TaskDetail | CleoFailure };
  }
  interface PluginPanelEvents {
    /** Posted by the `cleo.refresh` palette command: open panels reload. */
    'cleo.refresh': { requestedAt: number };
  }
}
