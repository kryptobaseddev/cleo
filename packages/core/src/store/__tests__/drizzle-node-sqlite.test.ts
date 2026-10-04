/**
 * The store's drizzle driver is the ES module build the schema modules use,
 * not a second (CommonJS) copy of drizzle (T13126).
 */

import { describe, expect, it } from 'vitest';
import { loadNodeSqliteDrizzle } from '../drizzle-node-sqlite.js';

describe('loadNodeSqliteDrizzle', () => {
  it('returns the drizzle() of the ES module build, the instance `import` gives', async () => {
    const esm = await import('drizzle-orm/node-sqlite');
    expect(loadNodeSqliteDrizzle()).toBe(esm.drizzle);
  });

  it('memoizes the factory', () => {
    expect(loadNodeSqliteDrizzle()).toBe(loadNodeSqliteDrizzle());
  });
});
