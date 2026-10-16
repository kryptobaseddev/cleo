/**
 * The per-project owner override cap setting (T13787, owner decision
 * 2026-10-16): `evidence.overrideCapPerSession` replaces the fixed cap of 10
 * per session, and ONLY the owner may change it.
 *
 * ## Who may set it
 *
 * The owner-auth layer T1118 built (L4, {@link validateOwnerOverride}), as is:
 * the caller is not a restricted agent role, stdin and stderr are a TTY, and
 * the password typed now matches the owner-auth token of the bound session
 * (`cleo session start --owner-auth`). Every set and every refused attempt is
 * appended to `.cleo/audit/force-bypass.jsonl` with the old and new value.
 *
 * ## Why it outlives the session
 *
 * The value is sealed with an Ed25519 key derived from the owner-auth password
 * (scrypt over a per-project salt). The first set enrolls the public key in
 * `.cleo/owner-settings.json`; a later set must derive the same key, so a
 * different password is refused. Reading needs only the public key: a raw edit
 * of the value, or a seal that fails to verify, falls back to the default with
 * a warning and an audit line.
 *
 * ## What it does not stop
 *
 * The enrollment file is a file the same OS user can rewrite: an agent that
 * deliberately replaces the enrolled key and seal with its own can forge a
 * value. That is tamper-evident (the old key is gone, the audit log has no
 * matching set), not tamper-proof. And `CLEO_OWNER_OVERRIDE=1` itself is still
 * accepted from any agent without a restricted role (follow-up T13789).
 *
 * @task T13787
 */

import { randomBytes, scryptSync } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { BRANCH_LOCK_ERROR_CODES } from '@cleocode/contracts/branch-lock.js';
import { atomicWriteJson } from '../store/atomic.js';
import {
  DEFAULT_OVERRIDE_CAP_PER_SESSION,
  MAX_OVERRIDE_CAP_PER_SESSION,
  OVERRIDE_CAP_OWNER_COMMAND,
  OVERRIDE_CAP_SETTING,
} from './override-cap.js';
import {
  appendOwnerOverrideAudit,
  deriveOwnerAuthToken,
  isTtyPresent,
  validateOwnerOverride,
} from './owner-override-auth.js';

/** How the owner runs {@link OVERRIDE_CAP_OWNER_COMMAND}. */
const OWNER_HOW =
  'run it yourself in an interactive terminal, in a session started with `cleo session start --owner-auth`';

/** One sealed setting. */
interface SealedSetting {
  value: number;
  setAt: string;
  /** Ed25519 signature (hex) over {@link sealPayload}. */
  sig: string;
}

/** `.cleo/owner-settings.json`. */
interface OwnerSettingsFile {
  schemaVersion: 1;
  /** Enrolled owner public key (hex), derived from the owner-auth password. */
  ownerPubkey: string;
  /** Per-project scrypt salt (hex). */
  salt: string;
  settings: Record<string, SealedSetting>;
}

/** What the override cap resolves to for a project. */
export interface OverrideCapResolution {
  /** The cap in force. */
  cap: number;
  /** Where it came from. */
  source: 'default' | 'owner-setting';
  /** Set when a stored value was ignored (bad seal or unreadable file). */
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

function settingsPath(projectRoot: string): string {
  return join(projectRoot, '.cleo', 'owner-settings.json');
}

function readSettings(projectRoot: string): OwnerSettingsFile | null {
  let raw: string;
  try {
    raw = readFileSync(settingsPath(projectRoot), 'utf-8');
  } catch {
    return null;
  }
  const parsed = JSON.parse(raw) as Partial<OwnerSettingsFile>;
  if (typeof parsed.ownerPubkey !== 'string' || typeof parsed.salt !== 'string')
    // @sync-invariant none:local-only a device-local owner-settings file without an enrolled key; nothing synced is written
    throw new Error('owner-settings.json has no enrolled owner key');
  return {
    schemaVersion: 1,
    ownerPubkey: parsed.ownerPubkey,
    salt: parsed.salt,
    settings: parsed.settings ?? {},
  };
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
  return AgentIdentity.fromSeed(new Uint8Array(scryptSync(password, Buffer.from(salt, 'hex'), 32)));
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
 * The per-session override cap in force for a project: the owner's sealed
 * `evidence.overrideCapPerSession`, or {@link DEFAULT_OVERRIDE_CAP_PER_SESSION}.
 * A value whose seal does not verify against the enrolled owner key (a raw
 * edit) is ignored, warned about and audited.
 *
 * @param projectRoot - Project root.
 * @returns The cap, its source, and a warning when a stored value was ignored.
 * @task T13787
 */
export async function resolveOverrideCap(projectRoot: string): Promise<OverrideCapResolution> {
  const fallback = (warning: string): OverrideCapResolution => {
    audit(projectRoot, 'override-cap-seal-invalid', { sessionId: null, reason: warning });
    return { cap: DEFAULT_OVERRIDE_CAP_PER_SESSION, source: 'default', warning };
  };
  let file: OwnerSettingsFile | null;
  try {
    file = readSettings(projectRoot);
  } catch (err) {
    return fallback(
      `.cleo/owner-settings.json is unreadable (${err instanceof Error ? err.message : String(err)}); ${OVERRIDE_CAP_SETTING} falls back to ${DEFAULT_OVERRIDE_CAP_PER_SESSION}`,
    );
  }
  const entry = file?.settings[OVERRIDE_CAP_SETTING];
  if (!file || !entry) return { cap: DEFAULT_OVERRIDE_CAP_PER_SESSION, source: 'default' };
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
    return fallback(
      `${OVERRIDE_CAP_SETTING} in .cleo/owner-settings.json is not sealed by the enrolled owner key (edited by hand?); it falls back to ${DEFAULT_OVERRIDE_CAP_PER_SESSION}. The owner re-sets it with: ${OVERRIDE_CAP_OWNER_COMMAND}`,
    );
  return { cap: entry.value, source: 'owner-setting' };
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
 * Set `evidence.overrideCapPerSession` through the owner path (T1118 L4):
 * refused, and audited, unless the caller passes the role fence, has a TTY,
 * and `password` matches the bound session's owner-auth token and the enrolled
 * owner key. Values above {@link MAX_OVERRIDE_CAP_PER_SESSION} are clamped.
 *
 * @param projectRoot - Project root.
 * @param input - The requested value, the password typed at the TTY, and the
 *   bound session with its owner-auth token (null when it has none).
 * @returns The new and previous cap, or why the set was refused.
 * @task T13787
 */
export async function setOwnerOverrideCap(
  projectRoot: string,
  input: {
    value: number;
    password: string;
    session: { id: string; name: string | null; token: string | null } | null;
  },
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
  const token = input.session?.token ?? null;
  if (token === null)
    return refuse(
      BRANCH_LOCK_ERROR_CODES.E_OVERRIDE_TOKEN_INVALID,
      'The bound session has no owner-auth token.',
    );
  const auth = validateOwnerOverride({
    sessionId: sessionId ?? 'global',
    callerToken: deriveOwnerAuthToken(input.session?.name ?? 'session', input.password),
    storedToken: token,
  });
  if (!auth.allowed)
    return refuse(auth.errorCode ?? 'E_OVERRIDE_REFUSED', auth.errorMessage ?? 'Refused.');

  let file: OwnerSettingsFile | null;
  try {
    file = readSettings(projectRoot);
  } catch {
    file = null; // an unreadable file re-enrolls; the audit line records it
  }
  const salt = file?.salt ?? randomBytes(16).toString('hex');
  const key = await ownerKey(input.password, salt);
  if (file && file.ownerPubkey !== key.pubkeyHex)
    return refuse(
      BRANCH_LOCK_ERROR_CODES.E_OVERRIDE_TOKEN_INVALID,
      'The password does not match the owner key enrolled for this project.',
    );
  const value = Math.min(input.value, MAX_OVERRIDE_CAP_PER_SESSION);
  const setAt = new Date().toISOString();
  const { signAuditLine } = await import('../identity/cleo-identity.js');
  const { sig } = await signAuditLine(
    key,
    sealPayload(OVERRIDE_CAP_SETTING, value, setAt, salt, key.pubkeyHex),
  );
  const next: OwnerSettingsFile = {
    schemaVersion: 1,
    ownerPubkey: key.pubkeyHex,
    salt,
    settings: { ...(file?.settings ?? {}), [OVERRIDE_CAP_SETTING]: { value, setAt, sig } },
  };
  await atomicWriteJson(settingsPath(projectRoot), next);
  audit(projectRoot, 'override-cap-set', {
    sessionId,
    old: previous,
    next: value,
    ok: true,
    reason: file ? 'owner set' : 'owner set (owner key enrolled)',
  });
  return { ok: true, value, previous, clamped: value !== input.value };
}
