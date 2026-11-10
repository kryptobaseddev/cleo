/**
 * `review.workers.counted` (T14403): the owner-only switch that lets
 * `cleo review dispatch --counted` send reviewer workers whose verdicts count
 * toward a merge. Sealed the way T13787 seals `evidence.overrideCapPerSession`:
 *
 * - It is never written to config.json. A plain config write is refused and
 *   audited ({@link refuseReviewWorkersCountedWrite}).
 * - Only the owner sets it ({@link setOwnerReviewWorkersCounted}): T1118 L4 (no
 *   restricted agent role, a TTY, the bound session's owner-auth password),
 *   then the password must derive the key enrolled for the project. The value
 *   is sealed as `1`/`0` in `.cleo/owner-settings.json` with that key.
 * - Every set and every refusal is a row in `.cleo/audit/force-bypass.jsonl`
 *   with the session, agent id, old and new value.
 * - It reads true only when the owner state is intact and the seal verifies
 *   ({@link resolveReviewWorkersCounted}); anything else is off.
 *
 * Same threat model as T13787: an agent running as the same OS user can edit
 * any local file, so tampering is detectable (git-tracked file, global anchor,
 * seal), not preventable.
 *
 * @task T14403
 */

import { BRANCH_LOCK_ERROR_CODES } from '@cleocode/contracts/branch-lock.js';
import { REVIEW_WORKERS_COUNTED_KEY } from '@cleocode/contracts/review-verdict.js';
import {
  judgeOwnerState,
  type OwnerCaller,
  ownerCheck,
  ownerKey,
  readSealedOwnerSetting,
  writeSealedOwnerSetting,
} from './override-cap-setting.js';
import { appendOwnerOverrideAudit, isTtyPresent } from './owner-override-auth.js';

export { REVIEW_WORKERS_COUNTED_KEY };

/** How the owner sets it, named in every refusal. */
const OWNER_HOW =
  `run \`cleo config set ${REVIEW_WORKERS_COUNTED_KEY} true\` yourself in an interactive terminal, ` +
  'in a session started with `cleo session start --scope global --name owner --owner-auth`, ' +
  'after `cleo config owner-enroll`';

/** Outcome of an owner set of {@link REVIEW_WORKERS_COUNTED_KEY}. */
export type ReviewWorkersCountedSetResult =
  | {
      ok: true;
      /** The value now in force. */
      value: boolean;
      /** The value before the set. */
      previous: boolean;
    }
  | { ok: false; code: string; message: string };

function audit(
  projectRoot: string,
  action: string,
  fields: { sessionId: string | null; old: boolean; next?: boolean; reason: string; ok?: boolean },
): void {
  appendOwnerOverrideAudit(projectRoot, {
    timestamp: new Date().toISOString(),
    taskId: '*',
    gate: REVIEW_WORKERS_COUNTED_KEY,
    action,
    agent_id: process.env['CLEO_AGENT_ID'] ?? 'unknown',
    session_id: fields.sessionId,
    token_validated: fields.ok === true,
    tty_present: isTtyPresent(),
    override_count: 0,
    reason: fields.reason,
    pid: process.pid,
    setting: REVIEW_WORKERS_COUNTED_KEY,
    old_value: fields.old ? 1 : 0,
    ...(fields.next !== undefined ? { new_value: fields.next ? 1 : 0 } : {}),
  });
}

/**
 * Whether the owner enabled counted reviewer workers: true only when the
 * project's owner enrollment is intact and confirmed and the sealed value is 1.
 *
 * @param projectRoot - Project root.
 * @returns The sealed value, or false.
 * @task T14403
 */
export async function resolveReviewWorkersCounted(projectRoot: string): Promise<boolean> {
  const state = await judgeOwnerState(projectRoot);
  if (state.kind !== 'ok' || state.global.resetFrom) return false;
  return (await readSealedOwnerSetting(projectRoot, REVIEW_WORKERS_COUNTED_KEY)) === 1;
}

/**
 * Refuse, and audit, a plain config write of {@link REVIEW_WORKERS_COUNTED_KEY}
 * (one that did not come through {@link setOwnerReviewWorkersCounted}).
 *
 * @param projectRoot - Project root.
 * @param value - The value the write asked for.
 * @returns The refusal message, naming the owner path.
 * @task T14403
 */
export async function refuseReviewWorkersCountedWrite(
  projectRoot: string,
  value: unknown,
): Promise<string> {
  audit(projectRoot, 'review-workers-counted-set-refused', {
    sessionId: process.env['CLEO_SESSION_ID'] ?? null,
    old: await resolveReviewWorkersCounted(projectRoot),
    ...(typeof value === 'boolean' ? { next: value } : {}),
    reason: 'plain config write refused',
  });
  return `${REVIEW_WORKERS_COUNTED_KEY} is owner-only and is never written to config.json. Only the owner can change it: ${OWNER_HOW}.`;
}

/**
 * Set {@link REVIEW_WORKERS_COUNTED_KEY} as the owner: the owner check, an
 * intact enrollment, and the password deriving its key; then the value is
 * sealed and the set audited with who made it. Every refusal is audited too.
 *
 * @param projectRoot - Project root.
 * @param input - The value, the password typed at the TTY, and the bound
 *   session with its owner-auth verifier (null when it has none).
 * @returns The new and previous value, or why the set was refused.
 * @task T14403
 */
export async function setOwnerReviewWorkersCounted(
  projectRoot: string,
  input: OwnerCaller & { value: boolean },
): Promise<ReviewWorkersCountedSetResult> {
  const previous = await resolveReviewWorkersCounted(projectRoot);
  const sessionId = input.session?.id ?? null;
  const refuse = (code: string, message: string): ReviewWorkersCountedSetResult => {
    audit(projectRoot, 'review-workers-counted-set-refused', {
      sessionId,
      old: previous,
      next: input.value,
      reason: message,
    });
    return { ok: false, code, message: `${message} Only the owner can change it: ${OWNER_HOW}.` };
  };
  const check = ownerCheck(input);
  if (!check.ok) return refuse(check.code, check.message);
  const state = await judgeOwnerState(projectRoot);
  if (state.kind !== 'ok')
    return refuse(
      // @sync-invariant none:local-only owner enrollment state is device-local and git-tracked; refused before any write
      state.kind === 'none' ? 'E_OWNER_NOT_ENROLLED' : 'E_OWNER_SETTINGS_TAMPERED',
      state.kind === 'none'
        ? 'No owner is enrolled for this project.'
        : `Owner settings are not usable: ${state.why}.`,
    );
  const key = await ownerKey(input.password, state.file.salt);
  if (key.pubkeyHex !== state.file.ownerPubkey)
    return refuse(
      BRANCH_LOCK_ERROR_CODES.E_OVERRIDE_TOKEN_INVALID,
      'The password does not match the owner key enrolled for this project.',
    );
  await writeSealedOwnerSetting(projectRoot, REVIEW_WORKERS_COUNTED_KEY, input.value ? 1 : 0, key);
  audit(projectRoot, 'review-workers-counted-set', {
    sessionId,
    old: previous,
    next: input.value,
    ok: true,
    reason: 'owner set',
  });
  return { ok: true, value: input.value, previous };
}
