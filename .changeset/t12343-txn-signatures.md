---
id: t12343-txn-signatures
tasks: [T12343]
kind: feat
summary: Sync transaction signatures - every packed transaction is signed by the device for its stream
---

This is the second slice of the signed transactional outbox (T12343 O-2, journal spec §2.8 "Signing").

- **Each transaction's `sig`** is Ed25519 by the sending device's key over
  `cleo-nexus/txn/v1\n<stream>\n<txn>\n<sha256(canonical txn without sig)>`. `buildSegment` signs every transaction it packs, through the
  caller's `signTxn`.
- **`store/sync/txn-signing.ts`** provides `txnHash`, `txnSigningMessage`, `signTxn`, `verifyTxnSignature` and `firstBadTxnSignature`.
  A receiver refuses a whole segment holding one transaction that fails verification (§3.1); that check lands with S5 pull.
- **The message is client-only.** Transactions sit inside encrypted segments, so the server never sees them; the message is not part of
  the cleo-nexus shared signing copy.
