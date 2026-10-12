/**
 * Two-way decision↔ADR surfacing — the settled decisions-vs-ADRs
 * methodology (T13359 · spec `cleodocs-rearch-design` §4/§10 · D11165).
 *
 * End-to-end through the dispatch handlers on an isolated temp project
 * (same harness as docs-memory-observation.test.ts):
 *
 *   - `docs fetch <adr-slug>` surfaces the `D####` decisions the ADR
 *     ratifies (AC2, ADR→decision direction).
 *   - `memory decision.find` surfaces the linked ADR slugs on each `D####`
 *     row (decision→ADR direction) — the same link row both ways.
 *   - A revoked link stops surfacing in both directions while the tombstone
 *     row survives in the store.
 *
 * @task T13359
 * @epic T13340
 * @saga T13339
 */

import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DocsFetchResult } from '@cleocode/contracts/operations/docs';
import {
  _resetBrainWriterForTests,
  shutdownBrainWriter,
} from '@cleocode/core/memory/brain-writer-thread';
import { awaitBackgroundOps } from '@cleocode/core/store/background-ops';
import { linkDecisionToAdr, revokeDecisionAdrLink } from '@cleocode/core/store/decision-adr-links';
import { closeAllDatabases } from '@cleocode/core/store/sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DocsHandler } from '../docs.js';
import { MemoryHandler } from '../memory.js';

let tempDir: string;
const docsHandler = new DocsHandler();
const memoryHandler = new MemoryHandler();

beforeEach(async () => {
  // realpath is load-bearing on macOS (/var → /private/var symlink) — see
  // docs-memory-observation.test.ts.
  tempDir = await realpath(await mkdtemp(join(tmpdir(), 'cleo-decision-adr-dispatch-')));
  vi.stubEnv('CLEO_ROOT', tempDir);
  vi.stubEnv('CLEO_DIR', join(tempDir, '.cleo'));
  vi.stubEnv('CLEO_BRAIN_BYPASS_WRITER_THREAD', '1');
  await mkdir(join(tempDir, '.cleo'));
  await writeFile(
    join(tempDir, '.cleo/project-info.json'),
    JSON.stringify({ projectId: 'decision-adr-fixture', projectRoot: tempDir }),
  );
});

afterEach(async () => {
  await awaitBackgroundOps();
  await shutdownBrainWriter();
  _resetBrainWriterForTests();
  await closeAllDatabases();
  vi.unstubAllEnvs();
  await rm(tempDir, { recursive: true, force: true });
});

/** Add an ADR doc owned by a decision; returns its slug. */
async function addAdr(slug: string, ownerId = 'D11165'): Promise<void> {
  const added = await docsHandler.mutate('add', {
    ownerId,
    content: `# ${slug}\n\nCurated architecture record.\n`,
    slug,
    type: 'adr',
  });
  expect(added.success, JSON.stringify(added.error)).toBe(true);
}

describe('decision↔ADR two-way surfacing (T13359)', () => {
  it('docs fetch surfaces the linked D#### decisions on the ADR doc', async () => {
    await addAdr('adr-901-decision-adr-links');
    await linkDecisionToAdr(tempDir, {
      decisionId: 'D11165',
      adrSlug: 'adr-901-decision-adr-links',
      linkedBy: 'agent-test',
    });
    await linkDecisionToAdr(tempDir, {
      decisionId: 'D11166',
      adrSlug: 'adr-901-decision-adr-links',
    });

    const fetched = await docsHandler.query('fetch', {
      attachmentRef: 'adr-901-decision-adr-links',
    });
    expect(fetched.success, JSON.stringify(fetched.error)).toBe(true);
    const data = fetched.data as DocsFetchResult;
    expect(data.linkedDecisions).toEqual(['D11165', 'D11166']);
  });

  it('docs fetch omits linkedDecisions when the ADR has no live links', async () => {
    await addAdr('adr-902-unlinked');
    const fetched = await docsHandler.query('fetch', { attachmentRef: 'adr-902-unlinked' });
    expect(fetched.success, JSON.stringify(fetched.error)).toBe(true);
    expect('linkedDecisions' in (fetched.data as DocsFetchResult)).toBe(false);
  });

  it('decision.find surfaces the linked ADR slugs — the same link row, both ways', async () => {
    const marker = 't13359-methodology-marker';
    const stored = await memoryHandler.mutate('decision.store', {
      decision: `Adopt the tiered decisions-vs-ADRs methodology ${marker}`,
      rationale: `Ledger-first authority with curated ADR graduation ${marker}`,
      confirmationState: 'accepted',
      decidedBy: 'council',
    });
    expect(stored.success, JSON.stringify(stored.error)).toBe(true);
    const storedData = stored.data as { id?: string };
    const decisionId: string = storedData.id ?? '';
    expect(decisionId).toMatch(/^D\d+$/);

    await addAdr('adr-903-graduated', decisionId);
    await linkDecisionToAdr(tempDir, { decisionId, adrSlug: 'adr-903-graduated' });

    const found = await memoryHandler.query('decision.find', { query: marker });
    expect(found.success, JSON.stringify(found.error)).toBe(true);
    const data = found.data as { decisions: Array<Record<string, unknown>>; total: number };
    const row = data.decisions.find((d) => d['id'] === decisionId);
    expect(row, `decision ${decisionId} not in decision.find results`).toBeDefined();
    expect(row?.['linkedAdrs']).toEqual(['adr-903-graduated']);

    // And the ADR side names the decision (AC2 holds across both surfaces).
    const fetched = await docsHandler.query('fetch', { attachmentRef: 'adr-903-graduated' });
    expect((fetched.data as DocsFetchResult).linkedDecisions).toEqual([decisionId]);
  });

  it('a revoked link stops surfacing in both directions; the tombstone row survives', async () => {
    await addAdr('adr-904-revoked');
    await linkDecisionToAdr(tempDir, { decisionId: 'D11165', adrSlug: 'adr-904-revoked' });
    await revokeDecisionAdrLink(tempDir, {
      decisionId: 'D11165',
      adrSlug: 'adr-904-revoked',
      revokedBy: 'agent-reviewer',
    });

    const fetched = await docsHandler.query('fetch', { attachmentRef: 'adr-904-revoked' });
    expect(fetched.success, JSON.stringify(fetched.error)).toBe(true);
    expect('linkedDecisions' in (fetched.data as DocsFetchResult)).toBe(false);

    const { getDecisionAdrLink } = await import('@cleocode/core/store/decision-adr-links');
    const tombstone = await getDecisionAdrLink(tempDir, 'D11165', 'adr-904-revoked');
    expect(tombstone?.status).toBe('revoked');
    expect(tombstone?.revokedBy).toBe('agent-reviewer');
  });
});

describe('docs link-decision / unlink-decision verbs (T13598)', () => {
  /** Store a ledger decision; returns its D#### id. */
  async function decision(marker: string): Promise<string> {
    const stored = await memoryHandler.mutate('decision.store', {
      decision: `Verb fixture decision ${marker}`,
      rationale: `Fixture rationale ${marker}`,
    });
    expect(stored.success, JSON.stringify(stored.error)).toBe(true);
    const id = (stored.data as { id?: string }).id ?? '';
    expect(id).toMatch(/^D\d+$/);
    return id;
  }

  it('links through dispatch, revokes, and refuses to re-link the revoked pair', async () => {
    await addAdr('adr-905-verbs');
    const pair = { adrSlug: 'adr-905-verbs', decisionId: await decision('t13598-a') };

    const linked = await docsHandler.mutate('link-decision', pair);
    expect(linked.success, JSON.stringify(linked.error)).toBe(true);
    expect(linked.data).toEqual({ ...pair, status: 'linked', changed: true });
    const again = await docsHandler.mutate('link-decision', pair);
    expect(again.data).toEqual({ ...pair, status: 'linked', changed: false });
    const fetched = await docsHandler.query('fetch', { attachmentRef: 'adr-905-verbs' });
    expect((fetched.data as DocsFetchResult).linkedDecisions).toEqual([pair.decisionId]);

    const unlinked = await docsHandler.mutate('unlink-decision', pair);
    expect(unlinked.data).toEqual({ ...pair, status: 'revoked', changed: true });
    const after = await docsHandler.query('fetch', { attachmentRef: 'adr-905-verbs' });
    expect('linkedDecisions' in (after.data as DocsFetchResult)).toBe(false);

    const relink = await docsHandler.mutate('link-decision', pair);
    expect(relink.success).toBe(false);
    expect(relink.error?.code).toBe('E_CLEO_VALIDATION');
    expect(relink.error?.message).toMatch(/revoked/);
  });

  it('refuses a link to a slug that is no doc, or a decision missing from the ledger; nothing is written', async () => {
    await addAdr('adr-906-real');
    const id = await decision('t13598-b');
    const typo = await docsHandler.mutate('link-decision', {
      adrSlug: 'adr-906-typo',
      decisionId: id,
    });
    expect(typo.success).toBe(false);
    expect(typo.error?.code).toBe('E_CLEO_NOT_FOUND');
    expect(typo.error?.message).toMatch(/adr-906-typo/);
    const ghost = await docsHandler.mutate('link-decision', {
      adrSlug: 'adr-906-real',
      decisionId: 'D99999999',
    });
    expect(ghost.success).toBe(false);
    expect(ghost.error?.code).toBe('E_CLEO_NOT_FOUND');
    expect(ghost.error?.message).toMatch(/D99999999/);
    const { getDecisionAdrLink } = await import('@cleocode/core/store/decision-adr-links');
    expect(await getDecisionAdrLink(tempDir, id, 'adr-906-typo')).toBeNull();
    expect(await getDecisionAdrLink(tempDir, 'D99999999', 'adr-906-real')).toBeNull();
  });

  it('refuses to unlink a pair that was never linked', async () => {
    const unknown = await docsHandler.mutate('unlink-decision', {
      adrSlug: 'adr-906-none',
      decisionId: 'D11165',
    });
    expect(unknown.success).toBe(false);
    expect(unknown.error?.code).toBe('E_CLEO_NOT_FOUND');
  });

  it('a docs update keeps the ADR slug, so its links still show (T13599)', async () => {
    await addAdr('adr-907-updated');
    const id = await decision('t13598-c');
    await docsHandler.mutate('link-decision', { adrSlug: 'adr-907-updated', decisionId: id });
    const updated = await docsHandler.mutate('update', {
      slug: 'adr-907-updated',
      content: '# adr-907-updated\n\nRevised record.\n',
    });
    expect(updated.success, JSON.stringify(updated.error)).toBe(true);
    const fetched = await docsHandler.query('fetch', { attachmentRef: 'adr-907-updated' });
    expect((fetched.data as DocsFetchResult).linkedDecisions).toEqual([id]);
  });
});
