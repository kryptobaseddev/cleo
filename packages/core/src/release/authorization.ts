/**
 * Standing release authorization (T14141 · owner decisions D11212, D11215).
 *
 * `cleo release cut --yes` tags when the person at the terminal types the
 * version, or when the owner stored a standing authorization covering it (an
 * agent). A grant is created only through the owner check of
 * `cleo config owner set` (T13787): not a restricted agent role, a TTY, and the
 * owner-auth password typed now. It is signed with the enrolled owner key
 * (`ownerKey`), so an agent cannot forge or widen one without the password.
 *
 * ## Storage, anchored twice
 *
 * The grant lives in `.cleo/release-authorizations.json` (untracked) AND in
 * `<cleoHome>/release-authorizations.json` under the project's key. It counts
 * only when both copies are identical, the signature verifies against the
 * enrolled key, and the enrollment itself judges `ok`. Revoking removes it
 * from both and records the id as revoked in the global file, so restoring an
 * old project file does not revive it. As with the override cap, an agent
 * running as the same OS user can still edit both files: tampering is
 * detectable (audited, shown by `cleo doctor`), not preventable.
 *
 * ## Scope, expiry, uses (D11215)
 *
 * Scope `canary`, `prerelease`, `stable` or one exact version; `cut`'s own
 * version gates (CalVer, above the newest tag) still apply. Expiry is required,
 * at most 30 days. `uses` is an optional cap; without it the count is only
 * reported. Uses are counted from the cut audit rows and from the tags whose
 * message names the grant (`Authorized-by: <id>`), whichever is higher.
 *
 * @task T14141
 * @task T14102
 */

import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type {
  ReleaseAuthorizationGrant,
  ReleaseAuthorizationScope,
  ReleaseAuthorizationStatus,
} from '@cleocode/contracts/release/authorization.js';
import { getCleoHome } from '../paths.js';
import {
  judgeOwnerState,
  type OwnerCaller,
  ownerCheck,
  ownerKey,
  projectKey,
  provenance,
} from '../security/override-cap-setting.js';
import { isAgentRoleForbidden, isTtyPresent } from '../security/owner-override-auth.js';
import { atomicWriteJson } from '../store/atomic.js';

/** The longest a grant may run (D11215). */
export const RELEASE_AUTHORIZATION_MAX_DAYS = 30;

/** Grant/revoke/refusal audit log, relative to the project root. */
export const RELEASE_AUTHORIZATION_AUDIT_FILE = '.cleo/audit/release-authorizations.jsonl';

/** The tag-message trailer that names the grant a cut used. */
export const AUTHORIZED_BY_TRAILER = 'Authorized-by';

const PROJECT_FILE = join('.cleo', 'release-authorizations.json');
const CUT_AUDIT_FILE = '.cleo/audit/release-cut.jsonl';

interface ProjectFile {
  schemaVersion: 1;
  grants: ReleaseAuthorizationGrant[];
}

interface GlobalRecord {
  grants: ReleaseAuthorizationGrant[];
  revoked: Array<{ id: string; revokedAt: string }>;
}

/** Outcome of a grant or revoke. */
export type ReleaseAuthorizationResult =
  | { ok: true; grant: ReleaseAuthorizationGrant }
  | { ok: false; code: string; message: string };

function globalPath(): string {
  return join(getCleoHome(), 'release-authorizations.json');
}

function readJson<T>(path: string, fallback: T): T {
  try {
    return existsSync(path) ? (JSON.parse(readFileSync(path, 'utf-8')) as T) : fallback;
  } catch {
    return fallback;
  }
}

function readProject(projectRoot: string): ProjectFile {
  return readJson<ProjectFile>(join(projectRoot, PROJECT_FILE), { schemaVersion: 1, grants: [] });
}

function readGlobalAll(): Record<string, GlobalRecord> {
  return readJson<{ projects?: Record<string, GlobalRecord> }>(globalPath(), {}).projects ?? {};
}

function readGlobal(projectRoot: string): GlobalRecord {
  const record = readGlobalAll()[projectKey(projectRoot)];
  return { grants: record?.grants ?? [], revoked: record?.revoked ?? [] };
}

async function writeGlobal(projectRoot: string, record: GlobalRecord): Promise<void> {
  const all = readGlobalAll();
  all[projectKey(projectRoot)] = record;
  await atomicWriteJson(globalPath(), { schemaVersion: 1, projects: all });
}

/** The exact bytes a grant's signature covers. */
function grantPayload(projectRoot: string, g: Omit<ReleaseAuthorizationGrant, 'sig'>): string {
  return JSON.stringify({
    kind: 'release-authorization',
    project: projectKey(projectRoot),
    id: g.id,
    scope: g.scope,
    reason: g.reason,
    issuedAt: g.issuedAt,
    expiresAt: g.expiresAt,
    uses: g.uses,
    decisionId: g.decisionId,
    ownerPubkey: g.ownerPubkey,
  });
}

function audit(projectRoot: string, row: Record<string, string | number | null | boolean>): void {
  try {
    const path = join(projectRoot, RELEASE_AUTHORIZATION_AUDIT_FILE);
    mkdirSync(dirname(path), { recursive: true });
    const who = provenance(process.env['CLEO_SESSION_ID'] ?? null);
    appendFileSync(
      path,
      `${JSON.stringify({ at: new Date().toISOString(), ...row, tty: who.tty, parent: who.parent, pid: process.pid })}\n`,
      'utf-8',
    );
  } catch {
    // non-fatal: the signed grant files are the record
  }
}

/**
 * Parse a scope argument.
 *
 * @param raw - `canary`, `prerelease`, `stable`, or a version (`2026.10.28`, `v2026.10.28-canary.1`).
 * @returns The scope, or null when it is none of those.
 */
export function parseReleaseAuthorizationScope(raw: string): ReleaseAuthorizationScope | null {
  if (raw === 'canary' || raw === 'prerelease' || raw === 'stable') return raw;
  const v = raw.startsWith('v') ? raw : `v${raw}`;
  return /^v\d{4}\.\d{1,2}\.\d+(-[0-9A-Za-z.-]+)?$/.test(v) ? (v as `v${string}`) : null;
}

/**
 * Whether `scope` covers `version` (`v`-prefixed).
 *
 * @param scope - The grant scope.
 * @param version - The version being cut.
 * @returns True when the grant applies.
 */
export function scopeCovers(scope: ReleaseAuthorizationScope, version: string): boolean {
  if (scope === 'canary') return /-canary\.\d+$/.test(version);
  if (scope === 'prerelease') return version.includes('-');
  if (scope === 'stable') return !version.includes('-');
  return scope === version;
}

/** Parse `30m`, `24h` or `7d` into milliseconds; null when malformed or over 30 days. */
function parseExpiry(raw: string): number | null {
  const m = /^(\d+)([mhd])$/.exec(raw.trim());
  if (!m) return null;
  const ms = Number(m[1]) * { m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2] as 'm' | 'h' | 'd'];
  return ms > 0 && ms <= RELEASE_AUTHORIZATION_MAX_DAYS * 86_400_000 ? ms : null;
}

/** Cuts a grant has allowed: audit rows or tags naming it, whichever is higher. */
function usesOf(projectRoot: string, id: string): number {
  let rows = 0;
  try {
    for (const line of readFileSync(join(projectRoot, CUT_AUDIT_FILE), 'utf-8').split('\n')) {
      if (line.includes(`"allowedBy":"authorization:${id}"`) && line.includes('"outcome":"tagged"'))
        rows++;
    }
  } catch {
    rows = 0;
  }
  let tags = 0;
  try {
    tags = execFileSync('git', ['for-each-ref', '--format=%(contents)', 'refs/tags/v*'], {
      cwd: projectRoot,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .split('\n')
      .filter((l) => l.trim() === `${AUTHORIZED_BY_TRAILER}: ${id}`).length;
  } catch {
    tags = 0;
  }
  return Math.max(rows, tags);
}

/**
 * Every grant the project knows of, with its state: active, expired, used up,
 * revoked, or tampered (not identical in both files, unsigned, or the owner
 * enrollment itself is not `ok`).
 *
 * @param projectRoot - Project root.
 * @param now - Clock (tests).
 * @returns The grants, newest first.
 *
 * @example
 * ```ts
 * const active = (await listReleaseAuthorizations(root)).filter((g) => g.state === 'active');
 * ```
 *
 * @task T14141
 */
export async function listReleaseAuthorizations(
  projectRoot: string,
  now: Date = new Date(),
): Promise<ReleaseAuthorizationStatus[]> {
  const project = readProject(projectRoot).grants;
  const global = readGlobal(projectRoot);
  const owner = await judgeOwnerState(projectRoot);
  const { verifyAuditLine } = await import('../identity/cleo-identity.js');
  const ids = [...new Set([...project, ...global.grants].map((g) => g.id))];
  const out: ReleaseAuthorizationStatus[] = [];
  for (const id of ids) {
    const p = project.find((g) => g.id === id);
    const g = global.grants.find((x) => x.id === id);
    const grant = (g ?? p) as ReleaseAuthorizationGrant;
    const used = usesOf(projectRoot, id);
    let state: ReleaseAuthorizationStatus['state'] = 'active';
    let why: string | undefined;
    if (global.revoked.some((r) => r.id === id)) {
      state = 'revoked';
    } else if (!p || !g || JSON.stringify(p) !== JSON.stringify(g)) {
      state = 'tampered';
      why = 'the project and global copies differ or one is missing';
    } else if (owner.kind !== 'ok') {
      state = 'tampered';
      why = owner.kind === 'tampered' ? owner.why : 'no owner is enrolled';
    } else if (
      grant.ownerPubkey !== owner.file.ownerPubkey ||
      !(await verifyAuditLine(grantPayload(projectRoot, grant), grant.sig, grant.ownerPubkey))
    ) {
      state = 'tampered';
      why = 'the grant is not signed by the enrolled owner key';
    } else if (Date.parse(grant.expiresAt) <= now.getTime()) {
      state = 'expired';
    } else if (grant.uses !== null && used >= grant.uses) {
      state = 'used-up';
    }
    out.push({ ...grant, state, used, ...(why ? { why } : {}) });
  }
  return out.sort((a, b) => b.issuedAt.localeCompare(a.issuedAt));
}

/**
 * The active grant covering `version`, or null. This is the seam
 * `cleo release cut --yes` consults before asking on the terminal (D11212).
 *
 * @param projectRoot - Project whose authorization is read.
 * @param version - Version being cut (`v`-prefixed).
 * @returns The grant's id when an active, verified grant covers the cut.
 *
 * @example
 * ```ts
 * const auth = await releaseAuthorizationFor(projectRoot, 'v2026.10.28');
 * ```
 *
 * @task T14141
 */
export async function releaseAuthorizationFor(
  projectRoot: string,
  version: string,
): Promise<{ id: string } | null> {
  const grants = await listReleaseAuthorizations(projectRoot);
  for (const g of grants.filter((x) => x.state === 'tampered' && scopeCovers(x.scope, version))) {
    audit(projectRoot, {
      action: 'tampered-ignored',
      id: g.id,
      version,
      reason: g.why ?? 'tampered',
    });
  }
  const hit = grants.find((g) => g.state === 'active' && scopeCovers(g.scope, version));
  return hit ? { id: hit.id } : null;
}

/**
 * Grant a standing release authorization. Owner-only: the T13787 owner check
 * (role fence, TTY, the owner-auth password against the bound session), an
 * `ok` owner enrollment, and the password deriving the enrolled key. The grant
 * is recorded as an owner decision and audited.
 *
 * @param projectRoot - Project root.
 * @param input - The owner caller, scope, expiry (`30m`/`24h`/`30d`), reason, optional use cap.
 * @returns The signed grant, or the refusal.
 *
 * @example
 * ```ts
 * await grantReleaseAuthorization(root, { ...caller, scope: 'canary', expires: '7d', reason: 'canary train' });
 * ```
 *
 * @task T14141
 */
export async function grantReleaseAuthorization(
  projectRoot: string,
  input: OwnerCaller & { scope: string; expires: string; reason: string; uses?: number },
): Promise<ReleaseAuthorizationResult> {
  const refuse = (code: string, message: string): ReleaseAuthorizationResult => {
    audit(projectRoot, { action: 'grant-refused', code, reason: message, scope: input.scope });
    return { ok: false, code, message };
  };
  const scope = parseReleaseAuthorizationScope(input.scope);
  if (scope === null)
    return refuse(
      'E_VALIDATION',
      `--scope must be canary, prerelease, stable or a CalVer version, not "${input.scope}"`,
    );
  const ttl = parseExpiry(input.expires);
  if (ttl === null)
    return refuse(
      'E_VALIDATION',
      `--expires must be like 30m, 24h or 7d, at most ${RELEASE_AUTHORIZATION_MAX_DAYS}d`,
    );
  if (!input.reason.trim()) return refuse('E_VALIDATION', '--reason is required');
  if (input.uses !== undefined && (!Number.isInteger(input.uses) || input.uses < 1))
    return refuse('E_VALIDATION', '--uses must be a positive integer');
  const check = ownerCheck(input);
  if (!check.ok) return refuse(check.code, check.message);
  const state = await judgeOwnerState(projectRoot);
  if (state.kind !== 'ok')
    return refuse(
      'E_OWNER_NOT_ENROLLED',
      state.kind === 'tampered'
        ? `Owner settings are not usable: ${state.why}`
        : 'No owner is enrolled for this project; the owner enrolls first with `cleo config owner-enroll`.',
    );
  const key = await ownerKey(input.password, state.file.salt);
  if (key.pubkeyHex !== state.file.ownerPubkey)
    return refuse(
      'E_OVERRIDE_TOKEN_INVALID',
      'The password does not match the owner key enrolled for this project.',
    );

  const id = `ra-${randomBytes(6).toString('hex')}`;
  const issuedAt = new Date();
  const expiresAt = new Date(issuedAt.getTime() + ttl).toISOString();
  let decisionId: string;
  try {
    const { storeDecision } = await import('../memory/decisions.js');
    const row = await storeDecision(projectRoot, {
      type: 'process',
      decision: `Standing release authorization ${id}: scope ${scope} until ${expiresAt}${input.uses ? `, at most ${input.uses} cut(s)` : ''}`,
      rationale: input.reason.trim(),
      confidence: 'high',
      confirmationState: 'accepted',
      decidedBy: 'owner',
      contextTaskId: 'T14141',
    });
    decisionId = row.id;
  } catch (err) {
    return refuse(
      'E_DECISION_NOT_RECORDED',
      `The owner decision could not be recorded: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const unsigned = {
    id,
    scope,
    reason: input.reason.trim(),
    issuedAt: issuedAt.toISOString(),
    expiresAt,
    uses: input.uses ?? null,
    decisionId,
    ownerPubkey: state.file.ownerPubkey,
  };
  const { signAuditLine } = await import('../identity/cleo-identity.js');
  const { sig } = await signAuditLine(key, grantPayload(projectRoot, unsigned));
  const grant: ReleaseAuthorizationGrant = { ...unsigned, sig };

  const project = readProject(projectRoot);
  await atomicWriteJson(join(projectRoot, PROJECT_FILE), {
    schemaVersion: 1,
    grants: [...project.grants, grant],
  });
  const global = readGlobal(projectRoot);
  await writeGlobal(projectRoot, { ...global, grants: [...global.grants, grant] });
  audit(projectRoot, {
    action: 'grant',
    id,
    scope,
    expiresAt,
    uses: grant.uses,
    decisionId,
    sessionId: input.session?.id ?? null,
  });
  return { ok: true, grant };
}

/**
 * Revoke a grant now. Revoking only removes power, so it needs the role fence
 * and a TTY but not the password. The grant leaves both files and its id is
 * recorded as revoked in the global file.
 *
 * @param projectRoot - Project root.
 * @param id - Grant id.
 * @returns The revoked grant, or the refusal.
 *
 * @example
 * ```ts
 * await revokeReleaseAuthorization(root, 'ra-1a2b3c4d5e6f');
 * ```
 *
 * @task T14141
 */
export async function revokeReleaseAuthorization(
  projectRoot: string,
  id: string,
): Promise<ReleaseAuthorizationResult> {
  if (isAgentRoleForbidden() || !isTtyPresent()) {
    const message = 'Only the owner at a terminal can revoke a release authorization.';
    audit(projectRoot, { action: 'revoke-refused', id, reason: message });
    return { ok: false, code: 'E_OVERRIDE_REFUSED', message };
  }
  const project = readProject(projectRoot);
  const global = readGlobal(projectRoot);
  const grant = global.grants.find((g) => g.id === id) ?? project.grants.find((g) => g.id === id);
  if (!grant) return { ok: false, code: 'E_NOT_FOUND', message: `No release authorization ${id}` };
  await atomicWriteJson(join(projectRoot, PROJECT_FILE), {
    schemaVersion: 1,
    grants: project.grants.filter((g) => g.id !== id),
  });
  await writeGlobal(projectRoot, {
    grants: global.grants.filter((g) => g.id !== id),
    revoked: [...global.revoked, { id, revokedAt: new Date().toISOString() }],
  });
  audit(projectRoot, { action: 'revoke', id, scope: grant.scope });
  return { ok: true, grant };
}
