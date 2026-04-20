/**
 * Tests for revert-pause / resume-after-revert (state.ts T1037 additions)
 *
 * Covers:
 *   - pauseAllTiers: sets killSwitch=true and pausedByRevert=true atomically
 *   - resumeAfterRevert: rejects if attestation signature not in ownerPubkeys
 *   - resumeAfterRevert: rejects if attestation.afterRevertReceiptId is missing
 *   - resumeAfterRevert: clears both flags on valid attestation
 *   - resumeSentientDaemon: fails with E_OWNER_ATTESTATION_REQUIRED when pausedByRevert=true
 *   - readSentientState: correctly deserialises pausedByRevert / revertReceiptId fields
 *
 * @task T1037
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentIdentity } from 'llmtxt/identity';
import { identityFromSeed } from 'llmtxt/identity';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SENTIENT_STATE_FILE } from '../daemon.js';
import {
  DEFAULT_SENTIENT_STATE,
  E_OWNER_ATTESTATION_REQUIRED,
  type OwnerRevertAttestation,
  pauseAllTiers,
  readSentientState,
  resumeAfterRevert,
  writeSentientState,
} from '../state.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeStatePath(dir: string): string {
  return join(dir, SENTIENT_STATE_FILE);
}

/**
 * Generate a valid owner attestation signed by the given identity.
 */
async function makeAttestation(
  identity: AgentIdentity,
  afterRevertReceiptId: string,
): Promise<OwnerRevertAttestation> {
  const issuedAt = new Date().toISOString();
  const ownerPubkey = identity.pubkeyHex;
  const unsigned = { afterRevertReceiptId, issuedAt, ownerPubkey };
  // Sort keys alphabetically for canonical serialisation (matches state.ts internal).
  const sorted: Record<string, string> = {};
  for (const k of Object.keys(unsigned).sort()) {
    sorted[k] = (unsigned as Record<string, string>)[k];
  }
  const bytes = Buffer.from(JSON.stringify(sorted), 'utf-8');
  const sigBytes = await identity.sign(bytes);
  const sig = Buffer.from(sigBytes).toString('hex');
  return { afterRevertReceiptId, issuedAt, ownerPubkey, sig };
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

let tmpDir: string;
let identity: AgentIdentity;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'cleo-state-pause-'));
  const seed = new Uint8Array(32);
  for (let i = 0; i < 32; i++) seed[i] = i + 10;
  identity = await identityFromSeed(seed);
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// pauseAllTiers
// ---------------------------------------------------------------------------

// TODO(T1074): unskip once state-pause subsystem ships (pausedByRevert + resumeAfterRevert + OwnerRevertAttestation).
describe('pauseAllTiers', () => {
  it('sets killSwitch=true and pausedByRevert=true atomically', async () => {
    const statePath = makeStatePath(tmpDir);
    // Write an initial non-paused state.
    await writeSentientState(statePath, { ...DEFAULT_SENTIENT_STATE });

    const revertReceiptId = 'receipt-ABC-001';
    const state = await pauseAllTiers(statePath, revertReceiptId);

    expect(state.killSwitch).toBe(true);
    expect(state.pausedByRevert).toBe(true);
    expect(state.revertReceiptId).toBe(revertReceiptId);
    expect(state.killSwitchReason).toBe(`owner-revert:${revertReceiptId}`);
  });

  it('persists the pause to disk — read-back matches', async () => {
    const statePath = makeStatePath(tmpDir);
    await writeSentientState(statePath, { ...DEFAULT_SENTIENT_STATE });

    await pauseAllTiers(statePath, 'receipt-XYZ');
    const onDisk = await readSentientState(statePath);

    expect(onDisk.killSwitch).toBe(true);
    expect(onDisk.pausedByRevert).toBe(true);
    expect(onDisk.revertReceiptId).toBe('receipt-XYZ');
  });

  it('can be called on a state that already has killSwitch=true', async () => {
    const statePath = makeStatePath(tmpDir);
    await writeSentientState(statePath, {
      ...DEFAULT_SENTIENT_STATE,
      killSwitch: true,
      killSwitchReason: 'manual-stop',
    });

    const state = await pauseAllTiers(statePath, 'receipt-override');
    expect(state.killSwitch).toBe(true);
    expect(state.pausedByRevert).toBe(true);
    expect(state.killSwitchReason).toBe('owner-revert:receipt-override');
  });
});

// ---------------------------------------------------------------------------
// resumeAfterRevert
// ---------------------------------------------------------------------------

// TODO(T1074): unskip once state-pause subsystem ships.
describe('resumeAfterRevert', () => {
  it('clears both killSwitch and pausedByRevert on valid attestation', async () => {
    const statePath = makeStatePath(tmpDir);
    await writeSentientState(statePath, {
      ...DEFAULT_SENTIENT_STATE,
      killSwitch: true,
      pausedByRevert: true,
      revertReceiptId: 'receipt-001',
    });

    const attestation = await makeAttestation(identity, 'receipt-001');
    const allowedPubkeys = new Set([identity.pubkeyHex]);

    const state = await resumeAfterRevert(statePath, attestation, allowedPubkeys);

    expect(state.killSwitch).toBe(false);
    expect(state.pausedByRevert).toBe(false);
    expect(state.revertReceiptId).toBeNull();
  });

  it('rejects if attestation.afterRevertReceiptId is missing', async () => {
    const statePath = makeStatePath(tmpDir);
    await writeSentientState(statePath, {
      ...DEFAULT_SENTIENT_STATE,
      killSwitch: true,
      pausedByRevert: true,
      revertReceiptId: 'receipt-001',
    });

    const badAttestation = {
      afterRevertReceiptId: '',
      issuedAt: new Date().toISOString(),
      ownerPubkey: identity.pubkeyHex,
      sig: '00'.repeat(64),
    };

    await expect(
      resumeAfterRevert(statePath, badAttestation, new Set([identity.pubkeyHex])),
    ).rejects.toThrow();
  });

  it('rejects if attestation pubkey is not in the allowlist', async () => {
    const statePath = makeStatePath(tmpDir);
    await writeSentientState(statePath, {
      ...DEFAULT_SENTIENT_STATE,
      killSwitch: true,
      pausedByRevert: true,
      revertReceiptId: 'receipt-001',
    });

    const attestation = await makeAttestation(identity, 'receipt-001');
    // Empty allowlist — no pubkeys allowed.
    const emptyAllowlist = new Set<string>();

    await expect(resumeAfterRevert(statePath, attestation, emptyAllowlist)).rejects.toThrow();
  });

  it('rejects if afterRevertReceiptId does not match stored revertReceiptId', async () => {
    const statePath = makeStatePath(tmpDir);
    await writeSentientState(statePath, {
      ...DEFAULT_SENTIENT_STATE,
      killSwitch: true,
      pausedByRevert: true,
      revertReceiptId: 'receipt-001',
    });

    // Attestation says a DIFFERENT receipt ID.
    const attestation = await makeAttestation(identity, 'receipt-DIFFERENT');
    const allowedPubkeys = new Set([identity.pubkeyHex]);

    await expect(resumeAfterRevert(statePath, attestation, allowedPubkeys)).rejects.toThrow();
  });

  it('rejects if state is not in pausedByRevert mode', async () => {
    const statePath = makeStatePath(tmpDir);
    // State is NOT paused by revert.
    await writeSentientState(statePath, { ...DEFAULT_SENTIENT_STATE });

    const attestation = await makeAttestation(identity, 'receipt-001');
    const allowedPubkeys = new Set([identity.pubkeyHex]);

    await expect(resumeAfterRevert(statePath, attestation, allowedPubkeys)).rejects.toThrow();
  });

  it('rejects if the attestation signature is tampered', async () => {
    const statePath = makeStatePath(tmpDir);
    await writeSentientState(statePath, {
      ...DEFAULT_SENTIENT_STATE,
      killSwitch: true,
      pausedByRevert: true,
      revertReceiptId: 'receipt-001',
    });

    const validAttestation = await makeAttestation(identity, 'receipt-001');
    // Flip the first byte of the signature.
    const tamperedSig = `0000${validAttestation.sig.slice(4)}`;
    const tampered: OwnerRevertAttestation = { ...validAttestation, sig: tamperedSig };
    const allowedPubkeys = new Set([identity.pubkeyHex]);

    await expect(resumeAfterRevert(statePath, tampered, allowedPubkeys)).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// E_OWNER_ATTESTATION_REQUIRED constant
// ---------------------------------------------------------------------------

// TODO(T1074): unskip once state-pause subsystem ships.
describe('E_OWNER_ATTESTATION_REQUIRED', () => {
  it('is exported as a string constant', () => {
    expect(typeof E_OWNER_ATTESTATION_REQUIRED).toBe('string');
    expect(E_OWNER_ATTESTATION_REQUIRED.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// DEFAULT_SENTIENT_STATE defaults
// ---------------------------------------------------------------------------

// TODO(T1074): unskip once state-pause subsystem ships.
describe('DEFAULT_SENTIENT_STATE', () => {
  it('has pausedByRevert=false and revertReceiptId=null by default', () => {
    expect(DEFAULT_SENTIENT_STATE.pausedByRevert).toBe(false);
    expect(DEFAULT_SENTIENT_STATE.revertReceiptId).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// readSentientState — backwards compatibility
// ---------------------------------------------------------------------------

// TODO(T1074): unskip once state-pause subsystem ships.
describe('readSentientState — new fields', () => {
  it('returns pausedByRevert=false when field is absent from file', async () => {
    const statePath = makeStatePath(tmpDir);
    // Write state without the new fields (simulating an older state file).
    const legacyState = { ...DEFAULT_SENTIENT_STATE };
    // Remove the new fields to simulate an older file.
    const legacyObj = { ...legacyState } as Record<string, unknown>;
    delete legacyObj['pausedByRevert'];
    delete legacyObj['revertReceiptId'];
    const { mkdir: mkdirFn, writeFile } = await import('node:fs/promises');
    const { dirname } = await import('node:path');
    await mkdirFn(dirname(statePath), { recursive: true });
    await writeFile(statePath, JSON.stringify(legacyObj), 'utf-8');

    const state = await readSentientState(statePath);
    expect(state.pausedByRevert).toBe(false);
    expect(state.revertReceiptId).toBeNull();
  });
});
