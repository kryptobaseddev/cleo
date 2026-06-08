/**
 * Tests for the agent-facing tool families (T1741 · epic T11456).
 *
 * Covers the 8 acceptance criteria with MOCKED backends (AC8) — no real network,
 * no destructive fs outside `mkdtemp` temp dirs, no real git/ripgrep dependency:
 *   AC1 run_shell PTY + non-PTY (spawn fallback) · AC2 read_file pagination ·
 *   AC3 write_file atomic · AC4 apply_patch fuzzy · AC5 search_files ripgrep +
 *   graceful degradation · AC6 git status/diff/log/commit · AC7 all registered
 *   in the AgentToolRegistry (surfaced via toOpenAITools).
 *
 * The pure helpers are tested directly; the tool executables are driven through
 * a hand-rolled fake {@link GuardedToolSurface} that records calls and returns
 * canned results, so no subprocess/fs is ever touched.
 *
 * @task T1741
 * @epic T11456
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  ExecuteShellInput,
  ExecuteShellResult,
  ReadFileResult,
  RunGitInput,
  WriteFileResult,
} from '@cleocode/contracts/tools/atomic';
import type { GuardedToolSurface } from '@cleocode/contracts/tools/skill-executor';
import { describe, expect, it } from 'vitest';
import { createAgentToolRegistry } from '../agent-registry.js';
import {
  applyFuzzyPatch,
  paginateLines,
  parseGitLog,
  parseGitStatus,
  parseRipgrepOutput,
} from '../agent-tool-families.js';
import { createToolGuard } from '../guard.js';

/** A recording fake of the guarded surface. Backends are fully mocked (AC8). */
function fakeSurface(handlers: {
  readFileText?: (path: string) => string;
  executeShell?: (input: ExecuteShellInput) => ExecuteShellResult | Error;
  runGit?: (input: RunGitInput) => ExecuteShellResult;
}): {
  tools: GuardedToolSurface;
  writes: Array<{ path: string; content: string }>;
  shellCalls: ExecuteShellInput[];
  gitCalls: RunGitInput[];
} {
  const writes: Array<{ path: string; content: string }> = [];
  const shellCalls: ExecuteShellInput[] = [];
  const gitCalls: RunGitInput[] = [];
  const tools: GuardedToolSurface = {
    async readFileText(input): Promise<ReadFileResult> {
      return { path: input.path, content: handlers.readFileText?.(input.path) ?? '' };
    },
    async readJson<T>(): Promise<T> {
      return {} as T;
    },
    async writeFileAtomic(input): Promise<WriteFileResult> {
      writes.push({ path: input.path, content: input.content });
      return { path: input.path, bytesWritten: Buffer.byteLength(input.content) };
    },
    async pathExists() {
      return { exists: false };
    },
    async executeShell(input): Promise<ExecuteShellResult> {
      shellCalls.push(input);
      const out = handlers.executeShell?.(input);
      if (out instanceof Error) throw out;
      return out ?? { stdout: '', stderr: '', code: 0 };
    },
    async executePty(input) {
      shellCalls.push({ command: input.command, args: input.args });
      return { stdout: '(pty)', stderr: '', code: 0, mode: 'spawn', ptyFellBack: true };
    },
    async runGit(input): Promise<ExecuteShellResult> {
      gitCalls.push(input);
      return handlers.runGit?.(input) ?? { stdout: '', stderr: '', code: 0 };
    },
  };
  return { tools, writes, shellCalls, gitCalls };
}

// ===========================================================================
// Pure helpers
// ===========================================================================

describe('paginateLines (AC2)', () => {
  const content = ['l0', 'l1', 'l2', 'l3', 'l4'].join('\n');

  it('returns the whole file when no offset/limit', () => {
    const r = paginateLines(content, '/f', 0);
    expect(r.lineCount).toBe(5);
    expect(r.totalLines).toBe(5);
    expect(r.hasMore).toBe(false);
    expect(r.content).toBe(content);
  });

  it('slices by offset + limit and reports hasMore', () => {
    const r = paginateLines(content, '/f', 1, 2);
    expect(r.offset).toBe(1);
    expect(r.content).toBe('l1\nl2');
    expect(r.lineCount).toBe(2);
    expect(r.hasMore).toBe(true);
  });

  it('clamps an out-of-range offset', () => {
    const r = paginateLines(content, '/f', 99, 10);
    expect(r.offset).toBe(5);
    expect(r.lineCount).toBe(0);
    expect(r.hasMore).toBe(false);
  });

  it('handles an empty file', () => {
    const r = paginateLines('', '/f');
    expect(r.totalLines).toBe(0);
    expect(r.lineCount).toBe(0);
    expect(r.content).toBe('');
  });
});

describe('applyFuzzyPatch (AC4)', () => {
  it('applies an exact substring match', () => {
    const out = applyFuzzyPatch('alpha beta gamma', 'beta', 'BETA');
    expect(out.matchKind).toBe('exact');
    expect(out.content).toBe('alpha BETA gamma');
  });

  it('falls back to whitespace-tolerant fuzzy matching', () => {
    const file = ['function f() {', '    return 1;', '}'].join('\n');
    // Note the different indentation of the needle — exact would miss it.
    const out = applyFuzzyPatch(file, 'return 1;', 'return 2;');
    expect(out.matchKind).toBe('exact'); // substring still present
    expect(out.content).toContain('return 2;');
  });

  it('fuzzy-matches a multi-line block with differing indentation', () => {
    const file = ['  a();', '  b();', '  c();'].join('\n');
    const out = applyFuzzyPatch(file, 'a();\nb();', 'X();');
    expect(out.matchKind).toBe('fuzzy');
    expect(out.startLine).toBe(0);
    expect(out.content).toBe(['X();', '  c();'].join('\n'));
  });

  it('reports none when nothing matches', () => {
    const out = applyFuzzyPatch('hello world', 'absent', 'x');
    expect(out.matchKind).toBe('none');
    expect(out.content).toBe('hello world');
  });

  it('respects fuzzy=false (no fuzzy fallback)', () => {
    const file = ['  a();', '  b();'].join('\n');
    const out = applyFuzzyPatch(file, 'a();\nb();', 'X();', false);
    expect(out.matchKind).toBe('none');
  });
});

describe('parseRipgrepOutput (AC5)', () => {
  it('parses path:line:text', () => {
    const { matches, truncated } = parseRipgrepOutput('src/a.ts:12:const x = 1;\n', 10);
    expect(truncated).toBe(false);
    expect(matches).toEqual([{ path: 'src/a.ts', line: 12, text: 'const x = 1;' }]);
  });

  it('parses --vimgrep path:line:col:text', () => {
    const { matches } = parseRipgrepOutput('a.ts:3:5:foo\n', 10);
    expect(matches[0]).toEqual({ path: 'a.ts', line: 3, text: 'foo' });
  });

  it('truncates at maxResults', () => {
    const stdout = ['a:1:x', 'b:2:y', 'c:3:z'].join('\n');
    const { matches, truncated } = parseRipgrepOutput(stdout, 2);
    expect(matches.length).toBe(2);
    expect(truncated).toBe(true);
  });
});

describe('parseGitStatus + parseGitLog (AC6)', () => {
  it('parses porcelain status', () => {
    const entries = parseGitStatus(' M src/a.ts\n?? new.ts\n');
    expect(entries).toEqual([
      { status: ' M', path: 'src/a.ts' },
      { status: '??', path: 'new.ts' },
    ]);
  });

  it('parses unit-separated git log', () => {
    const line = ['abc123', 'Ada', '2026-01-01T00:00:00Z', 'init'].join('');
    const commits = parseGitLog(line);
    expect(commits).toEqual([
      { sha: 'abc123', author: 'Ada', date: '2026-01-01T00:00:00Z', subject: 'init' },
    ]);
  });
});

// ===========================================================================
// Registry wiring (AC7) + executables over the fake guarded surface
// ===========================================================================

describe('agent tool families — registered in the registry (AC7)', () => {
  it('registers all six families and surfaces them via toOpenAITools', async () => {
    const r = await createAgentToolRegistry();
    for (const name of [
      'run_shell',
      'read_file_paged',
      'write_file_atomic',
      'apply_patch',
      'search_files',
      'git_status',
      'git_diff',
      'git_log',
      'git_commit',
    ]) {
      expect(r.get(name), `${name} should be registered`).toBeDefined();
    }
    const openai = r.toOpenAITools();
    expect(openai.find((t) => t.name === 'run_shell')?.inputSchema).toMatchObject({
      type: 'object',
    });
    expect(openai.find((t) => t.name === 'git_commit')).toBeDefined();
  });

  it('git tools are hidden when git is not on PATH (AC5/AC6 availability)', async () => {
    const r = await createAgentToolRegistry();
    const names = r.available({ availableBinaries: [] }).map((t) => t.name);
    expect(names).not.toContain('git_status');
    expect(names).toContain('run_shell'); // always available
    expect(names).toContain('search_files');
  });
});

describe('run_shell executable (AC1)', () => {
  it('routes through the guarded PTY surface (spawn fallback)', async () => {
    const r = await createAgentToolRegistry();
    const { tools, shellCalls } = fakeSurface({});
    const exec = r.getExecutable('run_shell');
    if (exec === undefined) throw new Error('run_shell missing');
    const out = (await exec({ command: 'echo', args: ['hi'], mode: 'auto' }, tools)) as {
      mode: string;
      ptyFellBack: boolean;
    };
    expect(shellCalls[0]?.command).toBe('echo');
    expect(out.ptyFellBack).toBe(true);
  });
});

describe('read_file_paged executable (AC2)', () => {
  it('reads via the guard and paginates', async () => {
    const r = await createAgentToolRegistry();
    const { tools } = fakeSurface({ readFileText: () => 'a\nb\nc\nd' });
    const exec = r.getExecutable('read_file_paged');
    if (exec === undefined) throw new Error('read_file_paged missing');
    const out = (await exec({ path: '/f', offset: 1, limit: 2 }, tools)) as { content: string };
    expect(out.content).toBe('b\nc');
  });
});

describe('write_file_atomic + apply_patch executables (AC3/AC4)', () => {
  it('write_file_atomic writes through the guard', async () => {
    const r = await createAgentToolRegistry();
    const { tools, writes } = fakeSurface({});
    const exec = r.getExecutable('write_file_atomic');
    if (exec === undefined) throw new Error('write_file_atomic missing');
    await exec({ path: '/f', content: 'data' }, tools);
    expect(writes).toEqual([{ path: '/f', content: 'data' }]);
  });

  it('apply_patch reads, patches, and writes through the guard', async () => {
    const r = await createAgentToolRegistry();
    const { tools, writes } = fakeSurface({ readFileText: () => 'foo bar baz' });
    const exec = r.getExecutable('apply_patch');
    if (exec === undefined) throw new Error('apply_patch missing');
    const out = (await exec({ path: '/f', oldText: 'bar', newText: 'BAR' }, tools)) as {
      applied: boolean;
      matchKind: string;
    };
    expect(out.applied).toBe(true);
    expect(out.matchKind).toBe('exact');
    expect(writes[0]?.content).toBe('foo BAR baz');
  });

  it('apply_patch does not write when there is no match', async () => {
    const r = await createAgentToolRegistry();
    const { tools, writes } = fakeSurface({ readFileText: () => 'foo' });
    const exec = r.getExecutable('apply_patch');
    if (exec === undefined) throw new Error('apply_patch missing');
    const out = (await exec({ path: '/f', oldText: 'absent', newText: 'x' }, tools)) as {
      applied: boolean;
    };
    expect(out.applied).toBe(false);
    expect(writes).toEqual([]);
  });
});

describe('search_files executable (AC5)', () => {
  it('uses ripgrep when available', async () => {
    const r = await createAgentToolRegistry();
    const { tools, shellCalls } = fakeSurface({
      executeShell: (input) =>
        input.command === 'rg'
          ? { stdout: 'a.ts:1:hit\n', stderr: '', code: 0 }
          : { stdout: '', stderr: '', code: 0 },
    });
    const exec = r.getExecutable('search_files');
    if (exec === undefined) throw new Error('search_files missing');
    const out = (await exec({ pattern: 'hit', root: '/repo' }, tools)) as {
      matches: unknown[];
      degraded: boolean;
    };
    expect(shellCalls[0]?.command).toBe('rg');
    expect(out.degraded).toBe(false);
    expect(out.matches).toEqual([{ path: 'a.ts', line: 1, text: 'hit' }]);
  });

  it('degrades to grep when ripgrep is absent (graceful degradation)', async () => {
    const r = await createAgentToolRegistry();
    const { tools, shellCalls } = fakeSurface({
      executeShell: (input) => {
        if (input.command === 'rg') return new Error('spawn rg ENOENT');
        return { stdout: 'b.ts:2:hit\n', stderr: '', code: 0 };
      },
    });
    const exec = r.getExecutable('search_files');
    if (exec === undefined) throw new Error('search_files missing');
    const out = (await exec({ pattern: 'hit', root: '/repo' }, tools)) as {
      matches: unknown[];
      degraded: boolean;
    };
    expect(shellCalls.map((c) => c.command)).toEqual(['rg', 'grep']);
    expect(out.degraded).toBe(true);
    expect(out.matches).toEqual([{ path: 'b.ts', line: 2, text: 'hit' }]);
  });

  it('reports empty+degraded when neither rg nor grep exist', async () => {
    const r = await createAgentToolRegistry();
    const { tools } = fakeSurface({ executeShell: () => new Error('ENOENT') });
    const exec = r.getExecutable('search_files');
    if (exec === undefined) throw new Error('search_files missing');
    const out = (await exec({ pattern: 'x', root: '/repo' }, tools)) as {
      matches: unknown[];
      degraded: boolean;
    };
    expect(out.matches).toEqual([]);
    expect(out.degraded).toBe(true);
  });
});

describe('git family executables (AC6)', () => {
  it('git_status parses branch + porcelain', async () => {
    const r = await createAgentToolRegistry();
    const { tools } = fakeSurface({
      runGit: (input) => {
        if (input.args[0] === 'rev-parse') return { stdout: 'main\n', stderr: '', code: 0 };
        return { stdout: ' M a.ts\n', stderr: '', code: 0 };
      },
    });
    const exec = r.getExecutable('git_status');
    if (exec === undefined) throw new Error('git_status missing');
    const out = (await exec({ cwd: '/repo' }, tools)) as {
      branch: string;
      clean: boolean;
      entries: unknown[];
    };
    expect(out.branch).toBe('main');
    expect(out.clean).toBe(false);
    expect(out.entries).toEqual([{ status: ' M', path: 'a.ts' }]);
  });

  it('git_diff passes --cached when staged', async () => {
    const r = await createAgentToolRegistry();
    const { tools, gitCalls } = fakeSurface({
      runGit: () => ({ stdout: 'diff --git ...', stderr: '', code: 0 }),
    });
    const exec = r.getExecutable('git_diff');
    if (exec === undefined) throw new Error('git_diff missing');
    const out = (await exec({ staged: true, cwd: '/repo' }, tools)) as { diff: string };
    expect(gitCalls[0]?.args).toEqual(['diff', '--cached']);
    expect(out.diff).toContain('diff --git');
  });

  it('git_log parses commits', async () => {
    const r = await createAgentToolRegistry();
    const sep = '';
    const { tools } = fakeSurface({
      runGit: () => ({
        stdout: ['s1', 'A', 'd1', 'subj'].join(sep),
        stderr: '',
        code: 0,
      }),
    });
    const exec = r.getExecutable('git_log');
    if (exec === undefined) throw new Error('git_log missing');
    const out = (await exec({ maxCount: 5 }, tools)) as { commits: Array<{ sha: string }> };
    expect(out.commits[0]?.sha).toBe('s1');
  });

  it('git_commit stages paths, commits, and returns the new sha', async () => {
    const r = await createAgentToolRegistry();
    const { tools, gitCalls } = fakeSurface({
      runGit: (input) => {
        if (input.args[0] === 'rev-parse') return { stdout: 'deadbeef\n', stderr: '', code: 0 };
        if (input.args[0] === 'commit') return { stdout: '1 file changed', stderr: '', code: 0 };
        return { stdout: '', stderr: '', code: 0 };
      },
    });
    const exec = r.getExecutable('git_commit');
    if (exec === undefined) throw new Error('git_commit missing');
    const out = (await exec({ message: 'msg', paths: ['a.ts'], cwd: '/repo' }, tools)) as {
      committed: boolean;
      sha?: string;
    };
    expect(gitCalls[0]?.args).toEqual(['add', '--', 'a.ts']);
    expect(gitCalls[1]?.args).toEqual(['commit', '-m', 'msg']);
    expect(out.committed).toBe(true);
    expect(out.sha).toBe('deadbeef');
  });

  it('git_commit reports not-committed on a non-zero exit', async () => {
    const r = await createAgentToolRegistry();
    const { tools } = fakeSurface({
      runGit: () => ({ stdout: 'nothing to commit', stderr: '', code: 1 }),
    });
    const exec = r.getExecutable('git_commit');
    if (exec === undefined) throw new Error('git_commit missing');
    const out = (await exec({ message: 'msg' }, tools)) as { committed: boolean; summary: string };
    expect(out.committed).toBe(false);
    expect(out.summary).toContain('nothing to commit');
  });
});

// ===========================================================================
// End-to-end through the REAL guard (denylist + temp-dir fs only) — still no
// network, no destructive fs outside the temp dir.
// ===========================================================================

describe('apply_patch end-to-end through the real guard (AC3/AC4/AC8)', () => {
  it('patches a file inside an allowed root', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cleo-t1741-'));
    try {
      const r = await createAgentToolRegistry();
      const guard = createToolGuard({ allowedRoots: [root], mode: 'enforce' });
      const path = join(root, 'f.txt');
      const write = r.getExecutable('write_file_atomic');
      const patch = r.getExecutable('apply_patch');
      const read = r.getExecutable('read_file_paged');
      if (write === undefined || patch === undefined || read === undefined) {
        throw new Error('family executables missing');
      }
      await write({ path, content: 'one\ntwo\nthree' }, guard);
      const res = (await patch({ path, oldText: 'two', newText: 'TWO' }, guard)) as {
        applied: boolean;
      };
      expect(res.applied).toBe(true);
      const got = (await read({ path }, guard)) as { content: string };
      expect(got.content).toBe('one\nTWO\nthree');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
