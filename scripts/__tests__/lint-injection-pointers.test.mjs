/**
 * Tests for the pointer-resolution half of gate 14 (T12127 · GH #1225/#1239/#1231).
 *
 * Gate 14 asserted that every `cleo <verb>` named in CLEO-INJECTION.md exists,
 * and T12077 extended it to "exists AND is runnable". This is the same rule one
 * level down: a documented `--field` JSON pointer must RESOLVE against the
 * operation's `fieldPointers` contract.
 *
 * The live-repo assertion is the one that matters — it is what would have
 * caught `--field /data/status` before three separate agents each lost a turn
 * to it. The parser tests pin the behaviour that makes it trustworthy.
 *
 * @task T12127
 */

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  extractDocumentedPointers,
  findPointerViolations,
  loadFieldPointerContracts,
  operationForVerbSource,
} from '../lint-injection-commands.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const TEMPLATE = join(REPO_ROOT, 'packages/core/templates/CLEO-INJECTION.md');
const CONTRACTS = join(REPO_ROOT, 'packages/contracts/src/operations/output-contracts-data.ts');

const sourceForVerb = (verb) => {
  try {
    return readFileSync(join(REPO_ROOT, 'packages/cleo/src/cli/commands', `${verb}.ts`), 'utf-8');
  } catch {
    return null;
  }
};

describe('documented --field pointers — live repo', () => {
  it('every pointer CLEO-INJECTION.md documents resolves against its operation contract', () => {
    const markdown = readFileSync(TEMPLATE, 'utf-8');
    const contracts = loadFieldPointerContracts(readFileSync(CONTRACTS, 'utf-8'));
    expect(findPointerViolations(markdown, contracts, sourceForVerb)).toEqual([]);
  });

  it('the template documents at least one READ pointer, not only mutation ones', () => {
    // The root cause of #1225/#1239/#1231: the only `--field` example was
    // `cleo add … --field /data/created/0`, a FLAT mutation envelope. With no
    // read example to generalise from, `/data/<field>` is the natural guess
    // and it is wrong.
    const pointers = extractDocumentedPointers(readFileSync(TEMPLATE, 'utf-8'));
    expect(pointers.some((p) => p.verb === 'show')).toBe(true);
    expect(pointers.some((p) => p.pointer.startsWith('/data/task/'))).toBe(true);
  });

  it('finds pointers at all (guards against a regex that silently matches nothing)', () => {
    // A parser that stopped matching would make the assertion above pass
    // vacuously — the same "absence reads as success" shape the gate prevents.
    expect(extractDocumentedPointers(readFileSync(TEMPLATE, 'utf-8')).length).toBeGreaterThan(0);
  });

  it('the tasks.show contract declares the pointers that resolve transparently', () => {
    // Verified live: description/acceptance/verification resolve through
    // --field even under the MVI projection (T12108), so the contract must
    // list them or the remediation an agent sees omits the fields it wants.
    const contracts = loadFieldPointerContracts(readFileSync(CONTRACTS, 'utf-8'));
    const show = contracts.get('tasks.show');
    expect(show).toBeDefined();
    for (const p of [
      '/data/task/description',
      '/data/task/acceptance',
      '/data/task/verification',
      '/data/task/verification/evidence',
    ]) {
      expect([...(show ?? [])]).toContain(p);
    }
  });

  it('does NOT declare /data/task/evidence, which does not exist', () => {
    // Measured: `cleo show <id> --field /data/task/evidence` is
    // E_FIELD_NOT_FOUND; evidence lives under verification. The contract's own
    // shapeNote used to advertise the broken path.
    const contracts = loadFieldPointerContracts(readFileSync(CONTRACTS, 'utf-8'));
    expect([...(contracts.get('tasks.show') ?? [])]).not.toContain('/data/task/evidence');
  });
});

describe('extractDocumentedPointers', () => {
  it('pairs a pointer with the verb on its own line', () => {
    const md = 'run `cleo show T1 --field /data/task/status` to read it';
    expect(extractDocumentedPointers(md)).toEqual([
      { verb: 'show', pointer: '/data/task/status', raw: 'cleo show --field /data/task/status' },
    ]);
  });

  it('never attributes a pointer to a verb on a different line', () => {
    const md = 'cleo show T1\n\nsomething else --field /data/created/0';
    expect(extractDocumentedPointers(md)).toEqual([]);
  });

  it('ignores placeholder pointers', () => {
    expect(extractDocumentedPointers('`cleo show <id> --field <jsonpointer>`')).toEqual([]);
  });
});

describe('operationForVerbSource', () => {
  it('reads a dispatchRaw triple', () => {
    expect(operationForVerbSource("await dispatchRaw('query', 'tasks', 'list', params);")).toBe(
      'tasks.list',
    );
  });

  it('falls back to an explicit operation literal', () => {
    expect(operationForVerbSource("cliOutput(d, { operation: 'tasks.update' });")).toBe(
      'tasks.update',
    );
  });

  it('falls back to getOperationParams', () => {
    expect(
      operationForVerbSource(
        "args: paramsToCittyArgs(getOperationParams('query', 'tasks', 'show'))",
      ),
    ).toBe('tasks.show');
  });

  it('returns null for an unresolvable source', () => {
    expect(operationForVerbSource('export const x = 1;')).toBeNull();
    expect(operationForVerbSource(null)).toBeNull();
  });
});

describe('findPointerViolations', () => {
  const contracts = new Map([['tasks.show', new Set(['/data/task/status'])]]);
  const fakeSource = () => "getOperationParams('query', 'tasks', 'show')";

  it('flags a pointer the contract does not declare, naming the valid ones', () => {
    const [v] = findPointerViolations('`cleo show T1 --field /data/status`', contracts, fakeSource);
    expect(v.reason).toContain('is not declared by the tasks.show OUTPUT contract');
    expect(v.reason).toContain('/data/task/status');
  });

  it('passes a declared pointer', () => {
    expect(
      findPointerViolations('`cleo show T1 --field /data/task/status`', contracts, fakeSource),
    ).toEqual([]);
  });

  it('stays silent for an operation with no contract yet', () => {
    // OUTPUT_CONTRACTS is populated incrementally. This gate asserts that what
    // IS documented is correct — never that every op has a contract.
    expect(
      findPointerViolations('`cleo show T1 --field /data/whatever`', new Map(), fakeSource),
    ).toEqual([]);
  });
});
