/**
 * Tests for ClaudeCodeHookProvider.getTranscript() — T729 bug fix.
 *
 * Verifies that getTranscript reads root-level session JSONLs (siblings
 * to UUID subdirectories) instead of walking into UUID subdirs.
 *
 * Claude Code layout under ~/.claude/projects/<project>/:
 *   - <sessionId>.jsonl        ← root-level session JSONL (the real transcript)
 *   - <uuid>/                  ← UUID subdir (contains only subagents/ and tool-results/)
 *   - <uuid>/subagents/        ← subagent session JSONLs live here
 *   - <uuid>/tool-results/     ← not JSONL sessions
 *
 * @task T729
 * @epic T726
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ClaudeCodeHookProvider } from '../hooks.js';

let tempDir: string;
let hooks: ClaudeCodeHookProvider;

/** JSONL line for a user turn. */
function userLine(text: string): string {
  return JSON.stringify({ role: 'user', content: text });
}

/** JSONL line for an assistant turn. */
function assistantLine(text: string): string {
  return JSON.stringify({ role: 'assistant', content: text });
}

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'cleo-get-transcript-'));
  hooks = new ClaudeCodeHookProvider();
  // Override HOME so getTranscript reads from our temp fixture
  process.env['HOME'] = tempDir;
});

afterEach(async () => {
  delete process.env['HOME'];
  await rm(tempDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Fixture builders
// ---------------------------------------------------------------------------

/**
 * Create the standard Claude Code directory layout under tempDir.
 *
 * ~/.claude/projects/
 *   <projectSlug>/
 *     <sessionId>.jsonl          ← root-level session JSONL
 *     <uuid>/                    ← UUID subdir (no JSONLs at root)
 *     <uuid>/subagents/
 *       agent-<agentId>.jsonl   ← subagent JSONL
 *     <uuid>/tool-results/       ← not a session JSONL
 */
async function createFixture(opts: {
  projectSlug: string;
  sessionId: string;
  rootLines: string[];
  uuid?: string;
  subagentLines?: string[];
}): Promise<{ projectDir: string }> {
  const projectsDir = join(tempDir, '.claude', 'projects');
  const projectDir = join(projectsDir, opts.projectSlug);
  await mkdir(projectDir, { recursive: true });

  // Root-level session JSONL (the one getTranscript MUST read)
  const rootJsonl = join(projectDir, `${opts.sessionId}.jsonl`);
  await writeFile(rootJsonl, opts.rootLines.join('\n'));

  if (opts.uuid) {
    // UUID subdir — should NOT be read as a session JSONL source
    const uuidDir = join(projectDir, opts.uuid);
    await mkdir(uuidDir, { recursive: true });

    if (opts.subagentLines) {
      const subagentsDir = join(uuidDir, 'subagents');
      await mkdir(subagentsDir, { recursive: true });
      const saJsonl = join(subagentsDir, `agent-${opts.sessionId}.jsonl`);
      await writeFile(saJsonl, opts.subagentLines.join('\n'));
    }

    // tool-results dir should never be iterated
    await mkdir(join(uuidDir, 'tool-results'), { recursive: true });
  }

  return { projectDir };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('getTranscript — T729 root-level JSONL fix', () => {
  it('GT-1: reads root-level session JSONL, not UUID subdir contents', async () => {
    await createFixture({
      projectSlug: 'test-project',
      sessionId: 'ses_abc123',
      rootLines: [userLine('hello from root'), assistantLine('response from root')],
      uuid: 'f47ac10b-58cc-4372-a567-0e02b2c3d479',
    });

    const result = await hooks.getTranscript('ses_abc123', '/tmp/test');

    expect(result).not.toBeNull();
    expect(result).toContain('user: hello from root');
    expect(result).toContain('assistant: response from root');
  });

  it('GT-2: returns null when projects dir does not exist', async () => {
    // HOME points to tempDir but no .claude/projects inside
    const result = await hooks.getTranscript('ses_abc123', '/tmp/test');
    expect(result).toBeNull();
  });

  it('GT-3: returns null when root-level JSONL has no recognizable turns', async () => {
    await createFixture({
      projectSlug: 'test-project',
      sessionId: 'ses_empty',
      rootLines: [JSON.stringify({ type: 'system', data: 'some system event' }), 'malformed line'],
    });

    const result = await hooks.getTranscript('ses_empty', '/tmp/test');
    expect(result).toBeNull();
  });

  it('GT-4: picks most-recent root JSONL when multiple projects exist', async () => {
    // Create two project dirs with root JSONLs; lexicographically later name wins
    const projectsDir = join(tempDir, '.claude', 'projects');

    const proj1 = join(projectsDir, 'project-a');
    await mkdir(proj1, { recursive: true });
    await writeFile(join(proj1, 'ses_older.jsonl'), userLine('older project'));

    const proj2 = join(projectsDir, 'project-z');
    await mkdir(proj2, { recursive: true });
    await writeFile(join(proj2, 'ses_newer.jsonl'), userLine('newer project'));

    const result = await hooks.getTranscript('ses_newer', '/tmp/test');
    // project-z sorts after project-a, so project-z/ses_newer.jsonl wins
    expect(result).toContain('user: newer project');
  });

  it('GT-5: also ingests subagent JSONLs from UUID subdir when present', async () => {
    await createFixture({
      projectSlug: 'test-project',
      sessionId: 'ses_withagent',
      rootLines: [userLine('main session turn')],
      uuid: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
      subagentLines: [assistantLine('subagent turn')],
    });

    const result = await hooks.getTranscript('ses_withagent', '/tmp/test');

    expect(result).not.toBeNull();
    expect(result).toContain('user: main session turn');
    expect(result).toContain('assistant: subagent turn');
  });

  it('GT-6: does NOT read JSONL files placed directly inside UUID subdirs (wrong layout)', async () => {
    const projectsDir = join(tempDir, '.claude', 'projects');
    const projectDir = join(projectsDir, 'test-project');
    await mkdir(projectDir, { recursive: true });

    // Place a JSONL inside a UUID subdir (old/wrong location)
    const uuidDir = join(projectDir, 'f47ac10b-58cc-4372-a567-0e02b2c3d479');
    await mkdir(uuidDir, { recursive: true });
    await writeFile(join(uuidDir, 'wrong-location.jsonl'), userLine('should not be read'));

    // No root-level JSONL present
    const result = await hooks.getTranscript('ses_abc', '/tmp/test');

    // Should return null since no root-level JSONLs exist
    expect(result).toBeNull();
  });
});
