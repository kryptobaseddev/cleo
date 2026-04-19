/**
 * llmtxt subpath import smoke tests — T947.
 *
 * Verifies that every stable subpath of `llmtxt@2026.4.9` declared in its
 * `package.json` `exports` map resolves and loads without error when imported
 * from `@cleocode/core`. This guards against:
 *
 *   1. Version bumps that silently drop or rename a subpath.
 *   2. Build pipelines that fail to externalize llmtxt's optional native
 *      peer deps (better-sqlite3, @vlcn.io/crsqlite, onnxruntime-node,
 *      postgres, drizzle-orm).
 *   3. ESM/CJS dual-format regressions.
 *
 * Each stable subpath (10 paths) is imported via dynamic `import()`. The
 * `llmtxt/blob` subpath additionally has its `BlobFsAdapter` constructor
 * shape checked (prototype methods) — this subpath is the primary
 * integration target tracked by T947.
 *
 * Type-only subpaths (`similarity`, `graph`, `disclosure`, `embeddings`)
 * are verified by runtime import — their `*.d.ts` exports re-export types
 * that must not throw on module evaluation.
 *
 * @epic T947
 * @see packages/core/src/store/llmtxt-blob-adapter.ts
 */

import { describe, expect, it } from 'vitest';

describe('llmtxt subpath imports (T947)', () => {
  it('imports main entry (`llmtxt`) with createBackend + hashBlob', async () => {
    const mod = await import('llmtxt');
    expect(typeof mod.createBackend).toBe('function');
    // hashBlob is also re-exported from the main entry via compression.js
    expect(typeof mod.hashBlob).toBe('function');
  });

  it('imports `llmtxt/sdk` with AgentSession + ContributionReceipt', async () => {
    const mod = await import('llmtxt/sdk');
    expect(typeof mod.AgentSession).toBe('function');
    // ContributionReceipt is a type-only export; verify module object exists
    expect(mod).toBeDefined();
    // Concrete SDK runtime exports
    expect(typeof mod.LlmtxtDocument).toBe('function');
    expect(typeof mod.evaluateApprovals).toBe('function');
  });

  it('imports `llmtxt/blob` with BlobFsAdapter + hashBlob', async () => {
    const mod = await import('llmtxt/blob');
    expect(typeof mod.BlobFsAdapter).toBe('function');
    expect(typeof mod.hashBlob).toBe('function');
    expect(typeof mod.validateBlobName).toBe('function');
    // Error classes are runtime values (extends Error)
    expect(typeof mod.BlobNotFoundError).toBe('function');
    expect(typeof mod.BlobCorruptError).toBe('function');
    expect(typeof mod.BlobTooLargeError).toBe('function');
    expect(typeof mod.BlobNameInvalidError).toBe('function');
    expect(typeof mod.BlobAccessDeniedError).toBe('function');

    // Verify BlobFsAdapter prototype surface per contract (BlobOps).
    // The constructor requires a Drizzle BetterSQLite3Database, so we
    // only check the prototype methods here — instantiation is covered
    // by llmtxt-blob-adapter.test.ts when better-sqlite3 is available.
    const proto = mod.BlobFsAdapter.prototype as Record<string, unknown>;
    expect(typeof proto.attachBlob).toBe('function');
    expect(typeof proto.getBlob).toBe('function');
    expect(typeof proto.listBlobs).toBe('function');
    expect(typeof proto.detachBlob).toBe('function');
    expect(typeof proto.fetchBlobByHash).toBe('function');
  });

  it('imports `llmtxt/identity` with AgentIdentity + signRequest + verifySignature', async () => {
    const mod = await import('llmtxt/identity');
    expect(typeof mod.AgentIdentity).toBe('function');
    expect(typeof mod.signRequest).toBe('function');
    expect(typeof mod.verifySignature).toBe('function');
    expect(typeof mod.buildCanonicalPayload).toBe('function');
    expect(typeof mod.bodyHashHex).toBe('function');
    expect(typeof mod.randomNonceHex).toBe('function');
    expect(typeof mod.createIdentity).toBe('function');
    expect(typeof mod.loadIdentity).toBe('function');
    expect(typeof mod.identityFromSeed).toBe('function');
  });

  it('imports `llmtxt/transport` with PeerTransport concrete classes', async () => {
    const mod = await import('llmtxt/transport');
    // PeerTransport is an interface (type-only), concrete impls are classes
    expect(typeof mod.UnixSocketTransport).toBe('function');
    expect(typeof mod.HttpTransport).toBe('function');
    expect(typeof mod.HandshakeFailedError).toBe('function');
    expect(typeof mod.PeerUnreachableError).toBe('function');
    expect(typeof mod.ChangesetTooLargeError).toBe('function');
    expect(typeof mod.MAX_CHANGESET_BYTES).toBe('number');
  });

  it('imports `llmtxt/crdt` with subscribeSection + getSectionText', async () => {
    const mod = await import('llmtxt/crdt');
    expect(typeof mod.subscribeSection).toBe('function');
    expect(typeof mod.getSectionText).toBe('function');
  });

  it('imports `llmtxt/similarity` (types-only subpath: runtime exports)', async () => {
    const mod = await import('llmtxt/similarity');
    expect(mod).toBeDefined();
    // Concrete runtime exports from similarity.ts
    expect(typeof mod.contentSimilarity).toBe('function');
    expect(typeof mod.extractNgrams).toBe('function');
    expect(typeof mod.textSimilarity).toBe('function');
  });

  it('imports `llmtxt/graph` (types-only subpath: runtime exports)', async () => {
    const mod = await import('llmtxt/graph');
    expect(mod).toBeDefined();
    expect(typeof mod.buildGraph).toBe('function');
    expect(typeof mod.extractDirectives).toBe('function');
    expect(typeof mod.extractMentions).toBe('function');
    expect(typeof mod.extractTags).toBe('function');
  });

  it('imports `llmtxt/disclosure` (types-only subpath: runtime exports)', async () => {
    const mod = await import('llmtxt/disclosure');
    expect(mod).toBeDefined();
    expect(typeof mod.getLineRange).toBe('function');
    expect(typeof mod.searchContent).toBe('function');
    expect(typeof mod.detectDocumentFormat).toBe('function');
    expect(typeof mod.generateOverview).toBe('function');
  });

  it('imports `llmtxt/embeddings` (types-only subpath: runtime exports)', async () => {
    const mod = await import('llmtxt/embeddings');
    expect(mod).toBeDefined();
    // embeddings.js re-exports tfidfEmbed etc. via wasm
    expect(mod).not.toBeNull();
  });
});
