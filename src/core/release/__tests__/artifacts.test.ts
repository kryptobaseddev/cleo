/**
 * Tests for release artifacts (artifacts.ts).
 * @task T4552
 * @epic T4545
 */

import { describe, it, expect } from 'vitest';
import {
  hasArtifactHandler,
  getArtifactHandler,
  getSupportedArtifactTypes,
} from '../artifacts.js';
import type { ArtifactType } from '../artifacts.js';

describe('hasArtifactHandler', () => {
  it('should return true for all supported artifact types', () => {
    const types: ArtifactType[] = [
      'npm-package',
      'python-wheel',
      'python-sdist',
      'go-module',
      'cargo-crate',
      'ruby-gem',
      'docker-image',
      'github-release',
      'generic-tarball',
    ];

    for (const type of types) {
      expect(hasArtifactHandler(type)).toBe(true);
    }
  });

  it('should return false for unknown types', () => {
    expect(hasArtifactHandler('unknown-type')).toBe(false);
    expect(hasArtifactHandler('')).toBe(false);
  });
});

describe('getArtifactHandler', () => {
  it('should return a handler for npm-package', () => {
    const handler = getArtifactHandler('npm-package');
    expect(handler).not.toBeNull();
    expect(typeof handler?.build).toBe('function');
    expect(typeof handler?.validate).toBe('function');
    expect(typeof handler?.publish).toBe('function');
  });

  it('should return null for unknown type', () => {
    const handler = getArtifactHandler('not-a-type' as ArtifactType);
    expect(handler).toBeNull();
  });

  it('should return handlers with build/validate/publish for all types', () => {
    const types = getSupportedArtifactTypes();
    for (const type of types) {
      const handler = getArtifactHandler(type);
      expect(handler).not.toBeNull();
      expect(typeof handler?.build).toBe('function');
      expect(typeof handler?.validate).toBe('function');
      expect(typeof handler?.publish).toBe('function');
    }
  });
});

describe('getSupportedArtifactTypes', () => {
  it('should return all 9 artifact types', () => {
    const types = getSupportedArtifactTypes();
    expect(types).toHaveLength(9);
  });

  it('should include npm-package', () => {
    expect(getSupportedArtifactTypes()).toContain('npm-package');
  });

  it('should include docker-image', () => {
    expect(getSupportedArtifactTypes()).toContain('docker-image');
  });
});
