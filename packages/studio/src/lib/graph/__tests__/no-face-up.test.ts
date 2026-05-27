/**
 * Unit tests for the "no face-up leaf labels" runtime guard.
 *
 * Renderers call {@link assertNoFaceUp} at mount with their resolved
 * config. The guard MUST reject `{ drawLabels: true }` and
 * `{ renderLabels: true }` and accept the absence of those fields.
 *
 * @task T990
 * @wave 1A
 */

import { describe, expect, it } from 'vitest';
import { assertNoFaceUp, FaceUpLabelsForbiddenError } from '../no-face-up.js';

describe('assertNoFaceUp', () => {
  it('accepts `undefined` config', () => {
    expect(() => assertNoFaceUp(undefined)).not.toThrow();
  });

  it('accepts `null` config', () => {
    expect(() => assertNoFaceUp(null)).not.toThrow();
  });

  it('accepts an empty object', () => {
    expect(() => assertNoFaceUp({})).not.toThrow();
  });

  it('accepts `drawLabels: false`', () => {
    expect(() => assertNoFaceUp({ drawLabels: false })).not.toThrow();
  });

  it('accepts `renderLabels: false`', () => {
    expect(() => assertNoFaceUp({ renderLabels: false })).not.toThrow();
  });

  it('rejects `drawLabels: true` with FaceUpLabelsForbiddenError', () => {
    expect(() => assertNoFaceUp({ drawLabels: true })).toThrow(FaceUpLabelsForbiddenError);
    try {
      assertNoFaceUp({ drawLabels: true });
    } catch (err) {
      expect(err).toBeInstanceOf(FaceUpLabelsForbiddenError);
      expect((err as Error).message).toMatch(/drawLabels/);
    }
  });

  it('rejects `renderLabels: true` with FaceUpLabelsForbiddenError', () => {
    expect(() => assertNoFaceUp({ renderLabels: true })).toThrow(FaceUpLabelsForbiddenError);
  });
});
