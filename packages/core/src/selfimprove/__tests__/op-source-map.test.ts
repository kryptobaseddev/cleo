/**
 * Unit tests for the op-coordinate → source-file static map (T11988).
 *
 * Verifies:
 *   1. Known op-coords resolve to the expected handler + core file paths.
 *   2. Unknown op-coords resolve to the empty entry (no throw).
 *   3. `collectOpSourceFiles` deduplicates handler files across op-coords.
 *
 * @epic T11889
 * @task T11988
 */

import { describe, expect, it } from 'vitest';
import { collectOpSourceFiles, resolveOpSourceFiles } from '../op-source-map.js';

describe('resolveOpSourceFiles', () => {
  it('resolves tasks.show to the correct handler and core file', () => {
    const entry = resolveOpSourceFiles('tasks.show');
    expect(entry.handlerFiles).toContain('packages/cleo/src/dispatch/domains/tasks.ts');
    expect(entry.coreFiles).toContain('packages/core/src/tasks/show.ts');
  });

  it('resolves tasks.find to the correct handler and core file', () => {
    const entry = resolveOpSourceFiles('tasks.find');
    expect(entry.handlerFiles).toContain('packages/cleo/src/dispatch/domains/tasks.ts');
    expect(entry.coreFiles).toContain('packages/core/src/tasks/find.ts');
  });

  it('resolves selfimprove.probe to probe-helper.ts (the seeded regression target)', () => {
    const entry = resolveOpSourceFiles('selfimprove.probe');
    expect(entry.handlerFiles).toContain('packages/cleo/src/dispatch/domains/selfimprove.ts');
    expect(entry.coreFiles).toContain('packages/core/src/selfimprove/probe-helper.ts');
  });

  it('returns an empty entry for an unregistered op-coord — never throws', () => {
    const entry = resolveOpSourceFiles('unknown.noop');
    expect(entry.handlerFiles).toHaveLength(0);
    expect(entry.coreFiles).toHaveLength(0);
  });

  it('returns an empty entry for an empty string — never throws', () => {
    const entry = resolveOpSourceFiles('');
    expect(entry.handlerFiles).toHaveLength(0);
    expect(entry.coreFiles).toHaveLength(0);
  });
});

describe('collectOpSourceFiles', () => {
  it('deduplicates the handler file when two ops share the same handler', () => {
    const entry = collectOpSourceFiles(['tasks.find', 'tasks.show']);
    // Both ops map to the same tasks.ts handler — should appear exactly once.
    const handlerMatches = entry.handlerFiles.filter((f) => f.endsWith('tasks.ts'));
    expect(handlerMatches).toHaveLength(1);
    // Core files should be distinct.
    expect(entry.coreFiles).toContain('packages/core/src/tasks/find.ts');
    expect(entry.coreFiles).toContain('packages/core/src/tasks/show.ts');
  });

  it('includes all unique handler + core files across multiple op-coords', () => {
    const entry = collectOpSourceFiles(['tasks.show', 'selfimprove.probe']);
    expect(entry.handlerFiles).toContain('packages/cleo/src/dispatch/domains/tasks.ts');
    expect(entry.handlerFiles).toContain('packages/cleo/src/dispatch/domains/selfimprove.ts');
    expect(entry.coreFiles).toContain('packages/core/src/tasks/show.ts');
    expect(entry.coreFiles).toContain('packages/core/src/selfimprove/probe-helper.ts');
  });

  it('returns empty lists for all-unknown op-coords', () => {
    const entry = collectOpSourceFiles(['noop.a', 'noop.b']);
    expect(entry.handlerFiles).toHaveLength(0);
    expect(entry.coreFiles).toHaveLength(0);
  });

  it('returns empty lists for an empty input array', () => {
    const entry = collectOpSourceFiles([]);
    expect(entry.handlerFiles).toHaveLength(0);
    expect(entry.coreFiles).toHaveLength(0);
  });
});
