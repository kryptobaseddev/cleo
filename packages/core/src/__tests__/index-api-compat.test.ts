import { describe, expect, it } from 'vitest';
import * as api from '../../index.js';

describe('package-root migration API compatibility', () => {
  it('keeps legacy migration exports at package root', () => {
    expect(typeof api.detectVersion).toBe('function');
    expect(typeof api.compareSemver).toBe('function');
    expect(typeof api.getMigrationStatus).toBe('function');
    expect(typeof api.runMigration).toBe('function');
    expect(typeof api.runAllMigrations).toBe('function');
  });

  it('exports system migration status under explicit name', () => {
    expect(typeof api.getSystemMigrationStatus).toBe('function');
    expect(typeof api.checkStorageMigration).toBe('function');
  });
});
