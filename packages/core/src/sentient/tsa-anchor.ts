/**
 * RFC 3161 Daily Anchor — TSA timestamp anchoring for the sentient event chain.
 *
 * Runs once per UTC day from the sentient daemon tick. Posts the SHA-256 of
 * the current chain HEAD's raw serialised line to a configurable Timestamp
 * Authority (TSA). Appends a `kind:'tsa_anchor'` sentient event carrying the
 * opaque `TimeStampToken` bytes (base64-encoded) so that any retroactive
 * chain forking after the anchor point is detectable by a third party holding
 * the TSA receipt.
 *
 * ## Implementation notes
 *
 * This implementation hand-codes the minimal RFC 3161 `TimeStampReq` DER
 * structure using `node:crypto` for SHA-256 and `node:https`/`node:http` for
 * HTTP transport. No external dependencies are required.
 *
 * The `TimeStampReq` sent to the TSA is:
 *
 * ```asn1
 * TimeStampReq ::= SEQUENCE {
 *   version         INTEGER { v1(1) },
 *   messageImprint  MessageImprint,
 *   certReq         BOOLEAN DEFAULT TRUE
 * }
 *
 * MessageImprint ::= SEQUENCE {
 *   hashAlgorithm   AlgorithmIdentifier,   -- SHA-256 OID
 *   hashedMessage   OCTET STRING (32 bytes)
 * }
 * ```
 *
 * The response `TimeStampToken` (DER bytes) is stored opaquely as base64 in
 * the event payload. Full ASN.1 response parsing is not performed — the token
 * is a tamper-evident receipt whose time can be extracted later by a proper
 * RFC 3161 library (future follow-up).
 *
 * ## Sentient config
 *
 * The TSA endpoint URL is read from `.cleo/sentient.json` at key
 * `tsaEndpoint`. Defaults to `http://timestamp.digicert.com`.
 *
 * ## Failure handling
 *
 * If the TSA request fails (network error, non-200 response, timeout), the
 * function logs a warning and returns `null` without throwing. This prevents
 * a network partition from blocking the daemon tick.
 *
 * @see DESIGN.md §8 T1010-S6
 * @task T1026
 */

import crypto from 'node:crypto';
import { readFile } from 'node:fs/promises';
import * as http from 'node:http';
import * as https from 'node:https';
import { join } from 'node:path';
import type { TsaAnchorEvent } from './events.js';
import { appendSentientEvent, querySentientEvents, SENTIENT_EVENTS_FILE } from './events.js';
import { loadSigningIdentity } from './kms.js';

// Re-export TsaAnchorEvent so callers can import it from this module.
export type { TsaAnchorEvent } from './events.js';

// ---------------------------------------------------------------------------
// Sentient config
// ---------------------------------------------------------------------------

/** Default TSA endpoint URL. */
const DEFAULT_TSA_URL = 'http://timestamp.digicert.com';

/** Path to the sentient config file (relative to projectRoot). */
const SENTIENT_CONFIG_PATH = '.cleo/sentient.json';

/**
 * Minimal sentient config shape — only fields relevant to this module.
 *
 * @internal
 */
interface SentientConfig {
  /** Override the default TSA endpoint URL. */
  tsaEndpoint?: string;
}

/**
 * Read the TSA endpoint URL from `.cleo/sentient.json`, falling back to the
 * default if the file is absent or the field is not set.
 *
 * @param projectRoot - Absolute path to the CLEO project root.
 * @returns The TSA endpoint URL to use.
 * @internal
 */
export async function readTsaUrl(projectRoot: string): Promise<string> {
  try {
    const configPath = join(projectRoot, SENTIENT_CONFIG_PATH);
    const raw = await readFile(configPath, 'utf-8');
    const config = JSON.parse(raw) as SentientConfig;
    if (typeof config.tsaEndpoint === 'string' && config.tsaEndpoint.trim().length > 0) {
      return config.tsaEndpoint.trim();
    }
  } catch {
    // File absent or malformed — use default.
  }
  return DEFAULT_TSA_URL;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Anchor the current sentient event chain head with an RFC 3161 timestamp.
 *
 * This function is designed to be called once per UTC day from the daemon
 * tick. It is a no-op if the last `tsa_anchor` event was appended less than
 * 24 hours ago, preventing duplicate anchor charges against rate-limited
 * free-tier TSAs.
 *
 * Steps:
 * 1. Check if a `tsa_anchor` event was written within the last 24 h.
 *    If so, return `null` immediately.
 * 2. Read the current chain HEAD (last event in the log).
 * 3. Compute `sha256(chainHeadHash bytes)` — the message imprint.
 * 4. Build a minimal RFC 3161 `TimeStampReq` DER buffer and POST it to the
 *    TSA endpoint from `.cleo/sentient.json.tsaEndpoint` (or default).
 * 5. On success, store the raw `TimeStampResp` DER bytes as base64.
 * 6. Append a `tsa_anchor` sentient event with the token and metadata.
 * 7. Return the written event.
 *
 * On any TSA error (network, non-200, timeout), logs a warning and returns
 * `null` without throwing.
 *
 * @param projectRoot - Absolute path to the CLEO project root.
 * @param tsaClientOverride - Optional override for the HTTP POST function.
 *   Used in tests to avoid real network calls. Defaults to
 *   {@link postTimestampRequest}.
 * @returns The written {@link TsaAnchorEvent}, or `null` if the anchor was
 *   skipped (< 24 h since last anchor or TSA failure).
 *
 * @example
 * ```ts
 * import { anchorChainDaily } from '@cleocode/core/sentient/tsa-anchor.js';
 *
 * const anchored = await anchorChainDaily(projectRoot);
 * if (anchored) {
 *   console.log('Chain anchored. Receipt:', anchored.receiptId);
 * }
 * ```
 */
export async function anchorChainDaily(
  projectRoot: string,
  tsaClientOverride?: (url: string, body: Buffer) => Promise<Buffer>,
): Promise<TsaAnchorEvent | null> {
  // --- Step 1: Check if already anchored within 24 h ---
  const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const recentAnchors = await querySentientEvents(projectRoot, {
    kind: 'tsa_anchor',
    after: twentyFourHoursAgo,
  });
  if (recentAnchors.length > 0) {
    return null;
  }

  // --- Step 2: Read chain HEAD ---
  const headInfo = await readChainHead(projectRoot);
  if (headInfo === null) {
    // Empty chain — nothing to anchor.
    return null;
  }
  const { receiptId: chainHeadReceiptId, lineHash: chainHeadHash } = headInfo;

  // --- Step 3: Build message imprint (sha256 of the chainHeadHash hex string) ---
  const messageHash = crypto.createHash('sha256').update(chainHeadHash, 'utf-8').digest();

  // --- Step 4: Build RFC 3161 TimeStampReq and POST ---
  const tsaUrl = await readTsaUrl(projectRoot);
  const tsReqDer = buildTimestampRequest(messageHash);

  const httpPost = tsaClientOverride ?? postTimestampRequest;
  let tsTokenBase64: string;
  try {
    const responseBytes = await httpPost(tsaUrl, tsReqDer);
    tsTokenBase64 = responseBytes.toString('base64');
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[tsa-anchor] TSA request to ${tsaUrl} failed: ${message}. Skipping anchor.`);
    return null;
  }

  // --- Step 5: Append tsa_anchor event ---
  const anchoredAt = new Date().toISOString();
  const identity = await loadSigningIdentity(projectRoot);

  const event = await appendSentientEvent(projectRoot, identity, {
    kind: 'tsa_anchor',
    experimentId: '',
    taskId: '',
    payload: {
      chainHeadReceiptId,
      chainHeadHash,
      tsaUrl,
      tsaToken: tsTokenBase64,
      anchoredAt,
    },
  });

  return event as TsaAnchorEvent;
}

// ---------------------------------------------------------------------------
// Internal helpers — exported for testing
// ---------------------------------------------------------------------------

/**
 * Build a minimal RFC 3161 `TimeStampReq` DER buffer.
 *
 * Encodes:
 *
 * ```asn1
 * TimeStampReq ::= SEQUENCE {
 *   version        INTEGER (1),
 *   messageImprint MessageImprint,
 *   certReq        BOOLEAN (TRUE)
 * }
 * MessageImprint ::= SEQUENCE {
 *   hashAlgorithm  AlgorithmIdentifier { SHA-256 OID, NULL },
 *   hashedMessage  OCTET STRING (32 bytes)
 * }
 * ```
 *
 * DER uses definite-length encoding. Short-form (≤ 127 bytes) is used for
 * inner elements; long-form two-byte prefix is used if needed for the outer
 * SEQUENCE.
 *
 * @param messageHash - 32-byte SHA-256 digest to timestamp.
 * @returns DER-encoded `TimeStampReq` buffer.
 */
export function buildTimestampRequest(messageHash: Buffer): Buffer {
  if (messageHash.length !== 32) {
    throw new Error(
      `buildTimestampRequest: messageHash must be exactly 32 bytes (SHA-256). ` +
        `Got ${messageHash.length} bytes.`,
    );
  }

  // SHA-256 OID: 2.16.840.1.101.3.4.2.1 — encoded as 9 bytes.
  const SHA256_OID_VALUE = Buffer.from([0x60, 0x86, 0x48, 0x01, 0x65, 0x03, 0x04, 0x02, 0x01]);

  // OID TLV: tag=06, length=09, value=SHA256_OID_VALUE
  const oidTlv = derTlv(0x06, SHA256_OID_VALUE);

  // NULL TLV: 05 00
  const nullTlv = Buffer.from([0x05, 0x00]);

  // AlgorithmIdentifier SEQUENCE: { oid, null }
  const algoId = derTlv(0x30, Buffer.concat([oidTlv, nullTlv]));

  // hashedMessage OCTET STRING: 04 20 <32 bytes>
  const hashedMsg = derTlv(0x04, messageHash);

  // MessageImprint SEQUENCE: { algoId, hashedMsg }
  const msgImprint = derTlv(0x30, Buffer.concat([algoId, hashedMsg]));

  // version INTEGER (1): 02 01 01
  const versionTlv = Buffer.from([0x02, 0x01, 0x01]);

  // certReq BOOLEAN (TRUE): 01 01 ff
  const certReqTlv = Buffer.from([0x01, 0x01, 0xff]);

  // TimeStampReq SEQUENCE: { version, msgImprint, certReq }
  return derTlv(0x30, Buffer.concat([versionTlv, msgImprint, certReqTlv]));
}

/**
 * Encode a DER TLV (tag–length–value) element.
 *
 * Supports short-form length (0–127) and long-form up to 65535 bytes.
 *
 * @param tag - DER tag byte (e.g. `0x30` = SEQUENCE, `0x04` = OCTET STRING).
 * @param value - Content bytes.
 * @returns Complete TLV buffer.
 * @internal
 */
function derTlv(tag: number, value: Buffer): Buffer {
  const len = value.length;
  let lenBytes: Buffer;

  if (len <= 0x7f) {
    lenBytes = Buffer.from([len]);
  } else if (len <= 0xff) {
    lenBytes = Buffer.from([0x81, len]);
  } else if (len <= 0xffff) {
    lenBytes = Buffer.from([0x82, (len >> 8) & 0xff, len & 0xff]);
  } else {
    throw new Error(`derTlv: value too large (${len} bytes). Maximum supported: 65535.`);
  }

  return Buffer.concat([Buffer.from([tag]), lenBytes, value]);
}

/**
 * POST a DER-encoded `TimeStampReq` to a TSA endpoint.
 *
 * Uses `node:https` for HTTPS URLs and `node:http` for HTTP URLs.
 * Enforces a 30-second timeout.
 *
 * @param tsaUrl - Full URL of the TSA endpoint.
 * @param body - DER-encoded `TimeStampReq` buffer.
 * @returns Raw response body as a `Buffer` (the `TimeStampResp` DER).
 * @throws On network error, non-2xx HTTP status, or timeout.
 */
export async function postTimestampRequest(tsaUrl: string, body: Buffer): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const url = new URL(tsaUrl);
    const isHttps = url.protocol === 'https:';

    const portRaw = url.port;
    const port = portRaw !== '' ? Number(portRaw) : isHttps ? 443 : 80;

    const options = {
      hostname: url.hostname,
      port,
      path: `${url.pathname}${url.search ?? ''}`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/timestamp-query',
        'Content-Length': body.length,
        Accept: 'application/timestamp-reply',
        'User-Agent': 'cleo-sentient/1.0 (RFC-3161-anchor)',
      },
    };

    const transport = isHttps ? https : http;

    const req = transport.request(options, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => {
        const responseBody = Buffer.concat(chunks);
        const status = res.statusCode ?? 0;
        if (status < 200 || status >= 300) {
          reject(
            new Error(
              `TSA returned HTTP ${status}. Response prefix (hex): ` +
                responseBody.subarray(0, 200).toString('hex'),
            ),
          );
          return;
        }
        resolve(responseBody);
      });
      res.on('error', (err: Error) => reject(err));
    });

    req.setTimeout(30_000, () => {
      req.destroy(new Error(`TSA request timed out after 30 s (url: ${tsaUrl})`));
    });

    req.on('error', (err: Error) => reject(err));
    req.write(body);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

/**
 * Information about the current chain HEAD event.
 *
 * @internal
 */
interface ChainHeadInfo {
  /** `receiptId` of the last event in the log. */
  receiptId: string;
  /** SHA-256 of the last event's raw serialised line (hex). */
  lineHash: string;
}

/**
 * Read the last event from the sentient events log and compute its SHA-256.
 *
 * Returns `null` if the log is absent or empty.
 *
 * @param projectRoot - Absolute path to the CLEO project root.
 * @internal
 */
async function readChainHead(projectRoot: string): Promise<ChainHeadInfo | null> {
  const eventsPath = join(projectRoot, SENTIENT_EVENTS_FILE);

  let raw: string;
  try {
    raw = await readFile(eventsPath, 'utf-8');
  } catch {
    return null;
  }

  const lines = raw.split('\n').filter((l) => l.trim().length > 0);
  if (lines.length === 0) return null;

  const lastLine = lines[lines.length - 1];
  const lineHash = crypto.createHash('sha256').update(lastLine, 'utf-8').digest('hex');

  let event: { receiptId?: string };
  try {
    event = JSON.parse(lastLine) as { receiptId?: string };
  } catch {
    return null;
  }

  return { receiptId: event.receiptId ?? '<unknown>', lineHash };
}
