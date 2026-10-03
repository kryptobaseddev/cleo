/**
 * A read-only dispatch writes no `token_usage` row (T13106).
 *
 * `token_usage` is portable-personal (journal spec Q9), so a row written by a
 * read changed the store's synced content: on device B of the T12340 staging
 * test, `cleo cloud verify` turned from `match` to `ahead` after a `cleo show`
 * on a freshly restored store. These tests build the vault manifest (what
 * `cleo cloud verify` compares, `buildVaultManifest`) before and after a
 * dispatch's token recording, on a real project store and on one restored
 * from a portable bundle.
 *
 * @task T13106
 * @epic T12323
 */

import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getTableName } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { generateProjectHash } from '../../nexus/hash.js';
import { exportPortableBundle } from '../../store/portable-bundle.js';
import { importPortableBundle } from '../../store/portable-bundle-import.js';
import { closeDb, getDb } from '../../store/sqlite.js';
import { tokenUsage } from '../../store/tasks-schema.js';
import { buildVaultManifest, type VaultManifest } from '../../store/vault-manifest.js';
import { autoRecordDispatchTokenUsage, listTokenUsage } from '../token-service.js';

const HASH_KEY = randomBytes(32);
/** The physical table the runtime records token usage in (bare today, the prefixed twin after T13111). */
const TOKEN_TABLE = getTableName(tokenUsage);
const ENV_KEYS = ['CLEO_DIR', 'CLEO_HOME', 'CLEO_CONFIG_HOME'] as const;

let tmp: string;
let saved: Record<string, string | undefined>;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cleo-t13106-'));
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  process.env['CLEO_HOME'] = path.join(tmp, 'home');
  process.env['CLEO_CONFIG_HOME'] = path.join(tmp, 'config');
  fs.mkdirSync(path.join(tmp, 'home'), { recursive: true });
});

afterEach(() => {
  closeDb();
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** A project root with a real, migrated `.cleo/cleo.db`, active as the current project. */
async function newProject(name: string): Promise<string> {
  const root = path.join(tmp, name);
  const cleo = path.join(root, '.cleo');
  fs.mkdirSync(cleo, { recursive: true });
  fs.writeFileSync(
    path.join(cleo, 'project-info.json'),
    JSON.stringify({ projectId: 'proj-t13106', projectHash: generateProjectHash(root), name }),
  );
  await useProject(root);
  return root;
}

/** Make `root` the current project and open its store (migrating it on first open). */
async function useProject(root: string): Promise<void> {
  closeDb();
  process.env['CLEO_DIR'] = path.join(root, '.cleo');
  await getDb(root);
}

/** The project's vault manifest: what `cleo cloud verify` compares, table by table. */
function manifest(root: string): VaultManifest {
  return buildVaultManifest(path.join(root, '.cleo', 'cleo.db'), {
    scope: 'project',
    hashKey: HASH_KEY,
    root,
  }).manifest;
}

/** The tables whose entry differs between two manifests. */
function changedTables(a: VaultManifest, b: VaultManifest): string[] {
  const names = new Set([...Object.keys(a.tables), ...Object.keys(b.tables)]);
  return [...names]
    .filter((t) => JSON.stringify(a.tables[t]) !== JSON.stringify(b.tables[t]))
    .sort();
}

/** What `dispatchFromCli` records after a successful dispatch. */
function exchange(gateway: string | undefined, root: string) {
  return {
    requestPayload: { taskId: 'T001' },
    responsePayload: { data: { task: { id: 'T001', title: 'probe' } } },
    transport: 'cli' as const,
    ...(gateway === undefined ? {} : { gateway }),
    domain: 'tasks',
    operation: gateway === 'mutate' ? 'add' : 'show',
    requestId: `req-${gateway ?? 'none'}`,
    cwd: root,
  };
}

describe('dispatch token usage on read-only commands (T13106)', () => {
  it.each([
    ['query', 'query'],
    ['an unknown gateway', 'other'],
    ['no gateway', undefined],
  ])('%s records no token row and leaves every vault table unchanged', async (_name, gateway) => {
    const root = await newProject('src');
    const before = manifest(root);
    await autoRecordDispatchTokenUsage(exchange(gateway, root));
    expect((await listTokenUsage(root)).total).toBe(0);
    expect(changedTables(before, manifest(root))).toEqual([]);
  });

  it('a mutation still records its token row, the only vault table it changes here', async () => {
    const root = await newProject('src');
    const before = manifest(root);
    await autoRecordDispatchTokenUsage(exchange('mutate', root));
    const listed = await listTokenUsage(root);
    expect(listed.total).toBe(1);
    expect(listed.records[0]).toMatchObject({
      gateway: 'mutate',
      domain: 'tasks',
      operation: 'add',
    });
    expect(changedTables(before, manifest(root))).toEqual([TOKEN_TABLE]);
  });

  it('on a store freshly restored from a bundle, reads keep the manifest verify compares unchanged', async () => {
    const src = await newProject('src');
    // The source carries one token row from a mutation, as device A's store did.
    await autoRecordDispatchTokenUsage(exchange('mutate', src));
    closeDb();
    const bundle = path.join(tmp, 'out', 'p.cleobundle.tar.gz');
    await exportPortableBundle({
      scope: 'project',
      projectRoot: src,
      outputPath: bundle,
      label: 'p',
      cleoHome: path.join(tmp, 'home'),
      configHome: path.join(tmp, 'config'),
    });
    const target = path.join(tmp, 'restored');
    const imported = await importPortableBundle({
      bundlePath: bundle,
      cwd: '/',
      target,
      cleoHome: path.join(tmp, 'home-b'),
      configHome: path.join(tmp, 'config-b'),
    });
    expect(imported.lossless).toBe(true);

    await useProject(target);
    const restored = manifest(target);
    for (const gateway of ['query', 'query', 'query']) {
      await autoRecordDispatchTokenUsage(exchange(gateway, target));
    }
    expect((await listTokenUsage(target)).total).toBe(1);
    expect(changedTables(restored, manifest(target))).toEqual([]);

    // The control: the same manifest does see a mutation's row.
    await autoRecordDispatchTokenUsage(exchange('mutate', target));
    expect(changedTables(restored, manifest(target))).toEqual([TOKEN_TABLE]);
  });
});
