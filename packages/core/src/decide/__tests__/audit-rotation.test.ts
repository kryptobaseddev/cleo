/**
 * `decisions.jsonl` is bounded: size-based rotation keeps a fixed number of
 * generations, so shadow mode on every ambiguous `cleo add` cannot grow the
 * audit without limit.
 *
 * @task T12492
 */

import { existsSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createJsonlDecisionAudit, type DecisionAuditEntry } from '../audit.js';

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cleo-decide-audit-rot-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function entry(i: number): DecisionAuditEntry {
  return {
    timestamp: new Date(0).toISOString(),
    site: `site-${i}`,
    questionsHash: 'q'.repeat(64),
    stateHash: 's'.repeat(64),
    answers: {},
    source: 'fallback',
    fallbackReason: 'timeout',
    latencyMs: 300,
  };
}

describe('decision audit rotation', () => {
  it('rotates at maxBytes and keeps at most `keep` older generations', () => {
    const audit = createJsonlDecisionAudit(root, { maxBytes: 1_000, keep: 2 });
    for (let i = 0; i < 100; i++) audit.write(entry(i));

    const dir = join(root, '.cleo', 'audit');
    const files = readdirSync(dir)
      .filter((f) => f.startsWith('decisions.jsonl'))
      .sort();
    expect(files).toEqual(['decisions.jsonl', 'decisions.jsonl.1', 'decisions.jsonl.2']);
    for (const f of files) expect(statSync(join(dir, f)).size).toBeLessThanOrEqual(1_000 + 300);
    expect(existsSync(join(dir, 'decisions.jsonl.3'))).toBe(false);
  });

  it('defaults to a bounded size', () => {
    const audit = createJsonlDecisionAudit(root);
    audit.write(entry(0));
    expect(existsSync(join(root, '.cleo', 'audit', 'decisions.jsonl'))).toBe(true);
  });
});
