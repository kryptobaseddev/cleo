/**
 * Regression coverage for the T1440 nexus dispatch OpsFromCore migration.
 *
 * Verifies that nexus.ts derives NexusOps from coreNexus.nexusCoreOps via
 * OpsFromCore inference instead of importing per-op contract param types directly.
 *
 * @task T1440 — nexus dispatch OpsFromCore inference migration
 * @task T1435 — Wave 1 dispatch refactor
 */

import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const testDir = dirname(fileURLToPath(import.meta.url));
const dispatchSourcePath = resolve(testDir, '../nexus.ts');
const coreIndexSourcePath = resolve(testDir, '../../../../../core/src/nexus/index.ts');
const coreOpsSourcePath = resolve(testDir, '../../../../../core/src/nexus/ops.ts');

describe('nexus dispatch OpsFromCore inference (T1440)', () => {
  it('imports coreNexus from @cleocode/core instead of per-op contract param types', async () => {
    const source = await readFile(dispatchSourcePath, 'utf-8');

    // Must use coreNexus import pattern
    expect(source).toContain("import type { nexus as coreNexus } from '@cleocode/core'");

    // Must derive NexusOps from OpsFromCore
    expect(source).toContain('type NexusOps = OpsFromCore<typeof coreNexus.nexusCoreOps>');

    // Must import OpsFromCore from typed adapter
    expect(source).toContain('type OpsFromCore');
  });

  it('does not import NexusXxxParams types directly from @cleocode/contracts', async () => {
    const source = await readFile(dispatchSourcePath, 'utf-8');

    // Should NOT have per-op params imports from contracts (these come via OpsFromCore)
    expect(source).not.toMatch(/NexusStatusParams/);
    expect(source).not.toMatch(/NexusListParams/);
    expect(source).not.toMatch(/NexusShowParams/);
    expect(source).not.toMatch(/NexusRegisterParams/);
    expect(source).not.toMatch(/NexusTransferParams/);
    expect(source).not.toMatch(/NexusSigilListParams/);
    expect(source).not.toMatch(/NexusProfileViewParams/);
    expect(source).not.toMatch(/NexusWikiParams/);
    expect(source).not.toMatch(/NexusGraphParams/);
    expect(source).not.toMatch(/NexusDepsParams/);
  });

  it('still uses defineTypedHandler<NexusOps> typed handler pattern', async () => {
    const source = await readFile(dispatchSourcePath, 'utf-8');

    expect(source).toContain('defineTypedHandler<NexusOps>');
    expect(source).toContain('typedDispatch');
    expect(source).toContain('_nexusTypedHandler');
  });

  it('preserves all 48 operations (30 query + 18 mutate)', async () => {
    const source = await readFile(dispatchSourcePath, 'utf-8');

    // Spot-check query ops
    expect(source).toContain("'status'");
    expect(source).toContain("'list'");
    expect(source).toContain("'show'");
    expect(source).toContain("'resolve'");
    expect(source).toContain("'deps'");
    expect(source).toContain("'graph'");
    expect(source).toContain("'path.show'");
    expect(source).toContain("'blockers.show'");
    expect(source).toContain("'orphans.list'");
    expect(source).toContain("'discover'");
    expect(source).toContain("'search'");
    expect(source).toContain("'augment'");
    expect(source).toContain("'share.status'");
    expect(source).toContain("'transfer.preview'");
    expect(source).toContain("'top-entries'");
    expect(source).toContain("'impact'");
    expect(source).toContain("'full-context'");
    expect(source).toContain("'task-footprint'");
    expect(source).toContain("'brain-anchors'");
    expect(source).toContain("'why'");
    expect(source).toContain("'impact-full'");
    expect(source).toContain("'route-map'");
    expect(source).toContain("'shape-check'");
    expect(source).toContain("'search-code'");
    expect(source).toContain("'wiki'");
    expect(source).toContain("'contracts-show'");
    expect(source).toContain("'task-symbols'");
    expect(source).toContain("'profile.view'");
    expect(source).toContain("'profile.get'");
    expect(source).toContain("'sigil.list'");

    // Spot-check mutate ops
    expect(source).toContain("'init'");
    expect(source).toContain("'register'");
    expect(source).toContain("'unregister'");
    expect(source).toContain("'sync'");
    expect(source).toContain("'permission.set'");
    expect(source).toContain("'reconcile'");
    expect(source).toContain("'share.snapshot.export'");
    expect(source).toContain("'share.snapshot.import'");
    expect(source).toContain("'transfer'");
    expect(source).toContain("'contracts-sync'");
    expect(source).toContain("'contracts-link-tasks'");
    expect(source).toContain("'conduit-scan'");
    expect(source).toContain("'profile.import'");
    expect(source).toContain("'profile.export'");
    expect(source).toContain("'profile.reinforce'");
    expect(source).toContain("'profile.upsert'");
    expect(source).toContain("'profile.supersede'");
    expect(source).toContain("'sigil.sync'");
  });

  it('preserves QUERY_OPS and MUTATE_OPS sets with getSupportedOperations', async () => {
    const source = await readFile(dispatchSourcePath, 'utf-8');

    expect(source).toContain('QUERY_OPS');
    expect(source).toContain('MUTATE_OPS');
    expect(source).toContain('getSupportedOperations');
  });

  it('preserves the inline handleImpact and handleTopEntries functions', async () => {
    const source = await readFile(dispatchSourcePath, 'utf-8');

    // These complex ops bypass typed dispatch and must stay preserved
    expect(source).toContain('handleTopEntries');
    expect(source).toContain('handleImpact');
    expect(source).toContain('NexusImpactResult');
  });

  it('exposes nexusCoreOps from the core nexus index', async () => {
    const indexSource = await readFile(coreIndexSourcePath, 'utf-8');

    expect(indexSource).toContain("export type { nexusCoreOps } from './ops.js'");
  });

  it('declares nexusCoreOps with all 48 ops in core ops.ts', async () => {
    const opsSource = await readFile(coreOpsSourcePath, 'utf-8');

    expect(opsSource).toContain('export declare const nexusCoreOps');

    // Spot-check query ops
    expect(opsSource).toContain("readonly status: NexusCoreOperation<'status'>");
    expect(opsSource).toContain("readonly list: NexusCoreOperation<'list'>");
    expect(opsSource).toContain("readonly 'path.show': NexusCoreOperation<'path.show'>");
    expect(opsSource).toContain("readonly 'full-context': NexusCoreOperation<'full-context'>");
    expect(opsSource).toContain("readonly 'sigil.list': NexusCoreOperation<'sigil.list'>");

    // Spot-check mutate ops
    expect(opsSource).toContain("readonly init: NexusCoreOperation<'init'>");
    expect(opsSource).toContain("readonly register: NexusCoreOperation<'register'>");
    expect(opsSource).toContain(
      "readonly 'share.snapshot.export': NexusCoreOperation<'share.snapshot.export'>",
    );
    expect(opsSource).toContain("readonly 'sigil.sync': NexusCoreOperation<'sigil.sync'>");
  });
});
