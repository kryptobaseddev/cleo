import {
  argon2,
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  type KeyObject,
  randomBytes,
  sign,
  timingSafeEqual,
  verify,
} from 'node:crypto';
import { KDF_LIMITS } from '@cleocode/contracts/cloud';

/**
 * Cleo Nexus E2E primitives. Spec: docs/security/e2e-keys.md. Uses Node 24 node:crypto only.
 * Every AEAD message derives a fresh subkey from a random 32-byte salt, so ChaCha20-Poly1305's
 * 96-bit nonce is never reused under one key.
 */

const AEAD_VERSION = 0x01;
const SEAL_VERSION = 0x02;
const SALT = 32;
const NONCE = 12;
const TAG = 16;

export class DecryptError extends Error {
  constructor(message = 'decryption failed: wrong key, wrong context, or tampered ciphertext') {
    super(message);
    this.name = 'DecryptError';
  }
}

export const randomKey = (): Buffer => randomBytes(32);

function subkey(ikm: Uint8Array, salt: Uint8Array, purpose: string): Buffer {
  return Buffer.from(hkdfSync('sha256', ikm, salt, `cleo-nexus/${purpose}/v1`, 32));
}

/** Derive a named key from a parent key (no salt). Examples: home-stream, verifier. */
export function deriveKey(parent: Uint8Array, purpose: string): Buffer {
  return Buffer.from(hkdfSync('sha256', parent, Buffer.alloc(0), `cleo-nexus/${purpose}/v1`, 32));
}

/** AEAD-encrypt `plaintext` under `key`, bound to `context` (AAD) and `purpose` (HKDF info). */
export function seal(
  key: Uint8Array,
  plaintext: Uint8Array,
  purpose: string,
  context: string,
): Buffer {
  if (key.length !== 32) throw new Error('key must be 32 bytes');
  const salt = randomBytes(SALT);
  const nonce = randomBytes(NONCE);
  const cipher = createCipheriv('chacha20-poly1305', subkey(key, salt, purpose), nonce, {
    authTagLength: TAG,
  });
  cipher.setAAD(Buffer.from(context, 'utf8'), { plaintextLength: plaintext.length });
  const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([Buffer.of(AEAD_VERSION), salt, nonce, body, cipher.getAuthTag()]);
}

export function open(
  key: Uint8Array,
  envelope: Uint8Array,
  purpose: string,
  context: string,
): Buffer {
  const e = Buffer.from(envelope);
  if (e.length < 1 + SALT + NONCE + TAG || e[0] !== AEAD_VERSION)
    throw new DecryptError('not an AEAD v1 envelope');
  const salt = e.subarray(1, 1 + SALT);
  const nonce = e.subarray(1 + SALT, 1 + SALT + NONCE);
  const body = e.subarray(1 + SALT + NONCE, e.length - TAG);
  const tag = e.subarray(e.length - TAG);
  try {
    const d = createDecipheriv('chacha20-poly1305', subkey(key, salt, purpose), nonce, {
      authTagLength: TAG,
    });
    d.setAAD(Buffer.from(context, 'utf8'), { plaintextLength: body.length });
    d.setAuthTag(tag);
    return Buffer.concat([d.update(body), d.final()]);
  } catch {
    throw new DecryptError();
  }
}

// ---------- X25519 sealed box ----------

const b64u = (b: Uint8Array) => Buffer.from(b).toString('base64url');

function x25519Public(raw: Uint8Array): KeyObject {
  return createPublicKey({ key: { kty: 'OKP', crv: 'X25519', x: b64u(raw) }, format: 'jwk' });
}

export interface KeyPair {
  publicKey: Buffer;
  privateKey: Buffer;
}

export function generateX25519(): KeyPair {
  const { publicKey, privateKey } = generateKeyPairSync('x25519');
  const jwk = privateKey.export({ format: 'jwk' });
  return {
    publicKey: Buffer.from(publicKey.export({ format: 'jwk' }).x as string, 'base64url'),
    privateKey: Buffer.from(jwk.d as string, 'base64url'),
  };
}

function x25519Private(pub: Uint8Array, priv: Uint8Array): KeyObject {
  return createPrivateKey({
    key: { kty: 'OKP', crv: 'X25519', x: b64u(pub), d: b64u(priv) },
    format: 'jwk',
  });
}

/** Encrypt to a recipient's X25519 public key. Only the holder of the private key can open it. */
export function sealTo(
  recipientPublic: Uint8Array,
  plaintext: Uint8Array,
  context: string,
): Buffer {
  const eph = generateKeyPairSync('x25519');
  const ephPub = Buffer.from(eph.publicKey.export({ format: 'jwk' }).x as string, 'base64url');
  const shared = diffieHellman({
    privateKey: eph.privateKey,
    publicKey: x25519Public(recipientPublic),
  });
  const k = Buffer.from(
    hkdfSync('sha256', shared, Buffer.concat([ephPub, recipientPublic]), 'cleo-nexus/seal/v1', 32),
  );
  return Buffer.concat([Buffer.of(SEAL_VERSION), ephPub, seal(k, plaintext, 'seal', context)]);
}

export function openSealed(recipient: KeyPair, sealed: Uint8Array, context: string): Buffer {
  const s = Buffer.from(sealed);
  if (s.length < 33 || s[0] !== SEAL_VERSION)
    throw new DecryptError('not a sealed-box v2 envelope');
  const ephPub = s.subarray(1, 33);
  try {
    const shared = diffieHellman({
      privateKey: x25519Private(recipient.publicKey, recipient.privateKey),
      publicKey: x25519Public(ephPub),
    });
    const k = Buffer.from(
      hkdfSync(
        'sha256',
        shared,
        Buffer.concat([ephPub, recipient.publicKey]),
        'cleo-nexus/seal/v1',
        32,
      ),
    );
    return open(k, s.subarray(33), 'seal', context);
  } catch (err) {
    if (err instanceof DecryptError) throw err;
    throw new DecryptError();
  }
}

// ---------- Ed25519 ----------

export function generateEd25519(): KeyPair {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return {
    publicKey: Buffer.from(publicKey.export({ format: 'jwk' }).x as string, 'base64url'),
    privateKey: Buffer.from(privateKey.export({ format: 'jwk' }).d as string, 'base64url'),
  };
}

export function signEd25519(kp: KeyPair, message: Uint8Array): Buffer {
  const key = createPrivateKey({
    key: { kty: 'OKP', crv: 'Ed25519', x: b64u(kp.publicKey), d: b64u(kp.privateKey) },
    format: 'jwk',
  });
  return sign(null, message, key);
}

export function verifyEd25519(
  publicKey: Uint8Array,
  message: Uint8Array,
  signature: Uint8Array,
): boolean {
  try {
    const key = createPublicKey({
      key: { kty: 'OKP', crv: 'Ed25519', x: b64u(publicKey) },
      format: 'jwk',
    });
    return verify(null, message, key, signature);
  } catch {
    return false;
  }
}

// ---------- passphrase (Argon2id) ----------

export interface KdfParams {
  algorithm: 'argon2id';
  memoryKiB: number;
  iterations: number;
  parallelism: number;
  salt: string;
}

export const DEFAULT_KDF = { memoryKiB: 65_536, iterations: 3, parallelism: 1 } as const;

export function newKdfParams(): KdfParams {
  return { algorithm: 'argon2id', ...DEFAULT_KDF, salt: randomBytes(16).toString('base64') };
}

/**
 * Refuse KDF parameters outside KDF_LIMITS. They come from the server, which must not be able to weaken
 * the passphrase stretch or make the client allocate unbounded memory.
 */
export function checkKdfParams(p: KdfParams): void {
  const within = (v: number, b: { min: number; max: number }) =>
    Number.isInteger(v) && v >= b.min && v <= b.max;
  const salt = Buffer.from(p.salt, 'base64');
  if (
    p.algorithm !== 'argon2id' ||
    !within(p.memoryKiB, KDF_LIMITS.memoryKiB) ||
    !within(p.iterations, KDF_LIMITS.iterations) ||
    !within(p.parallelism, KDF_LIMITS.parallelism) ||
    salt.length < 16 ||
    salt.length > 64
  ) {
    throw new RangeError('KDF parameters are outside the accepted bounds');
  }
}

export function passphraseKey(passphrase: string, p: KdfParams): Promise<Buffer> {
  checkKdfParams(p);
  return new Promise((resolve, reject) => {
    argon2(
      'argon2id',
      {
        message: Buffer.from(passphrase.normalize('NFKC'), 'utf8'),
        nonce: Buffer.from(p.salt, 'base64'),
        parallelism: p.parallelism,
        tagLength: 32,
        memory: p.memoryKiB,
        passes: p.iterations,
      },
      (err, key) => (err ? reject(err) : resolve(Buffer.from(key))),
    );
  });
}

// ---------- recovery key (Crockford base32, 13×4 chars with a 4-bit checksum) ----------

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

export function encodeRecoveryKey(key: Uint8Array): string {
  if (key.length !== 32) throw new Error('recovery key must be 32 bytes');
  const check = (createHash('sha256').update(key).digest()[0] ?? 0) >> 4;
  let bits = 0n;
  for (const b of key) bits = (bits << 8n) | BigInt(b);
  bits = (bits << 4n) | BigInt(check);
  let out = '';
  for (let i = 51; i >= 0; i--) out += CROCKFORD[Number((bits >> BigInt(i * 5)) & 31n)];
  return out.match(/.{4}/g)?.join('-') ?? out;
}

export function decodeRecoveryKey(text: string): Buffer {
  const clean = text.toUpperCase().replace(/[-\s]/g, '').replace(/[IL]/g, '1').replace(/O/g, '0');
  if (clean.length !== 52) throw new Error('recovery key must be 52 characters');
  let bits = 0n;
  for (const ch of clean) {
    const v = CROCKFORD.indexOf(ch);
    if (v < 0) throw new Error(`invalid recovery key character: ${ch}`);
    bits = (bits << 5n) | BigInt(v);
  }
  const check = Number(bits & 15n);
  bits >>= 4n;
  const key = Buffer.alloc(32);
  for (let i = 31; i >= 0; i--) {
    key[i] = Number(bits & 255n);
    bits >>= 8n;
  }
  if ((createHash('sha256').update(key).digest()[0] ?? 0) >> 4 !== check) {
    throw new Error('recovery key checksum mismatch: check for a typo');
  }
  return key;
}

export function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}

export const sha256Hex = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

export const hmacSha256 = (key: Uint8Array, message: Uint8Array): Buffer =>
  createHmac('sha256', key).update(message).digest();

export { uuidv7 } from './uuidv7.js';
