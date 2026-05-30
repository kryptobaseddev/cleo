/**
 * Contract tests for the atomic-tool primitive contracts
 * (`@cleocode/contracts/tools/atomic`, E3 · T11403).
 *
 * Pins the canonical tool taxonomy + primitive registry so the CORE SDK
 * implementations (T11405-T11407) and the MCP catalog (T11411) bind to a stable
 * shape.
 *
 * @epic T11390
 * @task T11403
 * @saga T11387
 */

import { describe, expect, it } from 'vitest';
import {
  ATOMIC_TOOL_PRIMITIVES,
  type ReadFileInput,
  type ReadFileResult,
  TOOL_CLASSES,
  type ToolClass,
} from '../tools/atomic.js';

describe('atomic-tool taxonomy', () => {
  it('declares exactly the five canonical tool classes', () => {
    expect([...TOOL_CLASSES]).toEqual(['fs', 'shell', 'search', 'net', 'notebook']);
  });
});

describe('atomic-tool primitive registry', () => {
  it('every primitive has a class in the taxonomy and is stateless', () => {
    const classes = new Set<ToolClass>(TOOL_CLASSES);
    for (const p of ATOMIC_TOOL_PRIMITIVES) {
      expect(classes.has(p.class)).toBe(true);
      expect(p.stateless).toBe(true);
      expect(p.name.length).toBeGreaterThan(0);
      expect(p.responsibility.length).toBeGreaterThan(0);
    }
  });

  it('primitive names are unique', () => {
    const names = ATOMIC_TOOL_PRIMITIVES.map((p) => p.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('covers each class with at least one primitive', () => {
    const covered = new Set(ATOMIC_TOOL_PRIMITIVES.map((p) => p.class));
    for (const c of TOOL_CLASSES) {
      expect(covered.has(c)).toBe(true);
    }
  });

  it('includes the canonical fs + shell primitives', () => {
    const names = new Set(ATOMIC_TOOL_PRIMITIVES.map((p) => p.name));
    for (const n of ['readFileText', 'writeFileAtomic', 'executeShell', 'runGit']) {
      expect(names.has(n)).toBe(true);
    }
  });
});

describe('atomic-tool I/O contracts (type-level)', () => {
  it('a ReadFile round-trip is well-typed', () => {
    const input: ReadFileInput = { path: '/abs/file.ts' };
    const result: ReadFileResult = { path: input.path, content: 'hello' };
    expect(result.path).toBe('/abs/file.ts');
    expect(result.content).toBe('hello');
  });
});
