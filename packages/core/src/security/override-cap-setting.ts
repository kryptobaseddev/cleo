/**
 * The per-project owner override cap setting (T13787, owner decision
 * 2026-10-16): `evidence.overrideCapPerSession` replaces the fixed cap of 10
 * per session, and ONLY the owner may change it.
 *
 * ## Threat model
 *
 * An agent running as the same OS user can rewrite any local file, so no
 * local check is tamper-proof. The goal is narrower and achievable: an agent
 * cannot raise the cap through the supported path, and cannot raise it
 * silently. Tampering is detectable, not preventable.
 *
 * ## Enrollment (explicit, owner-only, anchored twice)
 *
 * `cleo config owner-enroll` (never a side effect of a set) derives an Ed25519
 * key from the owner-auth password (scrypt over a fresh per-project salt) and
 * records its public key in two places a single file edit cannot reset:
 *  - `.cleo/owner-settings.json`, which is tracked in git like
 *    `.cleo/project.json` (ADR-094), so a delete or forge shows in
 *    `git status` and PR diffs;
 *  - the global store (`<cleoHome>/owner-enrollments.json`), keyed by project
 *    id, with when, which session and which terminal enrolled it.
 * Re-enrolling over an existing record needs `--reset`, which is audited.
 * `cleo doctor` reports the enrollment and any mismatch.
 *
 * ## Who may enroll or set
 *
 * T1118 L4 as built: not a restricted agent role, stdin and stderr a TTY, and
 * the password typed now matching the bound session's owner-auth verifier
 * (`cleo session start --scope global --name owner --owner-auth`). A pty
 * (`script`) passes the TTY check, so an agent CAN enroll in a project that has
 * no enrollment yet — which is why enrollment is explicit, recorded with its
 * terminal, and shown by `cleo doctor` and git.
 *
 * ## Reading
 *
 * The cap is the sealed value only when the project file and the global record
 * agree on the key and the seal verifies. A missing or unreadable file with a
 * global record, a file with no global record, a key mismatch or a bad seal
 * each fall back to {@link DEFAULT_OVERRIDE_CAP_PER_SESSION}, with a warning and
 * an audit line in `.cleo/audit/force-bypass.jsonl`. Every set and every
 * refused attempt is audited there with the old and new value. Who may use
 * `CLEO_OWNER_OVERRIDE=1` at all is decided by `owner-override-authority.ts`
 * (T13790).
 *
 * @task T13787
 */

import { execFileSync } from 'node:child_process';
import { createHash, randomBytes, scryptSync } from 'node:crypto';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { BRANCH_LOCK_ERROR_CODES } from '@cleocode/contracts/branch-lock.js';
import { readPortableProjectId } from '@cleocode/paths';
import { getCleoHome } from '../paths.js';
import { atomicWriteJson } from '../store/atomic.js';
import {
  DEFAULT_OVERRIDE_CAP_PER_SESSION,
  MAX_OVERRIDE_CAP_PER_SESSION,
  OVERRIDE_CAP_OWNER_COMMAND,
  OVERRIDE_CAP_SETTING,
} from './override-cap.js';
import {
  appendOwnerOverrideAudit,
  isTtyPresent,
  OWNER_SCRYPT_PARAMS,
  OWNER_SESSION_MARK,
  validateOwnerOverride,
  verifyOwnerAuthPassword,
} from './owner-override-auth.js';

/** The explicit owner enrollment command, named in every refusal. */
export const OWNER_ENROLL_COMMAND = 'cleo config owner-enroll';

/** How the owner runs {@link OVERRIDE_CAP_OWNER_COMMAND}. */
const OWNER_HOW =
  'run it yourself in an interactive terminal, in a session started with `cleo session start --scope global --name owner --owner-auth`';

/** One sealed setting. */
interface SealedSetting {
  value: number;
  setAt: string;
  /** Ed25519 signature (hex) over {@link sealPayload}. */
  sig: string;
}

/** Who enrolled, as far as the machine can tell (for `cleo doctor`). */
interface EnrollmentProvenance {
  enrolledAt: string;
  sessionId: string | null;
  /** Controlling terminal of the enrolling process (`ps -o tty`), or null. */
  tty: string | null;
  /** Command of the enrolling process's parent (e.g. `zsh`, or `script`). */
  parent: string | null;
}

/** `.cleo/owner-settings.json` (git-tracked). */
interface OwnerSettingsFile extends EnrollmentProvenance {
  schemaVersion: 1;
  /** Enrolled owner public key (hex), derived from the owner-auth password. */
  ownerPubkey: string;
  /** Per-project scrypt salt (hex). */
  salt: string;
  settings: Record<string, SealedSetting>;
}

/** One project's record in `<cleoHome>/owner-enrollments.json`. */
interface GlobalEnrollment extends EnrollmentProvenance {
  ownerPubkey: string;
  fingerprint: string;
  projectRoot: string;
  /**
   * The key's scrypt salt (review-2253 round 3), so a reset can prove the old
   * owner password while this record is intact, even with the project file gone.
   */
  salt?: string;
  /**
   * Set when an enrollment replaced another without proof of the old owner:
   * `tampered` (the project file was there but unanchored) or
   * `fresh-after-removal` (`--reset` with both anchors gone). `cleo doctor`
   * FAILs until the owner confirms (`owner-enroll --confirm`).
   */
  resetFrom?: 'tampered' | 'fresh-after-removal' | 'history-unavailable';
  /** The `resetFrom` state last audited as unconfirmed, so a read audits it once. */
  unconfirmedAudited?: string;
  /** When the owner confirmed an unproven reset. */
  confirmedAt?: string;
}

/** What the override cap resolves to for a project. */
export interface OverrideCapResolution {
  /** The cap in force. */
  cap: number;
  /** Where it came from. */
  source: 'default' | 'owner-setting';
  /** Set when stored owner state was ignored (missing, unanchored, mismatched or unsealed). */
  warning?: string;
}

/** Outcome of an owner set. */
export type OverrideCapSetResult =
  | {
      ok: true;
      /** The cap now in force. */
      value: number;
      /** The cap before the set. */
      previous: number;
      /** True when the requested value exceeded {@link MAX_OVERRIDE_CAP_PER_SESSION}. */
      clamped: boolean;
    }
  | { ok: false; code: string; message: string };

/** Outcome of an owner enrollment. */
export type OwnerEnrollResult =
  | { ok: true; fingerprint: string; reset: boolean }
  | { ok: false; code: string; message: string };

/** The owner caller: the password typed now and the bound session. */
export interface OwnerCaller {
  password: string;
  session: { id: string; name: string | null; token: string | null } | null;
}

/** The enrollment state `cleo doctor` reports. */
export interface OwnerEnrollmentStatus {
  status: 'none' | 'enrolled' | 'unconfirmed' | 'tampered';
  message: string;
  fingerprint?: string;
  enrolledAt?: string;
  sessionId?: string | null;
  tty?: string | null;
  parent?: string | null;
  cap: number;
  /**
   * Why the owner should look (review-2253 round 2): a recent enrollment, a
   * pty-wrapper parent, or a project file git ignores or has not committed.
   */
  warnings: string[];
}

/** An enrollment younger than this is reported as a doctor WARN. */
const RECENT_ENROLLMENT_MS = 7 * 24 * 60 * 60 * 1000;

/** Parent commands that wrap a fake terminal around a process. */
const PTY_WRAPPERS = /(^|\/)(script|expect|unbuffer)$/;

/** Git's view of the project file, as `cleo doctor project-identity` checks identity files. */
function trackingWarnings(projectRoot: string): string[] {
  const rel = '.cleo/owner-settings.json';
  const git = (args: string[]): { ok: boolean; out: string } => {
    try {
      const out = execFileSync('git', args, {
        cwd: projectRoot,
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      return { ok: true, out };
    } catch {
      return { ok: false, out: '' };
    }
  };
  if (!git(['rev-parse', '--is-inside-work-tree']).ok) return [];
  if (git(['check-ignore', '-q', '--', rel]).ok)
    return [
      `${rel} is git-ignored, so a delete or forge would not show in git; add \`!owner-settings.json\` to .cleo/.gitignore (cleo upgrade) and commit it`,
    ];
  if (!git(['ls-files', '--error-unmatch', '--', rel]).ok)
    return [
      `${rel} is not tracked in git; commit it so a delete or forge shows in git status and PR diffs`,
    ];
  if (git(['status', '--porcelain', '--', rel]).out.trim() !== '')
    return [
      `${rel} has uncommitted changes; review and commit them (or restore it from git if you did not make them)`,
    ];
  return [];
}

/**
 * What git history says about an earlier enrollment (T13829, review-2253):
 * `present` when `.cleo/owner-settings.json` appears on any ref or in the
 * reflog (a commit that deleted it, or a deleted ref, cannot hide it);
 * `unavailable` when history cannot prove absence (a shallow clone, or git
 * erroring inside a work tree); `none` only when it is provably absent or the
 * project is not a git work tree at all.
 */
function settingsHistory(projectRoot: string): 'none' | 'present' | 'unavailable' {
  const git = (args: string[]): string | null => {
    try {
      return execFileSync('git', args, {
        cwd: projectRoot,
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
    } catch {
      return null;
    }
  };
  if (git(['rev-parse', '--is-inside-work-tree']) !== 'true') return 'none';
  const shallow = git(['rev-parse', '--is-shallow-repository']);
  if (shallow !== 'false') return 'unavailable';
  const log = git([
    'log',
    '--all',
    '--reflog',
    '--format=%H',
    '-n',
    '1',
    '--',
    '.cleo/owner-settings.json',
  ]);
  if (log === null) return 'unavailable';
  return log === '' ? 'none' : 'present';
}

function settingsPath(projectRoot: string): string {
  return join(projectRoot, '.cleo', 'owner-settings.json');
}

function globalPath(): string {
  return join(getCleoHome(), 'owner-enrollments.json');
}

/** The global record key: the portable project id, else the real path. */
function projectKey(projectRoot: string): string {
  const id = readPortableProjectId(projectRoot);
  if (id.status === 'valid') return id.projectId;
  try {
    return `path:${realpathSync(projectRoot)}`;
  } catch {
    return `path:${projectRoot}`;
  }
}

function fingerprintOf(pubkey: string): string {
  return createHash('sha256').update(pubkey).digest('hex').slice(0, 16);
}

/** The project file: absent, readable, or unreadable (garbage, no key). */
function readSettings(
  projectRoot: string,
):
  | { state: 'absent' }
  | { state: 'read'; file: OwnerSettingsFile }
  | { state: 'bad'; why: string } {
  if (!existsSync(settingsPath(projectRoot))) return { state: 'absent' };
  try {
    const parsed = JSON.parse(
      readFileSync(settingsPath(projectRoot), 'utf-8'),
    ) as Partial<OwnerSettingsFile>;
    if (typeof parsed.ownerPubkey !== 'string' || typeof parsed.salt !== 'string')
      return { state: 'bad', why: 'it has no enrolled owner key' };
    return {
      state: 'read',
      file: {
        schemaVersion: 1,
        ownerPubkey: parsed.ownerPubkey,
        salt: parsed.salt,
        settings: parsed.settings ?? {},
        enrolledAt: parsed.enrolledAt ?? '',
        sessionId: parsed.sessionId ?? null,
        tty: parsed.tty ?? null,
        parent: parsed.parent ?? null,
      },
    };
  } catch (err) {
    return { state: 'bad', why: err instanceof Error ? err.message : String(err) };
  }
}

function readGlobalAll(): Record<string, GlobalEnrollment> {
  try {
    const parsed = JSON.parse(readFileSync(globalPath(), 'utf-8')) as {
      projects?: Record<string, GlobalEnrollment>;
    };
    return parsed.projects ?? {};
  } catch {
    return {};
  }
}

function readGlobal(projectRoot: string): GlobalEnrollment | null {
  return readGlobalAll()[projectKey(projectRoot)] ?? null;
}

/** The exact bytes a seal signs. */
function sealPayload(
  key: string,
  value: number,
  setAt: string,
  salt: string,
  ownerPubkey: string,
): string {
  return JSON.stringify({ key, value, setAt, salt, ownerPubkey });
}

/** The owner's signing key: Ed25519 from scrypt(password, salt). */
async function ownerKey(password: string, salt: string) {
  const { AgentIdentity } = await import('../identity/cleo-identity.js');
  return AgentIdentity.fromSeed(
    new Uint8Array(scryptSync(password, Buffer.from(salt, 'hex'), 32, OWNER_SCRYPT_PARAMS)),
  );
}

/** Best-effort terminal provenance of this process, for the enrollment record. */
function provenance(sessionId: string | null): EnrollmentProvenance {
  const ps = (args: string[]): string | null => {
    try {
      return (
        execFileSync('ps', args, {
          encoding: 'utf-8',
          stdio: ['ignore', 'pipe', 'ignore'],
        }).trim() || null
      );
    } catch {
      return null;
    }
  };
  return {
    enrolledAt: new Date().toISOString(),
    sessionId,
    tty: ps(['-o', 'tty=', '-p', String(process.pid)]),
    parent: ps(['-o', 'comm=', '-p', String(process.ppid)]),
  };
}

function audit(
  projectRoot: string,
  action: string,
  fields: { sessionId: string | null; old?: number; next?: number; reason: string; ok?: boolean },
): void {
  appendOwnerOverrideAudit(projectRoot, {
    timestamp: new Date().toISOString(),
    taskId: '*',
    gate: OVERRIDE_CAP_SETTING,
    action,
    agent_id: process.env['CLEO_AGENT_ID'] ?? 'unknown',
    session_id: fields.sessionId,
    token_validated: fields.ok === true,
    tty_present: isTtyPresent(),
    override_count: 0,
    reason: fields.reason,
    pid: process.pid,
    setting: OVERRIDE_CAP_SETTING,
    ...(fields.old !== undefined ? { old_value: fields.old } : {}),
    ...(fields.next !== undefined ? { new_value: fields.next } : {}),
  });
}

/**
 * The project's owner state, judged without auditing: the sealed cap, or why
 * stored state is ignored.
 */
async function judgeOwnerState(
  projectRoot: string,
): Promise<
  | { kind: 'none' }
  | { kind: 'ok'; file: OwnerSettingsFile; global: GlobalEnrollment; cap: number | null }
  | { kind: 'tampered'; why: string }
> {
  const read = readSettings(projectRoot);
  const global = readGlobal(projectRoot);
  if (read.state === 'absent')
    return global
      ? {
          kind: 'tampered',
          why: `.cleo/owner-settings.json is missing, but the global store records owner key ${global.fingerprint} for this project (deleted? restore it from git, or the owner re-enrolls with \`${OWNER_ENROLL_COMMAND} --reset\`)`,
        }
      : { kind: 'none' };
  if (read.state === 'bad')
    return {
      kind: 'tampered',
      why: `.cleo/owner-settings.json is unreadable (${read.why}); restore it from git, or the owner re-enrolls with \`${OWNER_ENROLL_COMMAND} --reset\``,
    };
  const file = read.file;
  const fp = fingerprintOf(file.ownerPubkey);
  if (!global)
    return {
      kind: 'tampered',
      why: `.cleo/owner-settings.json names owner key ${fp}, which the global store never enrolled for this project (forged or copied in?)`,
    };
  if (global.ownerPubkey !== file.ownerPubkey)
    return {
      kind: 'tampered',
      why: `.cleo/owner-settings.json names owner key ${fp}, but the global store enrolled ${global.fingerprint} for this project`,
    };
  const entry = file.settings[OVERRIDE_CAP_SETTING];
  if (!entry) return { kind: 'ok', file, global, cap: null };
  const { verifyAuditLine } = await import('../identity/cleo-identity.js');
  const valid =
    Number.isInteger(entry.value) &&
    entry.value >= 1 &&
    entry.value <= MAX_OVERRIDE_CAP_PER_SESSION &&
    typeof entry.sig === 'string' &&
    (await verifyAuditLine(
      sealPayload(OVERRIDE_CAP_SETTING, entry.value, entry.setAt, file.salt, file.ownerPubkey),
      entry.sig,
      file.ownerPubkey,
    ));
  if (!valid)
    return {
      kind: 'tampered',
      why: `${OVERRIDE_CAP_SETTING} in .cleo/owner-settings.json is not sealed by the enrolled owner key (edited by hand?)`,
    };
  return { kind: 'ok', file, global, cap: entry.value };
}

/**
 * The per-session override cap in force for a project: the owner's sealed
 * `evidence.overrideCapPerSession`, or {@link DEFAULT_OVERRIDE_CAP_PER_SESSION}.
 * Stored state that is missing, unanchored, mismatched or unsealed is ignored,
 * warned about and audited (see the module doc).
 *
 * @param projectRoot - Project root.
 * @returns The cap, its source, and a warning when stored state was ignored.
 * @task T13787
 */
export async function resolveOverrideCap(projectRoot: string): Promise<OverrideCapResolution> {
  const state = await judgeOwnerState(projectRoot);
  // T13829: an enrollment that replaced another without proof of the previous
  // owner sets no cap until the owner confirms it.
  if (state.kind === 'ok' && state.global.resetFrom) {
    const warning = `owner key ${state.global.fingerprint} replaced an earlier enrollment without proof of the previous owner (${state.global.resetFrom}); ${OVERRIDE_CAP_SETTING} falls back to ${DEFAULT_OVERRIDE_CAP_PER_SESSION} until \`${OWNER_ENROLL_COMMAND} --confirm\`.`;
    // Audited once per unconfirmed state, not on every read.
    const stateKey = `${state.global.fingerprint}:${state.global.resetFrom}:${state.global.enrolledAt}`;
    if (state.global.unconfirmedAudited !== stateKey) {
      audit(projectRoot, 'owner-settings-unconfirmed', { sessionId: null, reason: warning });
      await atomicWriteJson(globalPath(), {
        schemaVersion: 1,
        projects: {
          ...readGlobalAll(),
          [projectKey(projectRoot)]: { ...state.global, unconfirmedAudited: stateKey },
        },
      });
    }
    return { cap: DEFAULT_OVERRIDE_CAP_PER_SESSION, source: 'default', warning };
  }
  if (state.kind === 'ok' && state.cap !== null) return { cap: state.cap, source: 'owner-setting' };
  if (state.kind !== 'tampered')
    return { cap: DEFAULT_OVERRIDE_CAP_PER_SESSION, source: 'default' };
  const warning = `${state.why}; ${OVERRIDE_CAP_SETTING} falls back to ${DEFAULT_OVERRIDE_CAP_PER_SESSION}.`;
  audit(projectRoot, 'owner-settings-invalid', { sessionId: null, reason: warning });
  return { cap: DEFAULT_OVERRIDE_CAP_PER_SESSION, source: 'default', warning };
}

/**
 * The project's owner enrollment for `cleo doctor`: none, enrolled (with
 * fingerprint, when, which session and terminal), or tampered (why).
 *
 * @param projectRoot - Project root.
 * @returns The status, with the cap in force.
 * @task T13787
 */
export async function ownerEnrollmentStatus(projectRoot: string): Promise<OwnerEnrollmentStatus> {
  const state = await judgeOwnerState(projectRoot);
  if (state.kind === 'none')
    return {
      status: 'none',
      message: `No owner is enrolled for this project; ${OVERRIDE_CAP_SETTING} is ${DEFAULT_OVERRIDE_CAP_PER_SESSION}.`,
      cap: DEFAULT_OVERRIDE_CAP_PER_SESSION,
      warnings: [],
    };
  if (state.kind === 'tampered')
    return {
      status: 'tampered',
      message: `Owner settings ignored: ${state.why}. ${OVERRIDE_CAP_SETTING} is ${DEFAULT_OVERRIDE_CAP_PER_SESSION}.`,
      cap: DEFAULT_OVERRIDE_CAP_PER_SESSION,
      warnings: [],
    };
  const g = state.global;
  const cap = state.cap ?? DEFAULT_OVERRIDE_CAP_PER_SESSION;
  if (g.resetFrom)
    return {
      status: 'unconfirmed',
      message:
        `Owner key ${g.fingerprint} replaced an earlier enrollment WITHOUT proof of the previous owner ` +
        `(${g.resetFrom}) at ${g.enrolledAt}, by session ${g.sessionId ?? 'unknown'} on tty ${g.tty ?? 'unknown'} ` +
        `(parent ${g.parent ?? 'unknown'}); ${OVERRIDE_CAP_SETTING} stays ${DEFAULT_OVERRIDE_CAP_PER_SESSION} until confirmed. If you did this, confirm it with ` +
        `\`${OWNER_ENROLL_COMMAND} --confirm\`; if not, restore .cleo/owner-settings.json from git and re-enroll. ` +
        'An agent that did the reset could also confirm it: this is visibility, not prevention.',
      fingerprint: g.fingerprint,
      enrolledAt: g.enrolledAt,
      sessionId: g.sessionId,
      tty: g.tty,
      parent: g.parent,
      cap: DEFAULT_OVERRIDE_CAP_PER_SESSION,
      warnings: [],
    };
  const enrolledMs = Date.parse(g.enrolledAt);
  const warnings = [
    ...(Number.isFinite(enrolledMs) && Date.now() - enrolledMs < RECENT_ENROLLMENT_MS
      ? [
          `owner key ${g.fingerprint} was enrolled or reset recently (${g.enrolledAt}, session ${g.sessionId ?? 'unknown'}, tty ${g.tty ?? 'unknown'}, parent ${g.parent ?? 'unknown'}); confirm you did it`,
        ]
      : []),
    ...(g.parent && PTY_WRAPPERS.test(g.parent)
      ? [`the enrolling process ran under ${g.parent}, which fakes a terminal; confirm you did it`]
      : []),
    ...trackingWarnings(projectRoot),
  ];
  return {
    warnings,
    status: 'enrolled',
    message:
      `Owner key ${g.fingerprint} enrolled ${g.enrolledAt} by session ${g.sessionId ?? 'unknown'} ` +
      `on tty ${g.tty ?? 'unknown'} (parent ${g.parent ?? 'unknown'}); ${OVERRIDE_CAP_SETTING} = ${cap}. ` +
      'If you did not enroll it, run `cleo config owner-enroll --reset` yourself.',
    fingerprint: g.fingerprint,
    enrolledAt: g.enrolledAt,
    sessionId: g.sessionId,
    tty: g.tty,
    parent: g.parent,
    cap,
  };
}

/** T1118 L4: role fence, TTY, and the password against the session's verifier. */
function ownerCheck(
  caller: OwnerCaller,
): { ok: true } | { ok: false; code: string; message: string } {
  const token = caller.session?.token ?? null;
  if (token === null)
    return {
      ok: false,
      code: BRANCH_LOCK_ERROR_CODES.E_OVERRIDE_TOKEN_INVALID,
      message: 'The bound session has no owner-auth token.',
    };
  // Review-2253 round 2: only a scrypt verifier vouches for the owner; a
  // legacy HMAC token is a cheap offline oracle and is never accepted here.
  const verifier = token.startsWith(`${OWNER_SESSION_MARK}|`)
    ? token.slice(OWNER_SESSION_MARK.length + 1)
    : token;
  if (!verifier.startsWith('scrypt$v1$'))
    return {
      ok: false,
      code: BRANCH_LOCK_ERROR_CODES.E_OVERRIDE_TOKEN_INVALID,
      message:
        'The bound session has no scrypt owner-auth verifier (it predates T13787 or was started with --owner alone); start a new --owner-auth session.',
    };
  const auth = validateOwnerOverride({
    sessionId: caller.session?.id ?? 'global',
    skipTokenCheck: true,
  });
  if (!auth.allowed)
    return {
      ok: false,
      code: auth.errorCode ?? 'E_OVERRIDE_REFUSED',
      message: auth.errorMessage ?? 'Refused.',
    };
  if (!verifyOwnerAuthPassword(caller.password, token, caller.session?.name ?? 'session'))
    return {
      ok: false,
      code: BRANCH_LOCK_ERROR_CODES.E_OVERRIDE_TOKEN_INVALID,
      message: "The password does not match the bound session's owner-auth token.",
    };
  return { ok: true };
}

/**
 * Refuse, and audit, a write of `evidence.overrideCapPerSession` that did not
 * come through {@link setOwnerOverrideCap} — a plain config write (T13787).
 *
 * @param projectRoot - Project root.
 * @param value - The value the write asked for.
 * @returns The refusal message, naming the owner command.
 * @task T13787
 */
export async function refuseOverrideCapWrite(projectRoot: string, value: unknown): Promise<string> {
  const previous = (await resolveOverrideCap(projectRoot)).cap;
  const message = `${OVERRIDE_CAP_SETTING} is owner-only and is never written to config.json. Only the owner can change it, with \`${OVERRIDE_CAP_OWNER_COMMAND}\`: ${OWNER_HOW}.`;
  audit(projectRoot, 'override-cap-set-refused', {
    sessionId: null,
    old: previous,
    ...(typeof value === 'number' ? { next: value } : {}),
    reason: 'plain config write refused',
  });
  return message;
}

/**
 * Enroll the owner key for this project — explicitly, never as a side effect
 * of a set (T13787 review). Refused, and audited, unless the caller passes
 * T1118 L4; refused over an existing enrollment (project file or global
 * record) unless `reset`, which is audited loudly and drops the old seals.
 *
 * @param projectRoot - Project root.
 * @param caller - The password typed at the TTY and the bound session.
 * @param opts - `reset`: replace an existing enrollment.
 * @returns The new key's fingerprint, or why enrollment was refused.
 * @task T13787
 */
export async function enrollOwner(
  projectRoot: string,
  caller: OwnerCaller,
  opts: { reset?: boolean } = {},
): Promise<OwnerEnrollResult> {
  const sessionId = caller.session?.id ?? null;
  const refuse = (code: string, message: string): OwnerEnrollResult => {
    audit(projectRoot, 'owner-enroll-refused', { sessionId, reason: message });
    return { ok: false, code, message: `${message} Only the owner can enroll: ${OWNER_HOW}.` };
  };
  const check = ownerCheck(caller);
  if (!check.ok) return refuse(check.code, check.message);
  const existing = readGlobal(projectRoot);
  const fileThere = readSettings(projectRoot).state !== 'absent';
  if ((existing || fileThere) && opts.reset !== true)
    return refuse(
      // @sync-invariant none:local-only owner enrollment state is device-local and git-tracked; refused before any write
      'E_OWNER_ALREADY_ENROLLED',
      `An owner is already enrolled for this project${existing ? ` (key ${existing.fingerprint})` : ''}; re-enrolling needs \`${OWNER_ENROLL_COMMAND} --reset\`.`,
    );
  // Review-2253 rounds 2-3: while the global record is intact, a reset must
  // prove the old owner's password against it — even with the project file
  // deleted. Only with both anchors gone (the global one outside the repo) is
  // a reset password-free, and then it is recorded as unconfirmed.
  let resetFrom: GlobalEnrollment['resetFrom'];
  if (opts.reset === true) {
    if (existing) {
      const read = readSettings(projectRoot);
      const oldSalt =
        existing.salt ??
        (read.state === 'read' && read.file.ownerPubkey === existing.ownerPubkey
          ? read.file.salt
          : undefined);
      const proven =
        oldSalt !== undefined &&
        (await ownerKey(caller.password, oldSalt)).pubkeyHex === existing.ownerPubkey;
      if (!proven)
        return refuse(
          // @sync-invariant none:local-only owner enrollment state is device-local and git-tracked; refused before any write
          'E_OWNER_RESET_NOT_OWNER',
          `Resetting needs the current owner's password (key ${existing.fingerprint}, recorded in the global owner-enrollments.json). If it is lost, remove BOTH anchors deliberately (.cleo/owner-settings.json and this project's record in the global owner-enrollments.json, outside the repo) and enroll again.`,
        );
    } else {
      resetFrom = fileThere ? 'tampered' : 'fresh-after-removal';
    }
  } else if (!existing && !fileThere) {
    // Both anchors gone: git history decides whether a plain enroll replaces an
    // owner it never proved (present), or cannot tell (unavailable).
    const history = settingsHistory(projectRoot);
    if (history === 'present') resetFrom = 'fresh-after-removal';
    else if (history === 'unavailable') resetFrom = 'history-unavailable';
  }
  const salt = randomBytes(16).toString('hex');
  const key = await ownerKey(caller.password, salt);
  const prov = provenance(sessionId);
  const fingerprint = fingerprintOf(key.pubkeyHex);
  const file: OwnerSettingsFile = {
    schemaVersion: 1,
    ownerPubkey: key.pubkeyHex,
    salt,
    settings: {},
    ...prov,
  };
  await atomicWriteJson(settingsPath(projectRoot), file);
  await atomicWriteJson(globalPath(), {
    schemaVersion: 1,
    projects: {
      ...readGlobalAll(),
      [projectKey(projectRoot)]: {
        ownerPubkey: key.pubkeyHex,
        fingerprint,
        projectRoot,
        salt,
        ...prov,
        ...(resetFrom ? { resetFrom } : {}),
      },
    },
  });
  audit(projectRoot, opts.reset === true ? 'owner-enroll-reset' : 'owner-enroll', {
    sessionId,
    ok: true,
    reason:
      opts.reset === true
        ? `owner key RESET to ${fingerprint}${existing ? ` (was ${existing.fingerprint}, old password proven)` : ` without proof of a previous owner (${resetFrom})`}; earlier seals dropped (tty ${prov.tty ?? 'unknown'}, parent ${prov.parent ?? 'unknown'})`
        : `owner key ${fingerprint} enrolled (tty ${prov.tty ?? 'unknown'}, parent ${prov.parent ?? 'unknown'})`,
  });
  return { ok: true, fingerprint, reset: opts.reset === true };
}

/**
 * Confirm an enrollment that replaced another without proof of the previous
 * owner (review-2253 round 3): the owner proves the CURRENT key's password and
 * the `resetFrom` mark that makes `cleo doctor` FAIL is cleared, audited. An
 * agent that did the reset could confirm it too — visibility, not prevention.
 *
 * @param projectRoot - Project root.
 * @param caller - The password typed at the TTY and the bound session.
 * @returns The confirmed key's fingerprint, or why it was refused.
 * @task T13787
 */
export async function confirmOwnerEnrollment(
  projectRoot: string,
  caller: OwnerCaller,
): Promise<OwnerEnrollResult> {
  const sessionId = caller.session?.id ?? null;
  const refuse = (code: string, message: string): OwnerEnrollResult => {
    audit(projectRoot, 'owner-enroll-confirm-refused', { sessionId, reason: message });
    return { ok: false, code, message: `${message} Only the owner can confirm: ${OWNER_HOW}.` };
  };
  const check = ownerCheck(caller);
  if (!check.ok) return refuse(check.code, check.message);
  const state = await judgeOwnerState(projectRoot);
  if (state.kind !== 'ok')
    return refuse(
      // @sync-invariant none:local-only owner enrollment state is device-local and git-tracked; refused before any write
      'E_OWNER_SETTINGS_TAMPERED',
      state.kind === 'tampered' ? `${state.why}.` : 'No owner is enrolled for this project.',
    );
  if ((await ownerKey(caller.password, state.file.salt)).pubkeyHex !== state.file.ownerPubkey)
    return refuse(
      BRANCH_LOCK_ERROR_CODES.E_OVERRIDE_TOKEN_INVALID,
      'The password does not match the owner key enrolled for this project.',
    );
  const { resetFrom: _cleared, ...rest } = state.global;
  await atomicWriteJson(globalPath(), {
    schemaVersion: 1,
    projects: {
      ...readGlobalAll(),
      [projectKey(projectRoot)]: { ...rest, confirmedAt: new Date().toISOString() },
    },
  });
  audit(projectRoot, 'owner-enroll-confirm', {
    sessionId,
    ok: true,
    reason: `owner confirmed key ${state.global.fingerprint}${state.global.resetFrom ? ` (was reset from ${state.global.resetFrom})` : ''}`,
  });
  return { ok: true, fingerprint: state.global.fingerprint, reset: false };
}

/**
 * Set `evidence.overrideCapPerSession` through the owner path: refused, and
 * audited, unless the caller passes T1118 L4, the project is enrolled with its
 * file and global record agreeing, and `password` derives the enrolled key.
 * Never enrolls. Values above {@link MAX_OVERRIDE_CAP_PER_SESSION} are clamped.
 *
 * @param projectRoot - Project root.
 * @param input - The requested value, the password typed at the TTY, and the
 *   bound session with its owner-auth verifier (null when it has none).
 * @returns The new and previous cap, or why the set was refused.
 * @task T13787
 */
export async function setOwnerOverrideCap(
  projectRoot: string,
  input: OwnerCaller & { value: number },
): Promise<OverrideCapSetResult> {
  const previous = (await resolveOverrideCap(projectRoot)).cap;
  const sessionId = input.session?.id ?? null;
  const refuse = (code: string, message: string): OverrideCapSetResult => {
    audit(projectRoot, 'override-cap-set-refused', {
      sessionId,
      old: previous,
      next: input.value,
      reason: message,
    });
    return {
      ok: false,
      code,
      message: `${message} Only the owner can change ${OVERRIDE_CAP_SETTING}: ${OWNER_HOW}.`,
    };
  };
  if (!Number.isInteger(input.value) || input.value < 1)
    // @sync-invariant none:input-shape the requested cap is not a positive integer
    return refuse('E_VALIDATION', `${OVERRIDE_CAP_SETTING} must be a positive integer.`);
  const check = ownerCheck(input);
  if (!check.ok) return refuse(check.code, check.message);
  const read = readSettings(projectRoot);
  const global = readGlobal(projectRoot);
  if (read.state === 'absent' && !global)
    return refuse(
      // @sync-invariant none:local-only owner enrollment state is device-local and git-tracked; refused before any write
      'E_OWNER_NOT_ENROLLED',
      `No owner is enrolled for this project; the owner enrolls first with \`${OWNER_ENROLL_COMMAND}\`.`,
    );
  const state = await judgeOwnerState(projectRoot);
  if (state.kind !== 'ok')
    return refuse(
      // @sync-invariant none:local-only owner enrollment state is device-local and git-tracked; refused before any write
      'E_OWNER_SETTINGS_TAMPERED',
      `${state.kind === 'tampered' ? state.why : 'owner settings are not usable'}.`,
    );
  const file = state.file;
  const key = await ownerKey(input.password, file.salt);
  if (key.pubkeyHex !== file.ownerPubkey)
    return refuse(
      BRANCH_LOCK_ERROR_CODES.E_OVERRIDE_TOKEN_INVALID,
      'The password does not match the owner key enrolled for this project.',
    );
  const value = Math.min(input.value, MAX_OVERRIDE_CAP_PER_SESSION);
  const setAt = new Date().toISOString();
  const { signAuditLine } = await import('../identity/cleo-identity.js');
  const { sig } = await signAuditLine(
    key,
    sealPayload(OVERRIDE_CAP_SETTING, value, setAt, file.salt, file.ownerPubkey),
  );
  await atomicWriteJson(settingsPath(projectRoot), {
    ...file,
    settings: { ...file.settings, [OVERRIDE_CAP_SETTING]: { value, setAt, sig } },
  });
  audit(projectRoot, 'override-cap-set', {
    sessionId,
    old: previous,
    next: value,
    ok: true,
    reason: 'owner set',
  });
  return { ok: true, value, previous, clamped: value !== input.value };
}
