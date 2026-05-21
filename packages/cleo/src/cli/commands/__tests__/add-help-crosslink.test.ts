/**
 * Tests for T9818: `cleo add --help` epilogue cross-link to `add-batch`.
 *
 * The `addCommand` meta.description must contain a cross-link guiding agents
 * and humans to `cleo add-batch --file tasks.json` when creating 2+ tasks,
 * so they discover the atomic single-transaction primitive at the right moment.
 *
 * Coverage:
 *  1. meta.description contains the cross-link string.
 *  2. meta.description references the file-based usage form.
 *  3. Existing command name and basic shape are unchanged.
 *
 * No dispatch, no DB, no process I/O — pure metadata assertion.
 *
 * @task T9818
 * @epic T9813
 */

import { describe, expect, it } from 'vitest';
import { addCommand } from '../add.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Resolve citty meta whether it is a plain object or a thunk. */
async function resolveMeta(
  cmd: typeof addCommand,
): Promise<{ name?: string; description?: string }> {
  const raw = cmd.meta;
  if (typeof raw === 'function') {
    const result = await (raw as () => unknown)();
    return result as { name?: string; description?: string };
  }
  return (raw ?? {}) as { name?: string; description?: string };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('addCommand meta — T9818 add-batch cross-link', () => {
  it('command name is "add" (unchanged)', async () => {
    const meta = await resolveMeta(addCommand);
    expect(meta.name).toBe('add');
  });

  it('description contains cross-link to add-batch', async () => {
    const meta = await resolveMeta(addCommand);
    expect(meta.description).toContain('add-batch');
  });

  it('description references --file flag for file-based usage', async () => {
    const meta = await resolveMeta(addCommand);
    expect(meta.description).toContain('--file');
  });

  it('description mentions 2+ tasks use-case', async () => {
    const meta = await resolveMeta(addCommand);
    expect(meta.description).toMatch(/2\+\s*tasks/i);
  });

  it('description mentions single transaction or atomic rollback', async () => {
    const meta = await resolveMeta(addCommand);
    expect(meta.description?.toLowerCase()).toMatch(/atomic|single transaction/);
  });

  it('description still describes the primary purpose (create a new task)', async () => {
    const meta = await resolveMeta(addCommand);
    expect(meta.description?.toLowerCase()).toContain('task');
  });

  it('args block is unchanged — no flag or positional additions', () => {
    const args = addCommand.args as Record<string, { type: string }> | undefined;
    // Core flags that must still exist
    expect(args?.['title']).toBeDefined();
    expect(args?.['priority']).toBeDefined();
    expect(args?.['type']).toBeDefined();
    expect(args?.['parent']).toBeDefined();
    expect(args?.['acceptance']).toBeDefined();
    // No new flags introduced by this task
    expect(args?.['add-batch']).toBeUndefined();
  });
});
