/**
 * Transaction signatures (journal spec §2.8 "Signing"; T12343 O-2).
 *
 * Every transaction a replica sends carries `sig`: Ed25519 by the sending
 * device's key over
 *
 *   `cleo-nexus/txn/v1\n<stream>\n<txn>\n<sha256(canonical txn without sig)>`
 *
 * where the canonical txn is the same canonical JSON the segment plaintext
 * carries, with the `sig` key removed. The segment signature (segment/v3)
 * covers the ciphertext and its metadata; the transaction signature binds
 * each transaction to its stream and its author's device, so a receiver
 * refuses a whole segment holding one transaction that fails it
 * (`E_FORBIDDEN bad-txn-signature`, §3.1). The server never sees these: they
 * live inside the encrypted segment, so this message is client-only and is
 * not part of the cleo-nexus shared signing copy.
 *
 * @task T12343
 * @module store/sync/txn-signing
 */

import type { LedgerTxn } from '@cleocode/contracts/ledger';
import { type KeyPair, sha256Hex, signEd25519, verifyEd25519 } from '../../cloud/crypto.js';
import { canonicalJson } from './sealer-values.js';

/** The domain string every transaction signature starts with. */
export const TXN_SIGNING_DOMAIN = 'cleo-nexus/txn/v1';

/**
 * sha256 (lowercase hex) of the canonical JSON of `txn` without its `sig`.
 *
 * @param txn - The transaction.
 * @returns The hash its signature covers.
 */
export function txnHash(txn: LedgerTxn): string {
  const { sig: _sig, ...unsigned } = txn;
  return sha256Hex(Buffer.from(canonicalJson(unsigned), 'utf8'));
}

/**
 * The exact bytes a transaction signature covers (§2.8).
 *
 * @param stream - The stream the transaction is sent on.
 * @param txn - The transaction.
 * @returns The UTF-8 signing message.
 */
export function txnSigningMessage(stream: string, txn: LedgerTxn): Uint8Array {
  return Buffer.from(`${TXN_SIGNING_DOMAIN}\n${stream}\n${txn.txn}\n${txnHash(txn)}`, 'utf8');
}

/**
 * Sign a transaction for `stream` with the device key.
 *
 * @param signing - The device's Ed25519 key pair.
 * @param stream - The stream.
 * @param txn - The transaction (its current `sig` is ignored).
 * @returns The transaction carrying its base64 signature.
 */
export function signTxn(signing: KeyPair, stream: string, txn: LedgerTxn): LedgerTxn {
  return { ...txn, sig: signEd25519(signing, txnSigningMessage(stream, txn)).toString('base64') };
}

/**
 * Whether `txn.sig` is a valid signature for `stream` by `publicKey`.
 *
 * @param publicKey - The author device's Ed25519 public key (raw bytes).
 * @param stream - The stream the transaction arrived on.
 * @param txn - The transaction.
 * @returns True when the signature verifies.
 */
export function verifyTxnSignature(publicKey: Uint8Array, stream: string, txn: LedgerTxn): boolean {
  return verifyEd25519(publicKey, txnSigningMessage(stream, txn), Buffer.from(txn.sig, 'base64'));
}

/**
 * The index of the first transaction of a segment whose signature does not
 * verify, or null when all do. A receiver refuses the whole segment on any
 * (§3.1).
 *
 * @param publicKey - The segment author's device public key.
 * @param stream - The stream.
 * @param txns - The segment's transactions.
 * @returns The first bad index, or null.
 */
export function firstBadTxnSignature(
  publicKey: Uint8Array,
  stream: string,
  txns: readonly LedgerTxn[],
): number | null {
  const i = txns.findIndex((t) => !verifyTxnSignature(publicKey, stream, t));
  return i === -1 ? null : i;
}
