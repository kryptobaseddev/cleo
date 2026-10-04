/**
 * The store's drizzle driver is the ES module build the schema modules use,
 * not a second (CommonJS) copy of drizzle (T13126).
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { loadNodeSqliteDrizzle, requireDriver } from '../drizzle-node-sqlite.js';

const req = createRequire(import.meta.url);
const scratch = mkdtempSync(join(tmpdir(), 'drizzle-tla-'));
/** An ES module whose graph uses top-level await, as a future drizzle build might. */
const tlaModule = join(scratch, 'tla-driver.mjs');
writeFileSync(tlaModule, 'await Promise.resolve();\nexport const drizzle = () => null;\n');

afterAll(() => rmSync(scratch, { recursive: true, force: true }));

describe('loadNodeSqliteDrizzle', () => {
  it('returns the drizzle() of the ES module build, the instance `import` gives', async () => {
    const esm = await import('drizzle-orm/node-sqlite');
    expect(loadNodeSqliteDrizzle()).toBe(esm.drizzle);
  });

  it('memoizes the factory', () => {
    expect(loadNodeSqliteDrizzle()).toBe(loadNodeSqliteDrizzle());
  });
});

describe('requireDriver', () => {
  it('Node refuses to require() an ES module graph with top-level await', () => {
    expect(() => req(tlaModule)).toThrow(
      expect.objectContaining({ code: 'ERR_REQUIRE_ASYNC_MODULE' }),
    );
  });

  it('falls back to the CommonJS build when the ES module graph uses top-level await', () => {
    const cjs = req('drizzle-orm/node-sqlite') as { drizzle: unknown };
    expect(requireDriver(req, tlaModule).drizzle).toBe(cjs.drizzle);
  });

  it('loads the CommonJS build when the ES module build is unresolved', () => {
    const cjs = req('drizzle-orm/node-sqlite') as { drizzle: unknown };
    expect(requireDriver(req, null).drizzle).toBe(cjs.drizzle);
  });

  it('rethrows any other load error', () => {
    expect(() => requireDriver(req, join(scratch, 'missing.mjs'))).toThrow(
      expect.objectContaining({ code: 'MODULE_NOT_FOUND' }),
    );
  });
});
