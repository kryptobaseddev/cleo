/**
 * LAFS (LLM-Agent-First Schema) envelope types.
 * All CLI output follows this format for machine-parseable responses.
 * @epic T4454
 * @task T4456
 */

/** LAFS success envelope. */
export interface LafsSuccess<T = unknown> {
  success: true;
  data: T;
  message?: string;
  noChange?: boolean;
}

/** LAFS error detail. */
export interface LafsErrorDetail {
  code: number;
  name: string;
  message: string;
  fix?: string;
  alternatives?: Array<{ action: string; command: string }>;
}

/** LAFS error envelope. */
export interface LafsError {
  success: false;
  error: LafsErrorDetail;
}

/** LAFS envelope union type. */
export type LafsEnvelope<T = unknown> = LafsSuccess<T> | LafsError;

/** Type guard for success responses. */
export function isLafsSuccess<T>(envelope: LafsEnvelope<T>): envelope is LafsSuccess<T> {
  return envelope.success === true;
}

/** Type guard for error responses. */
export function isLafsError<T>(envelope: LafsEnvelope<T>): envelope is LafsError {
  return envelope.success === false;
}
