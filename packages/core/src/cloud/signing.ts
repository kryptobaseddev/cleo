/**
 * The exact bytes a device signs (Ed25519) for a journal segment.
 *
 * The signature binds the ciphertext hash to its stream, replica and position, so a valid
 * segment cannot be replayed into another stream or reordered within one.
 */
export function segmentSigningMessage(parts: {
  streamId: string;
  replicaId: string;
  replicaSeq: number;
  segmentHash: string;
}): Uint8Array {
  return new TextEncoder().encode(
    `cleo-nexus/segment/v1\n${parts.streamId}\n${parts.replicaId}\n${parts.replicaSeq}\n${parts.segmentHash}`,
  );
}
