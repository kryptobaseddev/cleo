/**
 * Tests for the ContextEngine plugin registry.
 *
 * @task T9312
 * @epic T9261 T-LLM-CRED-CENTRALIZATION
 */

import type { ContextEngine } from '@cleocode/contracts/memory/context-engine.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  _resetContextEngineRegistryForTesting,
  getContextEngine,
  listContextEngines,
  registerContextEngine,
} from '../index.js';

afterEach(() => {
  _resetContextEngineRegistryForTesting();
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeStubEngine(name: string): ContextEngine {
  return {
    shouldCompress: vi.fn().mockReturnValue(false),
    compress: vi.fn().mockResolvedValue({
      compressedMessages: [],
      beforeTokens: 0,
      afterTokens: 0,
    }),
    // attach name for debugging
    toString: () => `StubEngine(${name})`,
  } as ContextEngine;
}

// ---------------------------------------------------------------------------
// Auto-registered builtins
// ---------------------------------------------------------------------------

describe('built-in registration', () => {
  it('registers rule-based engine at module load', () => {
    const engine = getContextEngine('rule-based');
    expect(engine).toBeDefined();
  });

  it('listContextEngines includes rule-based', () => {
    const names = listContextEngines();
    expect(names).toContain('rule-based');
  });
});

// ---------------------------------------------------------------------------
// registerContextEngine
// ---------------------------------------------------------------------------

describe('registerContextEngine', () => {
  it('makes the engine retrievable by name', () => {
    const engine = makeStubEngine('test-a');
    registerContextEngine('test-a', engine);
    expect(getContextEngine('test-a')).toBe(engine);
  });

  it('last-writer-wins — overrides previous registration', () => {
    const first = makeStubEngine('first');
    const second = makeStubEngine('second');
    registerContextEngine('my-engine', first);
    registerContextEngine('my-engine', second);
    expect(getContextEngine('my-engine')).toBe(second);
  });

  it('does not affect other registered engines', () => {
    const a = makeStubEngine('a');
    const b = makeStubEngine('b');
    registerContextEngine('engine-a', a);
    registerContextEngine('engine-b', b);
    expect(getContextEngine('engine-a')).toBe(a);
    expect(getContextEngine('engine-b')).toBe(b);
  });
});

// ---------------------------------------------------------------------------
// getContextEngine
// ---------------------------------------------------------------------------

describe('getContextEngine', () => {
  it('returns undefined for an unregistered name', () => {
    expect(getContextEngine('does-not-exist')).toBeUndefined();
  });

  it('is case-sensitive', () => {
    const engine = makeStubEngine('case');
    registerContextEngine('MyEngine', engine);
    expect(getContextEngine('myengine')).toBeUndefined();
    expect(getContextEngine('MyEngine')).toBe(engine);
  });
});

// ---------------------------------------------------------------------------
// listContextEngines
// ---------------------------------------------------------------------------

describe('listContextEngines', () => {
  it('returns sorted names', () => {
    registerContextEngine('zebra', makeStubEngine('z'));
    registerContextEngine('alpha', makeStubEngine('a'));
    const names = listContextEngines();
    const zebra = names.indexOf('zebra');
    const alpha = names.indexOf('alpha');
    expect(alpha).toBeLessThan(zebra);
  });

  it('returns a stable snapshot (not a live reference)', () => {
    const before = listContextEngines();
    registerContextEngine('new-engine', makeStubEngine('new'));
    const after = listContextEngines();
    expect(before).not.toContain('new-engine');
    expect(after).toContain('new-engine');
  });
});

// ---------------------------------------------------------------------------
// _resetContextEngineRegistryForTesting
// ---------------------------------------------------------------------------

describe('_resetContextEngineRegistryForTesting', () => {
  it('removes user-registered engines', () => {
    registerContextEngine('temp', makeStubEngine('temp'));
    _resetContextEngineRegistryForTesting();
    expect(getContextEngine('temp')).toBeUndefined();
  });

  it('restores rule-based builtin after reset', () => {
    _resetContextEngineRegistryForTesting();
    expect(getContextEngine('rule-based')).toBeDefined();
  });
});
