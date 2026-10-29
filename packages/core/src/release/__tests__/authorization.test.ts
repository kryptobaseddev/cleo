/**
 * Standing release authorization (T14141 · D11215): owner-signed grants,
 * anchored in the project and global files, scoped, expiring, revocable, and
 * audited; tampering is detected and ignored.
 *
 * @task T14141
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const PASSWORD = 'owner-password';
let home = '';
let enrolled: { ownerPubkey: string; salt: string } | null = null;
let ownerOk = true;
let terminal = true;

vi.mock('../../paths.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../paths.js')>()),
  getCleoHome: () => home,
}));
vi.mock('../../security/override-cap-setting.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../security/override-cap-setting.js')>()),
  judgeOwnerState: async () =>
    enrolled
      ? { kind: 'ok', file: { ...enrolled, settings: {} }, global: {}, cap: null }
      : { kind: 'none' },
  ownerCheck: () =>
    ownerOk ? { ok: true } : { ok: false, code: 'E_OVERRIDE_REFUSED', message: 'not the owner' },
}));
vi.mock('../../security/owner-override-auth.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../security/owner-override-auth.js')>()),
  isAgentRoleForbidden: () => false,
  isTtyPresent: () => terminal,
}));
vi.mock('../../memory/decisions.js', () => ({ storeDecision: async () => ({ id: 'D-test' }) }));

import { ownerKey } from '../../security/override-cap-setting.js';
import {
  grantReleaseAuthorization,
  listReleaseAuthorizations,
  RELEASE_AUTHORIZATION_AUDIT_FILE,
  releaseAuthorizationFor,
  revokeReleaseAuthorization,
} from '../authorization.js';

let root = '';
const caller = { password: PASSWORD, session: { id: 'ses-owner', name: 'owner', token: 'x' } };

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'ra-project-'));
  home = mkdtempSync(join(tmpdir(), 'ra-home-'));
  const salt = '00112233445566778899aabbccddeeff';
  enrolled = { ownerPubkey: (await ownerKey(PASSWORD, salt)).pubkeyHex, salt };
  ownerOk = true;
  terminal = true;
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

async function grant(scope: string, extra: { expires?: string; uses?: number } = {}) {
  const result = await grantReleaseAuthorization(root, {
    ...caller,
    scope,
    expires: extra.expires ?? '7d',
    reason: 'canary train this week',
    ...(extra.uses !== undefined ? { uses: extra.uses } : {}),
  });
  if (!result.ok) throw new Error(result.message);
  return result.grant;
}

describe('grantReleaseAuthorization (T14141)', () => {
  it('signs a grant that covers its scope only, records the owner decision, and audits it', async () => {
    const g = await grant('canary');
    expect(g.decisionId).toBe('D-test');
    expect(await releaseAuthorizationFor(root, 'v2026.10.28-canary.1')).toEqual({ id: g.id });
    expect(await releaseAuthorizationFor(root, 'v2026.10.28')).toBeNull();
    const audit = readFileSync(join(root, RELEASE_AUTHORIZATION_AUDIT_FILE), 'utf-8');
    expect(JSON.parse(audit.trim().split('\n').at(-1) ?? '{}')).toMatchObject({
      action: 'grant',
      id: g.id,
      scope: 'canary',
    });
  });

  it('allows a stable scope and an exact version scope', async () => {
    const stable = await grant('stable');
    expect(await releaseAuthorizationFor(root, 'v2026.10.28')).toEqual({ id: stable.id });
    await revokeReleaseAuthorization(root, stable.id);
    const exact = await grant('2026.10.29');
    expect(await releaseAuthorizationFor(root, 'v2026.10.29')).toEqual({ id: exact.id });
    expect(await releaseAuthorizationFor(root, 'v2026.10.30')).toBeNull();
  });

  it('refuses a non-owner, a wrong password, a bad scope and an expiry over 30 days', async () => {
    ownerOk = false;
    const notOwner = await grantReleaseAuthorization(root, {
      ...caller,
      scope: 'canary',
      expires: '1d',
      reason: 'x',
    });
    expect(notOwner.ok).toBe(false);
    ownerOk = true;
    const wrong = await grantReleaseAuthorization(root, {
      ...caller,
      password: 'nope',
      scope: 'canary',
      expires: '1d',
      reason: 'x',
    });
    expect(!wrong.ok && wrong.message).toContain('does not match');
    const badScope = await grantReleaseAuthorization(root, {
      ...caller,
      scope: 'everything',
      expires: '1d',
      reason: 'x',
    });
    expect(badScope.ok).toBe(false);
    const tooLong = await grantReleaseAuthorization(root, {
      ...caller,
      scope: 'canary',
      expires: '31d',
      reason: 'x',
    });
    expect(tooLong.ok).toBe(false);
    expect(await listReleaseAuthorizations(root)).toEqual([]);
  });

  it('an expired grant no longer covers a cut', async () => {
    const g = await grant('canary', { expires: '1h' });
    const later = new Date(Date.now() + 2 * 3_600_000);
    const [status] = await listReleaseAuthorizations(root, later);
    expect(status).toMatchObject({ id: g.id, state: 'expired' });
  });

  it('counts uses against an optional cap', async () => {
    const g = await grant('canary', { uses: 1 });
    writeFileSync(
      join(root, '.cleo', 'audit', 'release-cut.jsonl'),
      `${JSON.stringify({ outcome: 'tagged', allowedBy: `authorization:${g.id}` })}\n`,
    );
    const [status] = await listReleaseAuthorizations(root);
    expect(status).toMatchObject({ state: 'used-up', used: 1 });
    expect(await releaseAuthorizationFor(root, 'v2026.10.28-canary.1')).toBeNull();
  });
});

describe('revokeReleaseAuthorization (T14141)', () => {
  it('ends a grant now, and restoring the old project file does not revive it', async () => {
    const g = await grant('canary');
    const before = readFileSync(join(root, '.cleo', 'release-authorizations.json'), 'utf-8');
    const revoked = await revokeReleaseAuthorization(root, g.id);
    expect(revoked.ok).toBe(true);
    expect(await releaseAuthorizationFor(root, 'v2026.10.28-canary.1')).toBeNull();
    writeFileSync(join(root, '.cleo', 'release-authorizations.json'), before);
    expect(await releaseAuthorizationFor(root, 'v2026.10.28-canary.1')).toBeNull();
  });

  it('needs a terminal', async () => {
    const g = await grant('canary');
    terminal = false;
    const result = await revokeReleaseAuthorization(root, g.id);
    expect(result.ok).toBe(false);
  });
});

describe('tampering (T14141)', () => {
  it('ignores a grant edited in place or missing from the global file', async () => {
    const g = await grant('canary');
    const path = join(root, '.cleo', 'release-authorizations.json');
    const file = JSON.parse(readFileSync(path, 'utf-8'));
    file.grants[0].scope = 'stable';
    writeFileSync(path, JSON.stringify(file));
    const [status] = await listReleaseAuthorizations(root);
    expect(status).toMatchObject({ id: g.id, state: 'tampered' });
    expect(await releaseAuthorizationFor(root, 'v2026.10.28')).toBeNull();

    // Same edit in both files: anchored, but the owner signature no longer verifies.
    const globalPath = join(home, 'release-authorizations.json');
    const global = JSON.parse(readFileSync(globalPath, 'utf-8'));
    for (const record of Object.values(global.projects) as Array<{
      grants: Array<{ scope: string }>;
    }>)
      record.grants[0] = { ...record.grants[0], scope: 'stable' };
    writeFileSync(globalPath, JSON.stringify(global));
    writeFileSync(
      path,
      JSON.stringify({
        ...file,
        grants: (Object.values(global.projects)[0] as { grants: unknown[] }).grants,
      }),
    );
    const [resigned] = await listReleaseAuthorizations(root);
    expect(resigned?.state).toBe('tampered');
    expect(resigned?.why).toContain('not signed');
  });
});
