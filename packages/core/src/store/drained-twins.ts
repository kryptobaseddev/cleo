/**
 * Bare tables the twin collapse DRAINS into their prefixed twin (T13115,
 * T13777), bare name → twin name. A leaf, so both the collapse
 * (`twin-collapse.ts`) and the bare-twin strand check (`sync/flags.ts`) read
 * one list.
 *
 * A drained bare table is the inbox of rows an older build writes: every open
 * moves them into the twin losslessly, and a row the drain must leave behind
 * is reported by `cleo doctor twin-collapse`. So its rows are never a legacy
 * strand that should refuse capture or sealing: the next open carries them.
 *
 * @task T13777
 */
export const DRAINED_TWINS: Readonly<Record<string, string>> = {
  token_usage: 'tasks_token_usage',
  audit_log: 'tasks_audit_log',
};
