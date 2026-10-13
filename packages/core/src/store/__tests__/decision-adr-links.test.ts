/**
 * `decision_adr_links` accessors — the decisions-vs-ADRs link table
 * (T13359 · spec `cleodocs-rearch-design` §4/§10 · D11165).
 *
 * Covers the settled methodology: natural composite identity over
 * (decision_id, adr_slug) so concurrent identical links coalesce, append-only
 * writes (no DELETE exists), the one-way revoke tombstone latch (never
 * re-linked), and both directions of the two-way query surface.
 *
 * Temp-dir harness per test (same pattern as conduit-doc-history.test.ts).
 *
 * @task T13359
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'cleo-decision-adr-links-'));
  process.env['CLEO_DIR'] = join(tempDir, '.cleo');
  const { closeDb } = await import('../../store/sqlite.js');
  closeDb();
});

afterEach(async () => {
  const { closeDb } = await import('../../store/sqlite.js');
  closeDb();
  delete process.env['CLEO_DIR'];
  await rm(tempDir, { recursive: true, force: true });
});

describe('decision_adr_links accessors (T13359)', () => {
  it('links a D#### decision to an ADR slug and reads it back both ways', async () => {
    const { linkDecisionToAdr, listAdrLinksForDecision, listDecisionLinksForAdr } = await import(
      '../../store/decision-adr-links.js'
    );
    const { row, inserted } = await linkDecisionToAdr(tempDir, {
      decisionId: 'D11165',
      adrSlug: 'adr-059-decisions-vs-adrs',
      linkedBy: 'agent-test',
    });
    expect(inserted).toBe(true);
    expect(row.status).toBe('linked');
    expect(row.uid).not.toBeNull();

    const forDecision = await listAdrLinksForDecision(tempDir, 'D11165');
    expect(forDecision.map((link) => link.adrSlug)).toEqual(['adr-059-decisions-vs-adrs']);
    const forAdr = await listDecisionLinksForAdr(tempDir, 'adr-059-decisions-vs-adrs');
    expect(forAdr.map((link) => link.decisionId)).toEqual(['D11165']);
  });

  it('natural identity: a repeat link of the same pair is an idempotent no-op', async () => {
    const { linkDecisionToAdr, decisionAdrLinkUid } = await import(
      '../../store/decision-adr-links.js'
    );
    const first = await linkDecisionToAdr(tempDir, {
      decisionId: 'D11164',
      adrSlug: 'adr-058-tiered-methodology',
    });
    const second = await linkDecisionToAdr(tempDir, {
      decisionId: 'D11164',
      adrSlug: 'adr-058-tiered-methodology',
    });
    expect(first.inserted).toBe(true);
    expect(second.inserted).toBe(false);
    expect(second.row.uid).toBe(first.row.uid);
    // The uid is derivable offline from the pair on any device (spec §10).
    expect(first.row.uid).toBe(decisionAdrLinkUid('D11164', 'adr-058-tiered-methodology'));

    const { getDb } = await import('../../store/sqlite.js');
    const { decisionAdrLinks } = await import('../../store/schema/cleo-project/docs.js');
    const db = await getDb(tempDir);
    const rows = await db.select().from(decisionAdrLinks).all();
    expect(rows).toHaveLength(1);
  });

  it('refuses non D#### decision ids and blank slugs before any write', async () => {
    const { linkDecisionToAdr } = await import('../../store/decision-adr-links.js');
    await expect(
      linkDecisionToAdr(tempDir, { decisionId: 'T13359', adrSlug: 'adr-001-x' }),
    ).rejects.toThrow(/bare D####/);
    await expect(
      linkDecisionToAdr(tempDir, { decisionId: 'D11165', adrSlug: '   ' }),
    ).rejects.toThrow(/non-empty/);

    const { getDb } = await import('../../store/sqlite.js');
    const { decisionAdrLinks } = await import('../../store/schema/cleo-project/docs.js');
    const db = await getDb(tempDir);
    expect(await db.select().from(decisionAdrLinks).all()).toHaveLength(0);
  });

  it('revoke is a one-way tombstone latch: hidden from live lists, row survives', async () => {
    const {
      linkDecisionToAdr,
      revokeDecisionAdrLink,
      listAdrLinksForDecision,
      getDecisionAdrLink,
    } = await import('../../store/decision-adr-links.js');
    await linkDecisionToAdr(tempDir, {
      decisionId: 'D11165',
      adrSlug: 'adr-059-decisions-vs-adrs',
    });

    const { row, revoked } = await revokeDecisionAdrLink(tempDir, {
      decisionId: 'D11165',
      adrSlug: 'adr-059-decisions-vs-adrs',
      revokedBy: 'agent-reviewer',
    });
    expect(revoked).toBe(true);
    expect(row.status).toBe('revoked');
    expect(row.revokedBy).toBe('agent-reviewer');

    // Live (default) listings hide the tombstone…
    expect(await listAdrLinksForDecision(tempDir, 'D11165')).toHaveLength(0);
    // …the row itself survives (append-only, no DELETE)…
    const survived = await getDecisionAdrLink(tempDir, 'D11165', 'adr-059-decisions-vs-adrs');
    expect(survived?.status).toBe('revoked');
    // …and includeRevoked surfaces it for audit.
    const all = await listAdrLinksForDecision(tempDir, 'D11165', { includeRevoked: true });
    expect(all).toHaveLength(1);
  });

  it('re-revoke is idempotent; re-link of a revoked pair is refused', async () => {
    const { linkDecisionToAdr, revokeDecisionAdrLink } = await import(
      '../../store/decision-adr-links.js'
    );
    await linkDecisionToAdr(tempDir, {
      decisionId: 'D11165',
      adrSlug: 'adr-059-decisions-vs-adrs',
    });
    const first = await revokeDecisionAdrLink(tempDir, {
      decisionId: 'D11165',
      adrSlug: 'adr-059-decisions-vs-adrs',
    });
    expect(first.revoked).toBe(true);
    const second = await revokeDecisionAdrLink(tempDir, {
      decisionId: 'D11165',
      adrSlug: 'adr-059-decisions-vs-adrs',
    });
    expect(second.revoked).toBe(false);
    expect(second.row.uid).toBe(first.row.uid);

    await expect(
      linkDecisionToAdr(tempDir, { decisionId: 'D11165', adrSlug: 'adr-059-decisions-vs-adrs' }),
    ).rejects.toThrow(/never re-linked/);
  });

  it('revoking a never-linked pair is refused instead of fabricating a tombstone', async () => {
    const { revokeDecisionAdrLink } = await import('../../store/decision-adr-links.js');
    await expect(
      revokeDecisionAdrLink(tempDir, { decisionId: 'D99999', adrSlug: 'adr-999-never' }),
    ).rejects.toThrow(/nothing to revoke/);
  });

  it('one ADR can ratify several decisions and one decision several ADRs', async () => {
    const { linkDecisionToAdr, listDecisionLinksForAdr, listAdrLinksForDecision } = await import(
      '../../store/decision-adr-links.js'
    );
    await linkDecisionToAdr(tempDir, { decisionId: 'D11165', adrSlug: 'adr-059-a' });
    await linkDecisionToAdr(tempDir, { decisionId: 'D11166', adrSlug: 'adr-059-a' });
    await linkDecisionToAdr(tempDir, { decisionId: 'D11165', adrSlug: 'adr-060-b' });

    expect((await listDecisionLinksForAdr(tempDir, 'adr-059-a')).map((r) => r.decisionId)).toEqual([
      'D11165',
      'D11166',
    ]);
    expect((await listAdrLinksForDecision(tempDir, 'D11165')).map((r) => r.adrSlug)).toEqual([
      'adr-059-a',
      'adr-060-b',
    ]);
  });
});
