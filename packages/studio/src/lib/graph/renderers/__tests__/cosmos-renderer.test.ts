/**
 * Smoke tests for CosmosRenderer — the heavy WebGL rendering is NOT
 * exercised in the node environment (no jsdom / no canvas) but the
 * no-face-up guard, buffer-builder invariants, and edge-kind cache
 * lookups are all unit-testable here.
 *
 * @task T990
 */

import { describe, expect, it } from 'vitest';
import { ALL_EDGE_KINDS, EDGE_STYLE } from '../../edge-kinds.js';
import { assertNoFaceUp } from '../../no-face-up.js';

describe('assertNoFaceUp guard', () => {
  it('throws when drawLabels is true', () => {
    expect(() => assertNoFaceUp({ drawLabels: true })).toThrow(/Face-up leaf labels are forbidden/);
  });

  it('throws when renderLabels is true (legacy 3d-force-graph alias)', () => {
    expect(() => assertNoFaceUp({ renderLabels: true })).toThrow(
      /Face-up leaf labels are forbidden/,
    );
  });

  it('is silent when drawLabels is false or absent', () => {
    expect(() => assertNoFaceUp({ drawLabels: false })).not.toThrow();
    expect(() => assertNoFaceUp({})).not.toThrow();
  });
});

describe('edge-kind contract invariants', () => {
  it('EDGE_STYLE has an entry for every EdgeKind in ALL_EDGE_KINDS', () => {
    for (const kind of ALL_EDGE_KINDS) {
      expect(EDGE_STYLE[kind]).toBeDefined();
      expect(typeof EDGE_STYLE[kind].color).toBe('string');
      expect(typeof EDGE_STYLE[kind].thickness).toBe('number');
    }
  });

  it('every EDGE_STYLE.color is a CSS expression (var(...) or color-mix(...))', () => {
    for (const kind of ALL_EDGE_KINDS) {
      const color = EDGE_STYLE[kind].color;
      expect(color).toMatch(/var\(|color-mix\(/);
    }
  });

  it('edge kinds with arrow flag match the T990 brief', () => {
    expect(EDGE_STYLE.calls.arrow).toBe(true);
    expect(EDGE_STYLE.extends.arrow).toBe(true);
    expect(EDGE_STYLE.implements.arrow).toBe(true);
    expect(EDGE_STYLE.imports.arrow).toBe(true);
    expect(EDGE_STYLE.contains.arrow).toBe(true);
    expect(EDGE_STYLE.defines.arrow).toBe(true);
  });
});
