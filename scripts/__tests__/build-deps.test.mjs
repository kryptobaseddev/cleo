/**
 * Regression tests for scripts/build-deps.mjs (T9939).
 *
 * Locks two invariants that, if broken, would re-introduce the T9853 hotfix-
 * prep blocker where contributors had to manually
 * `pnpm --filter @cleocode/cant run build` before `pnpm run build` worked:
 *
 *   1. `@cleocode/cant` is declared as a HARD prereq of `@cleocode/caamp`.
 *      Removing this edge is the literal regression we're guarding against.
 *
 *   2. The dependency graph is internally consistent: every dep referenced
 *      in `PACKAGE_DEPS` is itself a known key in the map. Catches typos and
 *      ghost references introduced during future refactors.
 *
 *   3. The graph is acyclic. A topological sort exists. (build.mjs's wave
 *      structure already assumes this; the test makes the assumption explicit
 *      so a future cycle introduction fails at PR time, not at runtime.)
 *
 * @task T9939
 * @epic T9864
 * @saga T9862
 */

import { describe, expect, it } from 'vitest';
import { depsFor, PACKAGE_DEPS } from '../build-deps.mjs';

describe('build-deps.mjs (T9939)', () => {
  describe('regression-locked edges', () => {
    it('declares @cleocode/cant as a hard prereq of @cleocode/caamp', () => {
      // This is the literal T9939 regression. caamp's tsup DTS step imports
      // @cleocode/cant. If a future refactor ever drops cant from caamp's
      // dep list (or reorders waves so caamp builds before cant), this test
      // fires before the bad PR can merge.
      const caampDeps = depsFor('packages/caamp/dist/');
      expect(caampDeps).toContain('packages/cant/dist/');
    });

    it('declares contracts + paths as prereqs of cant (the cant→caamp chain root)', () => {
      // cant itself depends on contracts + lafs. If those are dropped, the
      // wave-3 build of cant fails and the implicit cant→caamp chain breaks
      // at a different layer than T9939 caught.
      const cantDeps = depsFor('packages/cant/dist/');
      expect(cantDeps).toContain('packages/contracts/dist/');
      expect(cantDeps).toContain('packages/lafs/dist/');
    });
  });

  describe('graph integrity', () => {
    it('every declared dep is itself a known key in PACKAGE_DEPS', () => {
      const knownKeys = new Set(Object.keys(PACKAGE_DEPS));
      const orphans = [];
      for (const [pkg, deps] of Object.entries(PACKAGE_DEPS)) {
        for (const dep of deps) {
          if (!knownKeys.has(dep)) {
            orphans.push({ pkg, dep });
          }
        }
      }
      expect(orphans).toEqual([]);
    });

    it('produces a valid topological order (no cycles)', () => {
      // Kahn's algorithm — succeeds iff the graph is a DAG.
      const inDegree = new Map();
      for (const pkg of Object.keys(PACKAGE_DEPS)) inDegree.set(pkg, 0);
      for (const [pkg, deps] of Object.entries(PACKAGE_DEPS)) {
        for (const dep of deps) {
          // Edge: dep -> pkg (dep must build before pkg).
          inDegree.set(pkg, (inDegree.get(pkg) ?? 0) + 1);
        }
      }
      const ready = [];
      for (const [pkg, deg] of inDegree.entries()) {
        if (deg === 0) ready.push(pkg);
      }
      const order = [];
      while (ready.length > 0) {
        const next = ready.shift();
        order.push(next);
        // Decrement in-degree of every pkg that lists `next` as a dep.
        for (const [pkg, deps] of Object.entries(PACKAGE_DEPS)) {
          if (deps.includes(next)) {
            const newDeg = (inDegree.get(pkg) ?? 0) - 1;
            inDegree.set(pkg, newDeg);
            if (newDeg === 0) ready.push(pkg);
          }
        }
      }
      // Every pkg should have been emitted; otherwise a cycle exists.
      expect(order.length).toBe(Object.keys(PACKAGE_DEPS).length);
    });

    it('orders cant before caamp in the topological sort', () => {
      // Stronger assertion: not only does a topo order exist, but the
      // critical T9939 edge is honored. cant's index in the topo order must
      // be strictly less than caamp's index.
      const inDegree = new Map();
      for (const pkg of Object.keys(PACKAGE_DEPS)) inDegree.set(pkg, 0);
      for (const [pkg, deps] of Object.entries(PACKAGE_DEPS)) {
        for (const _dep of deps) {
          inDegree.set(pkg, (inDegree.get(pkg) ?? 0) + 1);
        }
      }
      const ready = [];
      for (const [pkg, deg] of inDegree.entries()) {
        if (deg === 0) ready.push(pkg);
      }
      const order = [];
      while (ready.length > 0) {
        const next = ready.shift();
        order.push(next);
        for (const [pkg, deps] of Object.entries(PACKAGE_DEPS)) {
          if (deps.includes(next)) {
            const newDeg = (inDegree.get(pkg) ?? 0) - 1;
            inDegree.set(pkg, newDeg);
            if (newDeg === 0) ready.push(pkg);
          }
        }
      }
      const cantIdx = order.indexOf('packages/cant/dist/');
      const caampIdx = order.indexOf('packages/caamp/dist/');
      expect(cantIdx).toBeGreaterThanOrEqual(0);
      expect(caampIdx).toBeGreaterThanOrEqual(0);
      expect(cantIdx).toBeLessThan(caampIdx);
    });
  });

  describe('depsFor()', () => {
    it('returns an empty array for unknown labels (no throw)', () => {
      expect(depsFor('packages/does-not-exist/dist/')).toEqual([]);
    });

    it('returns the declared deps for a known label', () => {
      const deps = depsFor('packages/caamp/dist/');
      expect(Array.isArray(deps)).toBe(true);
      expect(deps.length).toBeGreaterThan(0);
    });
  });
});
