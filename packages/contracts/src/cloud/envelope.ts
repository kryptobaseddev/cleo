import { z } from 'zod';

/**
 * Stable error codes. Clients branch on `code`, never on `message`.
 * Codes that describe a refused sync action are never retried blindly: the client must
 * reassess (pull, then re-verify) first.
 */
export const ErrorCode = z.enum([
  'E_VALIDATION',
  'E_UNAUTHENTICATED',
  'E_FORBIDDEN',
  'E_NOT_FOUND',
  'E_CONFLICT',
  'E_RATE_LIMITED',
  'E_PAYLOAD_TOO_LARGE',
  /** The manifest does not descend from the stream's current head checkpoint. */
  'E_LINEAGE',
  /** The manifest loses rows that no tombstone in the covered segments accounts for. */
  'E_REGRESSION',
  /** A segment or manifest uses a schemaVersion newer than the stream accepts. It is quarantined, never dropped. */
  'E_SCHEMA_AHEAD',
  /** Another replica holds the exporter lease for this stream. */
  'E_LEASE_HELD',
  /** The referenced blob has not been uploaded and verified yet. */
  'E_BLOB_MISSING',
  'E_BLOB_INTEGRITY',
  'E_UNAVAILABLE',
  'E_INTERNAL',
]);
export type ErrorCode = z.infer<typeof ErrorCode>;

export const ErrorBody = z.object({
  code: ErrorCode,
  message: z.string(),
  requestId: z.string(),
  details: z.record(z.string(), z.unknown()).optional(),
});
export type ErrorBody = z.infer<typeof ErrorBody>;

export const ErrorEnvelope = z.object({ success: z.literal(false), error: ErrorBody });
export type ErrorEnvelope = z.infer<typeof ErrorEnvelope>;


export type OkEnvelope<T> = { success: true; data: T; meta: { requestId: string } };
export type Envelope<T> = OkEnvelope<T> | ErrorEnvelope;

/** HTTP status for each code, so server and client agree. */
export const errorStatus: Record<ErrorCode, number> = {
  E_VALIDATION: 400,
  E_UNAUTHENTICATED: 401,
  E_FORBIDDEN: 403,
  E_NOT_FOUND: 404,
  E_CONFLICT: 409,
  E_LINEAGE: 409,
  E_REGRESSION: 409,
  E_LEASE_HELD: 409,
  E_SCHEMA_AHEAD: 422,
  E_BLOB_MISSING: 424,
  E_BLOB_INTEGRITY: 422,
  E_PAYLOAD_TOO_LARGE: 413,
  E_RATE_LIMITED: 429,
  E_UNAVAILABLE: 503,
  E_INTERNAL: 500,
};
