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
 * enrolled key, and the enrollment itself judges `ok`.
 *
 * ## Revocation, signed and counted (fail closed)
 *
 * Revoking is owner-only like granting (the password signs it). It removes the
 * grant from both files and appends a signed revocation entry to both, and the
 * revocation count is sealed in the git-tracked `.cleo/owner-settings.json`.
 * Every grant also signs the count at issue. If the two revocation lists
 * differ, an entry is not signed, the list is shorter than the sealed count or
 * than any grant's count at issue, or the count's seal fails, EVERY grant is
 * treated as tampered. Restoring old copies of both grant files therefore does
 * not revive a revoked grant: the sealed count still names the revocation, and
 * rolling that back too shows in `git status`. As with the override cap, an
 * agent running as the same OS user can still edit these files: tampering is
 * detectable (refused, audited, shown by `cleo doctor`), not preventable.
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
  readSealedOwnerSetting,
  writeSealedOwnerSetting,
} from '../security/override-cap-setting.js';
import { atomicWriteJson } from '../store/atomic.js';

/** The longest a grant may run (D11215). */
export const RELEASE_AUTHORIZATION_MAX_DAYS = 30;

/** Grant/revoke/refusal audit log, relative to the project root. */
export const RELEASE_AUTHORIZATION_AUDIT_FILE = '.cleo/audit/release-authorizations.jsonl';

/** The tag-message trailer that names the grant a cut used. */
export const AUTHORIZED_BY_TRAILER = 'Authorized-by';

/** The owner-settings key sealing how many grants were ever revoked. */
export const REVOCATION_COUNT_SETTING = 'release.authorizationRevocations';

const PROJECT_FILE = join('.cleo', 'release-authorizations.json');
const CUT_AUDIT_FILE = '.cleo/audit/release-cut.jsonl';

/** One owner-signed revocation. */
interface Revocation {
  id: string;
  revokedAt: string;
  /** Ed25519 signature (hex) over {@link revocationPayload}. */
  sig: string;
}

interface ProjectFile {
  schemaVersion: 1;
  grants: ReleaseAuthorizationGrant[];
  revoked: Revocation[];
}

interface GlobalRecord {
  grants: ReleaseAuthorizationGrant[];
  revoked: Revocation[];
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
  const file = readJson<Partial<ProjectFile>>(join(projectRoot, PROJECT_FILE), {});
  return { schemaVersion: 1, grants: file.grants ?? [], revoked: file.revoked ?? [] };
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
    revocationsAtIssue: g.revocationsAtIssue,
    ownerPubkey: g.ownerPubkey,
  });
}

/** The exact bytes a revocation's signature covers. */
function revocationPayload(
  projectRoot: string,
  r: Omit<Revocation, 'sig'>,
  ownerPubkey: string,
): string {
  return JSON.stringify({
    kind: 'release-authorization-revocation',
    project: projectKey(projectRoot),
    id: r.id,
    revokedAt: r.revokedAt,
    ownerPubkey,
  });
}

/**
 * Why the revocation record cannot be trusted, or null. Any answer other than
 * null makes every grant tampered (fail closed).
 */
async function revocationProblem(
  projectRoot: string,
  project: ProjectFile,
  global: GlobalRecord,
  ownerPubkey: string,
): Promise<string | null> {
  if (JSON.stringify(project.revoked) !== JSON.stringify(global.revoked))
    return 'the project and global revocation lists differ';
  const sealed = await readSealedOwnerSetting(projectRoot, REVOCATION_COUNT_SETTING);
  if (sealed === 'tampered')
    return `${REVOCATION_COUNT_SETTING} is not sealed by the enrolled owner key`;
  const count = sealed ?? 0;
  if (global.revoked.length !== count)
    return `the revocation list holds ${global.revoked.length} entries, but the owner sealed ${count} in .cleo/owner-settings.json`;
  const atIssue = Math.max(
    0,
    ...[...project.grants, ...global.grants].map((g) => g.revocationsAtIssue ?? 0),
  );
  if (atIssue > global.revoked.length)
    return `a grant was issued after ${atIssue} revocations, but only ${global.revoked.length} are listed`;
  const { verifyAuditLine } = await import('../identity/cleo-identity.js');
  for (const r of global.revoked) {
    if (
      !(await verifyAuditLine(revocationPayload(projectRoot, r, ownerPubkey), r.sig, ownerPubkey))
    )
      return `revocation ${r.id} is not signed by the enrolled owner key`;
  }
  return null;
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
  const projectFile = readProject(projectRoot);
  const project = projectFile.grants;
  const global = readGlobal(projectRoot);
  const owner = await judgeOwnerState(projectRoot);
  const revocationWhy =
    owner.kind === 'ok'
      ? await revocationProblem(projectRoot, projectFile, global, owner.file.ownerPubkey)
      : null;
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
    } else if (revocationWhy !== null) {
      state = 'tampered';
      why = revocationWhy;
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
      'E_VALIDATION', // @sync-invariant none:input-shape a malformed grant request is refused before any write
      `--scope must be canary, prerelease, stable or a CalVer version, not "${input.scope}"`,
    );
  const ttl = parseExpiry(input.expires);
  if (ttl === null)
    return refuse(
      'E_VALIDATION', // @sync-invariant none:input-shape a malformed grant request is refused before any write
      `--expires must be like 30m, 24h or 7d, at most ${RELEASE_AUTHORIZATION_MAX_DAYS}d`,
    );
  if (!input.reason.trim()) return refuse('E_VALIDATION', '--reason is required'); // @sync-invariant none:input-shape a malformed grant request is refused before any write
  if (input.uses !== undefined && (!Number.isInteger(input.uses) || input.uses < 1))
    return refuse('E_VALIDATION', '--uses must be a positive integer'); // @sync-invariant none:input-shape a malformed grant request is refused before any write
  const check = ownerCheck(input);
  if (!check.ok) return refuse(check.code, check.message);
  const state = await judgeOwnerState(projectRoot);
  if (state.kind !== 'ok')
    return refuse(
      'E_OWNER_NOT_ENROLLED', // @sync-invariant none:local-only release grants are device-local owner files; refused before any write
      state.kind === 'tampered'
        ? `Owner settings are not usable: ${state.why}`
        : 'No owner is enrolled for this project; the owner enrolls first with `cleo config owner-enroll`.',
    );
  const key = await ownerKey(input.password, state.file.salt);
  if (key.pubkeyHex !== state.file.ownerPubkey)
    return refuse(
      'E_OVERRIDE_TOKEN_INVALID', // @sync-invariant none:local-only release grants are device-local owner files; refused before any write
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
      'E_DECISION_NOT_RECORDED', // @sync-invariant none:local-only the grant is refused before its files are written
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
    revocationsAtIssue: readGlobal(projectRoot).revoked.length,
    ownerPubkey: state.file.ownerPubkey,
  };
  const { signAuditLine } = await import('../identity/cleo-identity.js');
  const { sig } = await signAuditLine(key, grantPayload(projectRoot, unsigned));
  const grant: ReleaseAuthorizationGrant = { ...unsigned, sig };

  const project = readProject(projectRoot);
  await atomicWriteJson(join(projectRoot, PROJECT_FILE), {
    ...project,
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
 * Revoke a grant now. Owner-only like granting (the password signs the
 * revocation): the grant leaves both files, a signed revocation entry joins
 * both, and the revocation count is sealed in `.cleo/owner-settings.json`.
 *
 * @param projectRoot - Project root.
 * @param input - The owner caller and the grant id.
 * @returns The revoked grant, or the refusal.
 *
 * @example
 * ```ts
 * await revokeReleaseAuthorization(root, { ...caller, id: 'ra-1a2b3c4d5e6f' });
 * ```
 *
 * @task T14141
 */
export async function revokeReleaseAuthorization(
  projectRoot: string,
  input: OwnerCaller & { id: string },
): Promise<ReleaseAuthorizationResult> {
  const refuse = (code: string, message: string): ReleaseAuthorizationResult => {
    audit(projectRoot, { action: 'revoke-refused', id: input.id, code, reason: message });
    return { ok: false, code, message };
  };
  const check = ownerCheck(input);
  if (!check.ok) return refuse(check.code, check.message);
  const state = await judgeOwnerState(projectRoot);
  if (state.kind !== 'ok')
    return refuse(
      'E_OWNER_NOT_ENROLLED', // @sync-invariant none:local-only release grants are device-local owner files; refused before any write
      state.kind === 'tampered'
        ? `Owner settings are not usable: ${state.why}`
        : 'No owner is enrolled for this project.',
    );
  const key = await ownerKey(input.password, state.file.salt);
  if (key.pubkeyHex !== state.file.ownerPubkey)
    return refuse(
      'E_OVERRIDE_TOKEN_INVALID', // @sync-invariant none:local-only release grants are device-local owner files; refused before any write
      'The password does not match the owner key enrolled for this project.',
    );
  const project = readProject(projectRoot);
  const global = readGlobal(projectRoot);
  const grant =
    global.grants.find((g) => g.id === input.id) ?? project.grants.find((g) => g.id === input.id);
  if (!grant) return refuse('E_NOT_FOUND', `No release authorization ${input.id}`); // @sync-invariant none:input-shape an unknown grant id is refused before any write
  const unsigned = { id: input.id, revokedAt: new Date().toISOString() };
  const { signAuditLine } = await import('../identity/cleo-identity.js');
  const { sig } = await signAuditLine(
    key,
    revocationPayload(projectRoot, unsigned, state.file.ownerPubkey),
  );
  const revoked = [...global.revoked, { ...unsigned, sig }];
  await atomicWriteJson(join(projectRoot, PROJECT_FILE), {
    schemaVersion: 1,
    grants: project.grants.filter((g) => g.id !== input.id),
    revoked,
  });
  await writeGlobal(projectRoot, {
    grants: global.grants.filter((g) => g.id !== input.id),
    revoked,
  });
  await writeSealedOwnerSetting(projectRoot, REVOCATION_COUNT_SETTING, revoked.length, key);
  audit(projectRoot, { action: 'revoke', id: input.id, scope: grant.scope, count: revoked.length });
  return { ok: true, grant };
}
