/**
 * Unit tests for `cleo sentient propose accept <id>` execute-action flow
 * (T9898 · Epic T9861 · Saga T9855 / E6.4).
 *
 * Covers:
 *   - `--execute` runs the fixAction without prompting
 *   - default flow prompts and respects an `n` reply
 *   - `--no-execute` short-circuits even when fixAction is present
 *   - unsafe fixAction → `E_SENTIENT_UNSAFE_ACTION`
 *   - audit log appends one JSON line per execution
 *   - missing proposal → `E_NOT_FOUND`
 *
 * All DB, child-process spawn, and stats writes are mocked so no real
 * SQLite, file IO, or subprocess is touched.
 *
 * @task T9898
 * @epic T9861
 */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks — DB layer
// ---------------------------------------------------------------------------

interface MockTaskRow {
  id: string;
  status: string;
  labelsJson: string;
  notesJson: string | null;
}

const dbState: { row: MockTaskRow | null } = { row: null };

const mockGetDb = vi.fn(async () => ({
  select: () => ({
    from: () => ({
      where: () => ({
        get: () => (dbState.row ? { ...dbState.row } : undefined),
      }),
    }),
  }),
  update: () => ({
    set: () => ({
      where: () => ({
        run: () => {
          if (dbState.row) dbState.row.status = 'pending';
        },
      }),
    }),
  }),
}));

vi.mock('@cleocode/core/store/sqlite.js', () => ({
  getDb: (...args: unknown[]) => mockGetDb(...args),
}));

vi.mock('@cleocode/core/store/tasks-schema', () => ({
  tasks: {
    id: 'id',
    status: 'status',
    labelsJson: 'labels_json',
  },
}));

vi.mock('drizzle-orm', () => ({
  and: (...args: unknown[]) => ({ _and: args }),
  eq: (a: unknown, b: unknown) => ({ _eq: [a, b] }),
  like: (a: unknown, b: unknown) => ({ _like: [a, b] }),
}));

// ---------------------------------------------------------------------------
// Mocks — sentient state
// ---------------------------------------------------------------------------

vi.mock('@cleocode/core/sentient/state.js', () => ({
  readSentientState: vi.fn(async () => ({
    tier2Stats: { proposalsAccepted: 0, proposalsRejected: 0, proposalsGenerated: 0 },
  })),
  patchSentientState: vi.fn(async () => ({})),
}));

vi.mock('@cleocode/core/sentient/daemon.js', () => ({
  SENTIENT_STATE_FILE: '.cleo/sentient-state.json',
  getSentientDaemonStatus: vi.fn(),
  monitorWorkers: vi.fn(),
  RUNAWAY_BUDGET_MULTIPLIER: 1,
  resumeSentientDaemon: vi.fn(),
  spawnSentientDaemon: vi.fn(),
  stopSentientDaemon: vi.fn(),
  WORKER_BUDGET_MS: 60_000,
}));

vi.mock('@cleocode/core/sentient/propose-tick.js', () => ({
  safeRunProposeTick: vi.fn(),
}));

vi.mock('@cleocode/core/sentient/tick.js', () => ({
  safeRunTick: vi.fn(),
}));

vi.mock('@cleocode/core/store/skills-store.js', () => ({
  getSkillPatch: vi.fn(),
  getSkillReview: vi.fn(),
  listSkillReviews: vi.fn(),
  markSkillPatchRejected: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Mocks — execute-action (spawn injection)
// ---------------------------------------------------------------------------

const mockSpawn = vi.fn(async () => ({ exitCode: 0, stderr: '' }));

vi.mock('@cleocode/core/sentient/execute-action.js', async () => {
  const actual = await vi.importActual<typeof import('@cleocode/core/sentient/execute-action.js')>(
    '@cleocode/core/sentient/execute-action.js',
  );
  return {
    ...actual,
    executeFixAction: async (
      parsed: { cmd: string; argv: readonly string[] },
      options: { cwd: string; stderrSnippetLimit?: number },
    ) => {
      const { exitCode, stderr } = await mockSpawn(parsed.cmd, parsed.argv, options.cwd);
      return {
        executed: true,
        exitCode,
        durationMs: 1,
        stderrSnippet: stderr,
      };
    },
  };
});

// ---------------------------------------------------------------------------
// Mocks — renderers (capture envelopes)
// ---------------------------------------------------------------------------

interface CapturedOutput {
  payload: unknown;
  message?: string;
}
const captured: { outputs: CapturedOutput[]; errors: Array<{ message: string; code: string }> } = {
  outputs: [],
  errors: [],
};

vi.mock('../../renderers/index.js', () => ({
  cliOutput: (payload: unknown, opts?: { message?: string }) => {
    captured.outputs.push({ payload, message: opts?.message });
  },
  cliError: (message: string, code: string) => {
    captured.errors.push({ message, code });
  },
  humanWarn: vi.fn(),
  humanLine: vi.fn(),
}));

// process.exit must not actually exit during tests.
const originalExit = process.exit;
let exitCalls = 0;
beforeEach(() => {
  exitCalls = 0;
  // @ts-expect-error — stub
  process.exit = (() => {
    exitCalls += 1;
    throw new Error('__test_exit__');
  }) as never;
});
afterEach(() => {
  process.exit = originalExit;
});

// ---------------------------------------------------------------------------
// Lazy import (after mocks installed)
// ---------------------------------------------------------------------------

async function getAcceptRun(): Promise<(ctx: { args: Record<string, unknown> }) => Promise<void>> {
  const mod = await import('../sentient.js');
  const sentient = mod.sentientCommand as unknown as {
    subCommands: {
      propose: {
        subCommands: {
          accept: { run: (ctx: { args: Record<string, unknown> }) => Promise<void> };
        };
      };
    };
  };
  return sentient.subCommands.propose.subCommands.accept.run;
}

async function setPromptResponse(reply: boolean): Promise<() => void> {
  const mod = await import('../sentient.js');
  return mod.__setPromptAcceptExecutionForTest(async () => reply);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeProposalRow(fixAction: string | null): MockTaskRow {
  const notes =
    fixAction === null
      ? '[]'
      : JSON.stringify([
          JSON.stringify({
            kind: 'proposal-meta',
            proposedBy: 'sentient-tier2',
            source: 'template-drift',
            sourceId: 'tmpl-x',
            weight: 0.5,
            proposedAt: '2026-05-24T00:00:00Z',
            dedupHash: 'abc',
            fixAction,
          }),
        ]);
  return {
    id: 'prop-1',
    status: 'proposed',
    labelsJson: JSON.stringify(['sentient-tier2', 'source:template-drift']),
    notesJson: notes,
  };
}

let tmpRoot: string;
beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'sentient-execute-t9898-'));
  captured.outputs = [];
  captured.errors = [];
  mockSpawn.mockReset();
  mockSpawn.mockResolvedValue({ exitCode: 0, stderr: '' });
  dbState.row = null;
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('cleo sentient propose accept --execute (T9898)', () => {
  it('runs the fixAction without prompting when --execute is set', async () => {
    dbState.row = makeProposalRow('cleo templates upgrade tmpl-x');
    const run = await getAcceptRun();

    await run({ args: { id: 'prop-1', project: tmpRoot, execute: true } });

    expect(mockSpawn).toHaveBeenCalledTimes(1);
    expect(mockSpawn.mock.calls[0][0]).toBe('cleo');
    expect(mockSpawn.mock.calls[0][1]).toEqual(['templates', 'upgrade', 'tmpl-x']);
    expect(captured.errors).toHaveLength(0);
    const last = captured.outputs.at(-1)?.payload as { executed: boolean };
    expect(last?.executed).toBe(true);
  });

  it('appends one audit log entry after execution', async () => {
    dbState.row = makeProposalRow('cleo init --refresh-context');
    const run = await getAcceptRun();

    await run({ args: { id: 'prop-1', project: tmpRoot, execute: true } });

    const auditPath = join(tmpRoot, '.cleo/audit/sentient-execute.jsonl');
    const content = readFileSync(auditPath, 'utf8').trim();
    expect(content.split('\n')).toHaveLength(1);
    const entry = JSON.parse(content);
    expect(entry.proposalId).toBe('prop-1');
    expect(entry.fixAction).toBe('cleo init --refresh-context');
    expect(entry.exitCode).toBe(0);
    expect(typeof entry.durationMs).toBe('number');
    expect(typeof entry.timestamp).toBe('string');
  });
});

describe('cleo sentient propose accept (prompt path) (T9898)', () => {
  it('prompts and respects an "n" reply (no execution, no audit)', async () => {
    dbState.row = makeProposalRow('cleo templates upgrade tmpl-x');
    const restore = await setPromptResponse(false);
    try {
      const run = await getAcceptRun();
      await run({ args: { id: 'prop-1', project: tmpRoot } });
    } finally {
      restore();
    }

    expect(mockSpawn).not.toHaveBeenCalled();
    expect(captured.errors).toHaveLength(0);
    const last = captured.outputs.at(-1)?.payload as { executed: boolean };
    expect(last?.executed).toBe(false);
  });

  it('prompts and executes on a "y" reply', async () => {
    dbState.row = makeProposalRow('pnpm run build');
    const restore = await setPromptResponse(true);
    try {
      const run = await getAcceptRun();
      await run({ args: { id: 'prop-1', project: tmpRoot } });
    } finally {
      restore();
    }

    expect(mockSpawn).toHaveBeenCalledTimes(1);
    expect(mockSpawn.mock.calls[0][0]).toBe('pnpm');
  });
});

describe('cleo sentient propose accept --no-execute (T9898)', () => {
  it('skips execution even when fixAction is present', async () => {
    dbState.row = makeProposalRow('cleo templates upgrade tmpl-x');
    const run = await getAcceptRun();

    await run({ args: { id: 'prop-1', project: tmpRoot, 'no-execute': true } });

    expect(mockSpawn).not.toHaveBeenCalled();
    const last = captured.outputs.at(-1)?.payload as { executed: boolean };
    expect(last?.executed).toBe(false);
  });
});

describe('cleo sentient propose accept — safety guard (T9898)', () => {
  it('rejects unsafe fixAction (not starting with cleo or pnpm)', async () => {
    dbState.row = makeProposalRow('rm -rf /');
    const run = await getAcceptRun();

    await expect(run({ args: { id: 'prop-1', project: tmpRoot, execute: true } })).rejects.toThrow(
      '__test_exit__',
    );

    expect(mockSpawn).not.toHaveBeenCalled();
    expect(captured.errors.length).toBeGreaterThanOrEqual(1);
    expect(captured.errors[0].code).toBe('E_SENTIENT_UNSAFE_ACTION');
  });

  it('rejects fixAction with shell metacharacters', async () => {
    dbState.row = makeProposalRow('cleo templates upgrade tmpl-x; rm -rf /');
    const run = await getAcceptRun();

    await expect(run({ args: { id: 'prop-1', project: tmpRoot, execute: true } })).rejects.toThrow(
      '__test_exit__',
    );

    expect(captured.errors[0].code).toBe('E_SENTIENT_UNSAFE_ACTION');
  });
});

describe('cleo sentient propose accept — missing proposal (T9898)', () => {
  it('returns E_NOT_FOUND when the task does not exist', async () => {
    dbState.row = null;
    const run = await getAcceptRun();

    await expect(
      run({ args: { id: 'prop-missing', project: tmpRoot, execute: true } }),
    ).rejects.toThrow('__test_exit__');

    expect(captured.errors.length).toBeGreaterThanOrEqual(1);
    expect(captured.errors[0].code).toBe('E_NOT_FOUND');
  });
});

describe('cleo sentient propose accept — no fixAction (T9898)', () => {
  it('accepts cleanly when proposal has no fixAction', async () => {
    dbState.row = makeProposalRow(null);
    const run = await getAcceptRun();

    await run({ args: { id: 'prop-1', project: tmpRoot, execute: true } });

    expect(mockSpawn).not.toHaveBeenCalled();
    expect(captured.errors).toHaveLength(0);
    const last = captured.outputs.at(-1)?.payload as {
      executed: boolean;
      fixAction: string | null;
    };
    expect(last?.executed).toBe(false);
    expect(last?.fixAction).toBeNull();
  });
});
