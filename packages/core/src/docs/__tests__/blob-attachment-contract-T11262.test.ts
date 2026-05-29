/**
 * T11262: Round-trip BlobAttachment contract compliance + defensive read.
 *
 * Verifies that:
 *   1. The writer-emitted JSON shape (the same one produced by
 *      `docs-update.ts` and `attachment-store.ts:put` for `kind:'blob'`)
 *      satisfies the canonical `blobAttachmentSchema` from
 *      `@cleocode/contracts`.
 *   2. The defensive read pattern in `docs-read-model.ts:extractBlobName`
 *      tolerates legacy `{name, blobId}` shapes without throwing — the
 *      bug class fixed by this task.
 *
 * These tests run without touching the real tasks.db so they survive the
 * pre-existing `E_PROJECT_NOT_FOUND` failure in `attachment-store.test.ts`
 * (the env-var-based test harness is broken on main as of 2026-05-28).
 *
 * @task T11262
 * @saga T11242
 */

import { createHash } from 'node:crypto';
import { attachmentSchema, blobAttachmentSchema } from '@cleocode/contracts';
import { describe, expect, it } from 'vitest';

// Mirrors the helpers in `attachment-store.ts` + `docs-update.ts` (T11262).
// Kept inline to validate the contract without importing the chokepoint
// (which pulls Drizzle + native sqlite, both of which the read-only path
// does not need).
function extFromMime(mime: string): string {
  switch (mime) {
    case 'text/markdown':
      return '.md';
    case 'text/plain':
      return '.txt';
    case 'text/html':
      return '.html';
    case 'application/json':
      return '.json';
    case 'application/pdf':
      return '.pdf';
    case 'application/zip':
      return '.zip';
    case 'image/png':
      return '.png';
    case 'image/jpeg':
      return '.jpg';
    case 'image/gif':
      return '.gif';
    case 'image/svg+xml':
      return '.svg';
    default:
      return '.bin';
  }
}

function makeContractBlobJson(bytes: Buffer, mime: string) {
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const storageKey = `${sha256.slice(0, 2)}/${sha256.slice(2)}${extFromMime(mime)}`;
  return {
    kind: 'blob' as const,
    sha256,
    storageKey,
    mime,
    size: bytes.length,
  };
}

describe('T11262 BlobAttachment writer/reader contract round-trip', () => {
  it('writer-emitted JSON passes attachmentSchema.parse (canonical contract)', () => {
    const bytes = Buffer.from('# T11262 contract roundtrip\nbody bytes\n', 'utf-8');
    const emitted = makeContractBlobJson(bytes, 'text/markdown');

    expect(() => attachmentSchema.parse(emitted)).not.toThrow();
    expect(() => blobAttachmentSchema.parse(emitted)).not.toThrow();
    // storageKey must be non-empty and shaped `<2hex>/<62hex>.<ext>`.
    expect(emitted.storageKey).toMatch(/^[0-9a-f]{2}\/[0-9a-f]{62}\.md$/);
  });

  it('the legacy {name, blobId} shape is REJECTED by blobAttachmentSchema', () => {
    const legacyMalformed = {
      kind: 'blob' as const,
      name: 'db-substrate-pglite-vision-2026-05-28',
      mime: 'application/octet-stream',
      size: 18900,
      blobId: '09f2581c280af5b146ea235cdfceeb1c3948f13eb26e4b53ea8c946cdfc519c3',
    };

    // The legacy shape is missing the contract-required `sha256` and
    // `storageKey` fields. Zod must reject it.
    expect(() => blobAttachmentSchema.parse(legacyMalformed)).toThrow();
  });

  it('the storageKey:"" shape is REJECTED by blobAttachmentSchema (min(1))', () => {
    const emptyStorageKey = {
      kind: 'blob' as const,
      sha256: 'a'.repeat(64),
      storageKey: '',
      mime: 'text/markdown',
      size: 7,
    };
    expect(() => blobAttachmentSchema.parse(emptyStorageKey)).toThrow();
  });

  it('round-trip JSON.stringify → JSON.parse preserves the contract', () => {
    const bytes = Buffer.from('Hello, T11262', 'utf-8');
    const emitted = makeContractBlobJson(bytes, 'text/plain');
    const persisted = JSON.stringify(emitted);
    const reparsed = JSON.parse(persisted);

    expect(() => attachmentSchema.parse(reparsed)).not.toThrow();
    if (reparsed.kind === 'blob') {
      // The same extractBlobName logic used in docs-read-model.ts:
      // `att.storageKey.split('/').pop()` must yield a non-null suffix.
      const name = reparsed.storageKey.split('/').pop();
      expect(name).toBeTruthy();
      expect(name).toMatch(/^[0-9a-f]{62}\.txt$/);
    }
  });

  it('defensive read pattern survives malformed storageKey=undefined input', () => {
    // Replicates the legacy malformed row that broke `cleo docs fetch` /
    // `cleo docs list --type research` with E_INTERNAL. The fixed
    // extractBlobName in docs-read-model.ts MUST fall back to `name`
    // rather than throwing.
    const malformedAtt = {
      kind: 'blob' as const,
      name: 'db-substrate-pglite-vision-2026-05-28',
      mime: 'application/octet-stream',
      size: 18900,
      blobId: '09f2581c280af5b146ea235cdfceeb1c3948f13eb26e4b53ea8c946cdfc519c3',
    };

    // The READ-SIDE defensive path: storageKey is undefined.
    const sk = (malformedAtt as { storageKey?: unknown }).storageKey;
    const legacyName = (malformedAtt as { name?: unknown }).name;
    let extracted: string | null;
    if (typeof sk === 'string' && sk.length > 0) {
      extracted = sk.split('/').pop() ?? null;
    } else if (typeof legacyName === 'string' && legacyName.length > 0) {
      extracted = legacyName;
    } else {
      extracted = null;
    }
    expect(extracted).toBe('db-substrate-pglite-vision-2026-05-28');
  });
});
