import { describe, expect, it } from 'vitest';
import { PLAYBOOKS_PACKAGE_VERSION } from '../index.js';

describe('@cleocode/playbooks — package scaffold', () => {
  it('exports the package version constant', () => {
    expect(typeof PLAYBOOKS_PACKAGE_VERSION).toBe('string');
    expect(PLAYBOOKS_PACKAGE_VERSION).toMatch(/^\d{4}\.\d+\.\d+$/);
  });
});
