// `orca plugin check` renders the panel once per scenario. Every scenario stands in for the
// worker's CLEO reads (`requests`), so check never starts a `cleo` process; `remoteOnly` leaves
// `cleo.workspaces` to the real worker over the stand-in host's workspace list.
import { defineCheck } from 'orca/testing';
import type { TaskPage, WorkspaceList, WorkspaceOption, WorkspaceSelection } from './protocol.ts';

const CHOSEN: WorkspaceSelection = { id: 'ws-app', hostId: 'local', path: '/work/app' };
const LOCAL: WorkspaceOption = {
  ...CHOSEN,
  name: 'app',
  branch: 'main',
  label: 'app — /work/app',
  blocked: null,
  focused: false,
};
const TWIN: WorkspaceOption = {
  ...LOCAL,
  id: 'ws-twin',
  path: '/work/app-2',
  label: 'app — /work/app-2',
};
const REMOTE: WorkspaceOption = {
  id: 'ws-ssh',
  hostId: 'ssh:build',
  path: '/srv/app',
  name: 'server',
  branch: 'main',
  label: 'server (remote: ssh:build)',
  blocked: 'remote',
  focused: false,
};

const listing = (workspaces: WorkspaceOption[], matches = 0): WorkspaceList => ({
  ok: true,
  workspaces,
  truncated: false,
  focus: { name: matches > 0 ? 'app' : null, matches },
});

const epics: TaskPage = {
  ok: true,
  tasks: [
    {
      id: 'T100',
      title: 'Orca integration',
      status: 'active',
      type: 'epic',
      priority: 'high',
      parentId: null,
    },
    {
      id: 'T200',
      title: 'Docs never rot',
      status: 'active',
      type: 'epic',
      priority: 'medium',
      parentId: null,
    },
  ],
  matched: 120,
  truncated: true,
  offset: 0,
};

const chosen = { plugin: { selection: CHOSEN } };

export default defineCheck({
  noWorkspaces: { requests: { 'cleo.workspaces': listing([]) } },
  ambiguousFocus: { requests: { 'cleo.workspaces': listing([LOCAL, TWIN, REMOTE], 2) } },
  remoteOnly: {
    results: {
      'workspace.list': {
        workspaces: [
          {
            id: 'ws-ssh',
            kind: 'worktree',
            name: 'server',
            path: '/srv/app',
            branch: 'main',
            hostId: 'ssh:build',
          },
        ],
        truncated: true,
      },
      'workspace.readContext': null,
    },
  },
  truncatedEpics: {
    persisted: chosen,
    requests: { 'cleo.workspaces': listing([LOCAL, REMOTE]), 'cleo.tasks': epics },
  },
  noEpics: {
    persisted: chosen,
    requests: {
      'cleo.workspaces': listing([LOCAL]),
      'cleo.tasks': { ...epics, tasks: [], matched: 0, truncated: false },
    },
  },
  cleoMissing: {
    persisted: chosen,
    requests: {
      'cleo.workspaces': listing([LOCAL]),
      'cleo.tasks': {
        ok: false,
        code: 'cleo-missing',
        message: 'The CLEO CLI ("cleo") was not found on this machine\'s PATH.',
      },
    },
  },
});
