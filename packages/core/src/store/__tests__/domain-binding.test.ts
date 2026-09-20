/**
 * Path-keyed domain binding registry — the invariants the E6 ProjectStore
 * cutover exists to establish (T12037 · T12038 · T12039).
 *
 * Each case here locks in a property that the pre-cutover per-domain singleton
 * quartet could NOT hold:
 *
 * - Two projects coexist; neither evicts the other (`_dbPath` held one).
 * - Two domains over ONE consolidated file share ONE connection, and an
 *   eviction invalidates BOTH together (they used to drift — T12019/T12020).
 * - Concurrent binders single-flight into one `establish` (each facade had its
 *   own `_initPromise`, so two domains double-migrated the same file).
 * - A closed connection is re-acquired rather than handed back dead (the
 *   T12035 band-aid loop, now owned by the registry instead of copy-pasted).
 *
 * @task T12037 (E6-L13)
 * @epic T11249 (E6)
 * @saga T11242
 */

import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

let dirA: string;
let dirB: string;
let originalCleoDir: string | undefined;

/** Create a temp directory that `resolveCleoDir` recognises as a project root. */
async function makeProject(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  await mkdir(join(dir, '.cleo'), { recursive: true });
  return dir;
}

describe('domain binding registry (T12037)', () => {
  beforeEach(async () => {
    originalCleoDir = process.env['CLEO_DIR'];
    // Unset so the explicit `cwd` argument drives path resolution.
    delete process.env['CLEO_DIR'];
    dirA = await makeProject('cleo-bind-a-');
    dirB = await makeProject('cleo-bind-b-');
  });

  afterEach(async () => {
    const { closeAllDatabases } = await import('../sqlite.js');
    await closeAllDatabases();
    if (originalCleoDir) process.env['CLEO_DIR'] = originalCleoDir;
    else delete process.env['CLEO_DIR'];
    await rm(dirA, { recursive: true, force: true, maxRetries: 3 }).catch(() => {});
    await rm(dirB, { recursive: true, force: true, maxRetries: 3 }).catch(() => {});
  });

  it('retains a captured global home while unscoped routing follows ambient changes', async () => {
    const { resolveDualScopeDbPath } = await import('../dual-scope-db.js');
    const previous = process.env['CLEO_HOME'];
    try {
      process.env['CLEO_HOME'] = dirA;
      const captured = dirA;
      process.env['CLEO_HOME'] = dirB;
      expect(resolveDualScopeDbPath('global', undefined, captured)).toBe(join(dirA, 'cleo.db'));
      expect(resolveDualScopeDbPath('global')).toBe(join(dirB, 'cleo.db'));
      expect(resolveDualScopeDbPath('project', dirA, dirB)).toBe(join(dirA, '.cleo', 'cleo.db'));
    } finally {
      if (previous === undefined) delete process.env['CLEO_HOME'];
      else process.env['CLEO_HOME'] = previous;
    }
  });

  it('keys bindings by canonical path — two projects coexist', async () => {
    const { bindTasksDomain } = await import('../sqlite.js');

    const a = await bindTasksDomain(dirA);
    const b = await bindTasksDomain(dirB);

    expect(a.store.dbPath).not.toBe(b.store.dbPath);
    expect(Object.is(a.native, b.native)).toBe(false);

    // Neither open evicted the other — this is the property the single
    // `_dbPath` singleton could not hold.
    expect(a.native.isOpen).toBe(true);
    expect(b.native.isOpen).toBe(true);

    // Re-binding A returns the SAME binding, not a third connection.
    const aAgain = await bindTasksDomain(dirA);
    expect(Object.is(aAgain.native, a.native)).toBe(true);
    expect(Object.is(aAgain.db, a.db)).toBe(true);
  });

  it('shares ONE connection between the tasks and brain domains of a project', async () => {
    const { bindTasksDomain } = await import('../sqlite.js');
    const { bindBrainDomain } = await import('../memory-sqlite.js');

    const tasks = await bindTasksDomain(dirA);
    const brain = await bindBrainDomain(dirA);

    // Same consolidated cleo.db → same store instance → same native handle.
    expect(brain.store.dbPath).toBe(tasks.store.dbPath);
    expect(Object.is(brain.store, tasks.store)).toBe(true);
    expect(Object.is(brain.native, tasks.native)).toBe(true);

    // …but distinct domain-typed Drizzle wrappers over it.
    expect(Object.is(brain.db.drizzle, tasks.db)).toBe(false);
  });

  it('invalidates EVERY domain of a project when its connection is evicted', async () => {
    const { bindTasksDomain } = await import('../sqlite.js');
    const { bindBrainDomain } = await import('../memory-sqlite.js');
    const { _resetDualScopeDbCache } = await import('../dual-scope-db.js');

    const tasksBefore = await bindTasksDomain(dirA);
    const brainBefore = await bindBrainDomain(dirA);

    // Simulate a sibling teardown closing the shared consolidated handle.
    _resetDualScopeDbCache('project');

    const tasksAfter = await bindTasksDomain(dirA);
    const brainAfter = await bindBrainDomain(dirA);

    // Both re-derived. Pre-cutover, each domain decided independently whether
    // its singleton was stale, so one could keep serving a closed handle.
    expect(Object.is(tasksAfter.native, tasksBefore.native)).toBe(false);
    expect(Object.is(brainAfter.native, brainBefore.native)).toBe(false);
    expect(tasksAfter.native.isOpen).toBe(true);
    expect(brainAfter.native.isOpen).toBe(true);

    // Still sharing one connection after the re-derive.
    expect(Object.is(tasksAfter.native, brainAfter.native)).toBe(true);
  });

  it('single-flights concurrent binders of the same domain', async () => {
    const { bindProjectDomain, releaseAllDomainBindings } = await import(
      '../ports/domain-binding.js'
    );
    releaseAllDomainBindings();

    let establishCalls = 0;
    const establish = () => {
      establishCalls += 1;
      return { marker: establishCalls };
    };

    const [first, second, third] = await Promise.all([
      bindProjectDomain('test-single-flight', dirA, establish),
      bindProjectDomain('test-single-flight', dirA, establish),
      bindProjectDomain('test-single-flight', dirA, establish),
    ]);

    expect(establishCalls).toBe(1);
    expect(first.db).toBe(second.db);
    expect(second.db).toBe(third.db);
  });

  it('serializes unrelated async domain establishment against one physical store', async () => {
    const { bindProjectDomain } = await import('../ports/domain-binding.js');
    let enterFirst!: () => void;
    let releaseFirst!: () => void;
    const entered = new Promise<void>((resolve) => {
      enterFirst = resolve;
    });
    const release = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const first = bindProjectDomain('schema-owner-one', dirA, async () => {
      enterFirst();
      await release;
      return 'first';
    });
    await entered;
    let secondEntered = false;
    const second = bindProjectDomain('schema-owner-two', dirA, () => {
      secondEntered = true;
      return 'second';
    });
    try {
      await new Promise((resolve) => setTimeout(resolve, 40));
      expect(secondEntered).toBe(false);
    } finally {
      releaseFirst();
      await Promise.all([first, second]);
    }
    expect(secondEntered).toBe(true);
  });

  it('admits awaited lexical nesting without sharing ownership with unrelated callers', async () => {
    const { bindProjectDomain } = await import('../ports/domain-binding.js');
    const outer = await bindProjectDomain('schema-nested-outer', dirA, async (native) => {
      const inner = await bindProjectDomain('schema-nested-inner', dirA, (nestedNative) => {
        expect(nestedNative).toBe(native);
        return 'inner';
      });
      return inner.db;
    });
    expect(outer.db).toBe('inner');
    expect(outer.native.isOpen).toBe(true);
  });

  it('refuses recursive self-establishment before waiting on its own promise', async () => {
    const { bindProjectDomain } = await import('../ports/domain-binding.js');
    await expect(
      bindProjectDomain('schema-recursive', dirA, async () => {
        await bindProjectDomain('schema-recursive', dirA, () => 'unreachable');
      }),
    ).rejects.toThrow('Recursive domain establishment');
    const fresh = await bindProjectDomain('schema-recursive', dirA, () => 'recovered');
    expect(fresh.db).toBe('recovered');
  });

  it('retains the original establishment error and does not cache a failed binding', async () => {
    const { bindProjectDomain } = await import('../ports/domain-binding.js');
    const failure = new Error('controlled schema establishment failure');
    await expect(
      bindProjectDomain('schema-failure', dirA, () => {
        throw failure;
      }),
    ).rejects.toBe(failure);
    const retry = await bindProjectDomain('schema-failure', dirA, () => 'recovered');
    expect(retry.db).toBe('recovered');
  });

  it('reacquires a live store when establishment closes its original handle', async () => {
    const { bindProjectDomain } = await import('../ports/domain-binding.js');
    let attempts = 0;
    const result = await bindProjectDomain('schema-closing', dirA, (_native, store) => {
      attempts += 1;
      if (attempts === 1) store.close();
      return attempts;
    });
    expect(attempts).toBe(2);
    expect(result.db).toBe(2);
    expect(result.native.isOpen).toBe(true);
  });

  it('re-establishes when the bound connection was closed underneath it', async () => {
    const { bindProjectDomain } = await import('../ports/domain-binding.js');

    let establishCalls = 0;
    const establish = () => {
      establishCalls += 1;
      return { generation: establishCalls };
    };

    const before = await bindProjectDomain('test-liveness', dirA, establish);
    expect(establishCalls).toBe(1);

    // A cache hit must NOT re-establish.
    await bindProjectDomain('test-liveness', dirA, establish);
    expect(establishCalls).toBe(1);

    // Close the underlying connection out from under the binding.
    before.store.close();

    const after = await bindProjectDomain('test-liveness', dirA, establish);
    expect(establishCalls).toBe(2);
    expect(after.native.isOpen).toBe(true);
    expect(Object.is(after.native, before.native)).toBe(false);
  });

  /**
   * The no-argument contract for the synchronous native getters.
   *
   * Callers that pass an explicit `projectRoot` to `getDb()` and then call the
   * getter with NO argument are widespread (tests, tools operating on another
   * checkout). Ambient path resolution misses for them, so a strict lookup
   * would return `null` and break code that is not actually wrong.
   *
   * The rule is: no argument means "the project", answered by the ambient path
   * when it is bound, else by the SOLE bound project when there is exactly one.
   * Two or more bound projects is genuinely ambiguous and returns `null` —
   * which is exactly the case where the caller must name a project. That keeps
   * the convenience without reintroducing "last project wins".
   */
  it('resolves a no-arg peek to the sole bound project, and refuses when ambiguous', async () => {
    const { bindProjectDomain, peekProjectDomain, releaseDomainBindings } = await import(
      '../ports/domain-binding.js'
    );
    releaseDomainBindings({ domain: 'test-sole' });

    const establish = () => ({ ok: true });

    // One project bound, and it is NOT the ambient one (CLEO_DIR is unset and
    // cwd is the repo). The unambiguous fallback answers.
    const a = await bindProjectDomain('test-sole', dirA, establish);
    expect(Object.is(peekProjectDomain('test-sole')?.native, a.native)).toBe(true);

    // An EXPLICIT path that is not bound must still return null — never a
    // different project's connection.
    expect(peekProjectDomain('test-sole', dirB)).toBeNull();

    // Two bound projects: no-arg is ambiguous and must refuse rather than guess.
    await bindProjectDomain('test-sole', dirB, establish);
    expect(peekProjectDomain('test-sole')).toBeNull();

    // Naming the project still resolves precisely.
    expect(Object.is(peekProjectDomain('test-sole', dirA)?.native, a.native)).toBe(true);
  });

  it('scopes a release to the requested project only', async () => {
    const { bindProjectDomain, boundDomainKeys, releaseDomainBindings } = await import(
      '../ports/domain-binding.js'
    );
    const { resolveDualScopeDbPath } = await import('../dual-scope-db.js');

    const establish = () => ({ ok: true });
    await bindProjectDomain('test-scoped-release', dirA, establish);
    await bindProjectDomain('test-scoped-release', dirB, establish);

    const pathA = resolveDualScopeDbPath('project', dirA);
    releaseDomainBindings({ scope: 'project', dbPath: pathA, domain: 'test-scoped-release' });

    const keys = [...boundDomainKeys()].filter((k) => k.endsWith('::test-scoped-release'));
    expect(keys).toHaveLength(1);
    expect(keys[0]).toContain(resolveDualScopeDbPath('project', dirB));
  });
});
