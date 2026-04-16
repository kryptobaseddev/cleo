/**
 * Round-trip Zod parse tests for `Attachment` variants, `AttachmentMetadata`,
 * and `AttachmentRef`.
 *
 * Each test constructs a valid input object for one schema variant, parses it
 * through the corresponding Zod schema, and asserts the parsed output matches
 * the input shape exactly. This guarantees schemas accept all valid shapes
 * without transformation loss.
 *
 * Coverage: 5 variants × 2 cases (minimal + full) = 10 round-trip tests,
 * plus invalid-input rejection tests for each variant, and metadata/ref tests.
 *
 * @epic T760
 * @task T795
 */

import { describe, expect, it } from 'vitest';
import type { Attachment, AttachmentMetadata, AttachmentRef } from '../attachment.js';
import {
  attachmentMetadataSchema,
  attachmentRefSchema,
  attachmentSchema,
  blobAttachmentSchema,
  llmsTxtAttachmentSchema,
  llmtxtDocAttachmentSchema,
  localFileAttachmentSchema,
  urlAttachmentSchema,
} from '../attachment-schema.js';

/** Canonical 64-character SHA-256 hex string used across all tests. */
const SHA256 = 'a'.repeat(64);

// ─── LocalFileAttachment ──────────────────────────────────────────────────────

describe('localFileAttachmentSchema', () => {
  it('round-trips a minimal local-file attachment', () => {
    const input = {
      kind: 'local-file' as const,
      path: 'docs/rfc-003.md',
      sha256: SHA256,
      mime: 'text/markdown',
      size: 8192,
    };
    const result = localFileAttachmentSchema.parse(input);
    expect(result.kind).toBe('local-file');
    expect(result.path).toBe('docs/rfc-003.md');
    expect(result.sha256).toBe(SHA256);
    expect(result.mime).toBe('text/markdown');
    expect(result.size).toBe(8192);
    expect(result.description).toBeUndefined();
    expect(result.labels).toBeUndefined();
  });

  it('round-trips a full local-file attachment with optional fields', () => {
    const input = {
      kind: 'local-file' as const,
      path: '/absolute/path/to/report.pdf',
      sha256: SHA256,
      mime: 'application/pdf',
      size: 1_048_576,
      description: 'Pen-test report Q1 2026',
      labels: ['security', 'report'],
    };
    const result = localFileAttachmentSchema.parse(input);
    expect(result.description).toBe('Pen-test report Q1 2026');
    expect(result.labels).toEqual(['security', 'report']);
    expect(result.size).toBe(1_048_576);
  });

  it('rejects a sha256 that is not 64 characters', () => {
    expect(() =>
      localFileAttachmentSchema.parse({
        kind: 'local-file',
        path: 'docs/rfc.md',
        sha256: 'tooshort',
        mime: 'text/markdown',
        size: 100,
      }),
    ).toThrow();
  });

  it('rejects a negative size', () => {
    expect(() =>
      localFileAttachmentSchema.parse({
        kind: 'local-file',
        path: 'docs/rfc.md',
        sha256: SHA256,
        mime: 'text/markdown',
        size: -1,
      }),
    ).toThrow();
  });

  it('rejects an empty path', () => {
    expect(() =>
      localFileAttachmentSchema.parse({
        kind: 'local-file',
        path: '',
        sha256: SHA256,
        mime: 'text/markdown',
        size: 100,
      }),
    ).toThrow();
  });
});

// ─── UrlAttachment ────────────────────────────────────────────────────────────

describe('urlAttachmentSchema', () => {
  it('round-trips a minimal url attachment', () => {
    const input = {
      kind: 'url' as const,
      url: 'https://llmstxt.org',
    };
    const result = urlAttachmentSchema.parse(input);
    expect(result.kind).toBe('url');
    expect(result.url).toBe('https://llmstxt.org');
    expect(result.cachedSha256).toBeUndefined();
    expect(result.cachedAt).toBeUndefined();
    expect(result.mime).toBeUndefined();
  });

  it('round-trips a fully-cached url attachment', () => {
    const input = {
      kind: 'url' as const,
      url: 'https://example.com/spec.html',
      cachedSha256: SHA256,
      cachedAt: '2026-04-16T12:00:00.000Z',
      mime: 'text/html',
      description: 'llms.txt spec upstream cache',
      labels: ['spec', 'upstream'],
    };
    const result = urlAttachmentSchema.parse(input);
    expect(result.cachedSha256).toBe(SHA256);
    expect(result.cachedAt).toBe('2026-04-16T12:00:00.000Z');
    expect(result.mime).toBe('text/html');
    expect(result.labels).toEqual(['spec', 'upstream']);
  });

  it('rejects an invalid URL', () => {
    expect(() =>
      urlAttachmentSchema.parse({
        kind: 'url',
        url: 'not-a-url',
      }),
    ).toThrow();
  });

  it('rejects a cachedSha256 that is not 64 characters', () => {
    expect(() =>
      urlAttachmentSchema.parse({
        kind: 'url',
        url: 'https://example.com/',
        cachedSha256: 'bad',
      }),
    ).toThrow();
  });

  it('rejects an invalid cachedAt datetime', () => {
    expect(() =>
      urlAttachmentSchema.parse({
        kind: 'url',
        url: 'https://example.com/',
        cachedAt: 'not-a-datetime',
      }),
    ).toThrow();
  });
});

// ─── BlobAttachment ───────────────────────────────────────────────────────────

describe('blobAttachmentSchema', () => {
  it('round-trips a minimal blob attachment', () => {
    const input = {
      kind: 'blob' as const,
      sha256: SHA256,
      storageKey: 'aa/aaa…abc.pdf',
      mime: 'application/pdf',
      size: 2_097_152,
    };
    const result = blobAttachmentSchema.parse(input);
    expect(result.kind).toBe('blob');
    expect(result.sha256).toBe(SHA256);
    expect(result.storageKey).toBe('aa/aaa…abc.pdf');
    expect(result.mime).toBe('application/pdf');
    expect(result.size).toBe(2_097_152);
  });

  it('round-trips a full blob attachment with optional fields', () => {
    const input = {
      kind: 'blob' as const,
      sha256: SHA256,
      storageKey: 'ab/abcdef…12.png',
      mime: 'image/png',
      size: 512_000,
      description: 'Screenshot of the failing test run',
      labels: ['screenshot', 'evidence'],
    };
    const result = blobAttachmentSchema.parse(input);
    expect(result.description).toBe('Screenshot of the failing test run');
    expect(result.labels).toEqual(['screenshot', 'evidence']);
  });

  it('rejects an empty storageKey', () => {
    expect(() =>
      blobAttachmentSchema.parse({
        kind: 'blob',
        sha256: SHA256,
        storageKey: '',
        mime: 'application/pdf',
        size: 100,
      }),
    ).toThrow();
  });

  it('rejects an empty mime', () => {
    expect(() =>
      blobAttachmentSchema.parse({
        kind: 'blob',
        sha256: SHA256,
        storageKey: 'ab/abc.pdf',
        mime: '',
        size: 100,
      }),
    ).toThrow();
  });
});

// ─── LlmsTxtAttachment ────────────────────────────────────────────────────────

describe('llmsTxtAttachmentSchema', () => {
  it('round-trips a minimal llms-txt attachment (generated)', () => {
    const content = '# My Project\n\n> A great project.\n\n## Docs\n\n- [README](./README.md)';
    const input = {
      kind: 'llms-txt' as const,
      source: 'generated' as const,
      content,
      sha256: SHA256,
    };
    const result = llmsTxtAttachmentSchema.parse(input);
    expect(result.kind).toBe('llms-txt');
    expect(result.source).toBe('generated');
    expect(result.content).toBe(content);
    expect(result.sha256).toBe(SHA256);
  });

  it('round-trips a full llms-txt attachment (url source) with optional fields', () => {
    const content = '# llmstxt.org\n\n> The llms.txt spec.\n\n## Spec\n\n- [Spec](./spec.md)';
    const input = {
      kind: 'llms-txt' as const,
      source: 'url' as const,
      content,
      sha256: SHA256,
      description: 'llmstxt.org site index snapshot',
      labels: ['spec', 'upstream'],
    };
    const result = llmsTxtAttachmentSchema.parse(input);
    expect(result.source).toBe('url');
    expect(result.description).toBe('llmstxt.org site index snapshot');
    expect(result.labels).toEqual(['spec', 'upstream']);
  });

  it('rejects an empty content', () => {
    expect(() =>
      llmsTxtAttachmentSchema.parse({
        kind: 'llms-txt',
        source: 'generated',
        content: '',
        sha256: SHA256,
      }),
    ).toThrow();
  });

  it('rejects an invalid source value', () => {
    expect(() =>
      llmsTxtAttachmentSchema.parse({
        kind: 'llms-txt',
        source: 'clipboard',
        content: '# Foo',
        sha256: SHA256,
      }),
    ).toThrow();
  });
});

// ─── LlmtxtDocAttachment ──────────────────────────────────────────────────────

describe('llmtxtDocAttachmentSchema', () => {
  it('round-trips a minimal llmtxt-doc attachment (local backend)', () => {
    const input = {
      kind: 'llmtxt-doc' as const,
      slug: '9fZLOnf5',
      backend: 'local' as const,
    };
    const result = llmtxtDocAttachmentSchema.parse(input);
    expect(result.kind).toBe('llmtxt-doc');
    expect(result.slug).toBe('9fZLOnf5');
    expect(result.backend).toBe('local');
    expect(result.pinnedVersion).toBeUndefined();
  });

  it('round-trips a full llmtxt-doc attachment (remote backend) with optional fields', () => {
    const input = {
      kind: 'llmtxt-doc' as const,
      slug: 'AbCdEfGh',
      backend: 'remote' as const,
      pinnedVersion: '42',
      description: 'Architecture decision record v7 on llmtxt.my',
      labels: ['adr', 'versioned'],
    };
    const result = llmtxtDocAttachmentSchema.parse(input);
    expect(result.backend).toBe('remote');
    expect(result.pinnedVersion).toBe('42');
    expect(result.description).toBe('Architecture decision record v7 on llmtxt.my');
    expect(result.labels).toEqual(['adr', 'versioned']);
  });

  it('rejects an empty slug', () => {
    expect(() =>
      llmtxtDocAttachmentSchema.parse({
        kind: 'llmtxt-doc',
        slug: '',
        backend: 'local',
      }),
    ).toThrow();
  });

  it('rejects an invalid backend value', () => {
    expect(() =>
      llmtxtDocAttachmentSchema.parse({
        kind: 'llmtxt-doc',
        slug: 'abc123',
        backend: 'cloud',
      }),
    ).toThrow();
  });
});

// ─── attachmentSchema (discriminated union) ───────────────────────────────────

describe('attachmentSchema (discriminated union)', () => {
  it('routes local-file by kind', () => {
    const result = attachmentSchema.parse({
      kind: 'local-file',
      path: 'src/index.ts',
      sha256: SHA256,
      mime: 'application/typescript',
      size: 1024,
    });
    expect(result.kind).toBe('local-file');
    if (result.kind === 'local-file') {
      expect(result.path).toBe('src/index.ts');
    }
  });

  it('routes url by kind', () => {
    const result = attachmentSchema.parse({
      kind: 'url',
      url: 'https://example.com/',
    });
    expect(result.kind).toBe('url');
  });

  it('routes blob by kind', () => {
    const result = attachmentSchema.parse({
      kind: 'blob',
      sha256: SHA256,
      storageKey: 'ab/abc.pdf',
      mime: 'application/pdf',
      size: 100,
    });
    expect(result.kind).toBe('blob');
  });

  it('routes llms-txt by kind', () => {
    const result = attachmentSchema.parse({
      kind: 'llms-txt',
      source: 'generated',
      content: '# Project\n\n> Summary.',
      sha256: SHA256,
    });
    expect(result.kind).toBe('llms-txt');
  });

  it('routes llmtxt-doc by kind', () => {
    const result = attachmentSchema.parse({
      kind: 'llmtxt-doc',
      slug: 'xY12abCD',
      backend: 'local',
    });
    expect(result.kind).toBe('llmtxt-doc');
  });

  it('rejects an unknown kind', () => {
    expect(() =>
      attachmentSchema.parse({
        kind: 'unknown-kind',
        path: 'docs/foo.md',
      }),
    ).toThrow();
  });

  it('type-checks inferred type is assignable to Attachment', () => {
    const raw = {
      kind: 'blob' as const,
      sha256: SHA256,
      storageKey: 'ab/abc.bin',
      mime: 'application/octet-stream',
      size: 256,
    };
    const parsed = attachmentSchema.parse(raw);
    // Structural compatibility check with the canonical Attachment type.
    const att: Attachment = parsed;
    expect(att.kind).toBe('blob');
  });
});

// ─── attachmentMetadataSchema ─────────────────────────────────────────────────

describe('attachmentMetadataSchema', () => {
  it('round-trips a metadata row for a local-file attachment', () => {
    const input = {
      id: 'att_abc123',
      sha256: SHA256,
      attachment: {
        kind: 'local-file' as const,
        path: 'docs/spec.md',
        sha256: SHA256,
        mime: 'text/markdown',
        size: 4096,
      },
      createdAt: '2026-04-16T08:00:00.000Z',
      refCount: 3,
    };
    const result = attachmentMetadataSchema.parse(input);
    expect(result.id).toBe('att_abc123');
    expect(result.refCount).toBe(3);
    expect(result.attachment.kind).toBe('local-file');
    // TypeScript narrowing confirms the nested parse
    if (result.attachment.kind === 'local-file') {
      expect(result.attachment.path).toBe('docs/spec.md');
    }
  });

  it('round-trips a metadata row for a url attachment with refCount=0', () => {
    const input = {
      id: 'att_xyz789',
      sha256: '',
      attachment: {
        kind: 'url' as const,
        url: 'https://example.com/',
      },
      createdAt: '2026-04-16T09:00:00.000Z',
      refCount: 0,
    };
    const result = attachmentMetadataSchema.parse(input);
    expect(result.refCount).toBe(0);
    expect(result.sha256).toBe('');
  });

  it('type-checks inferred result is assignable to AttachmentMetadata', () => {
    const raw = {
      id: 'att_type_check',
      sha256: SHA256,
      attachment: {
        kind: 'blob' as const,
        sha256: SHA256,
        storageKey: 'ab/abc.pdf',
        mime: 'application/pdf',
        size: 512,
      },
      createdAt: '2026-04-16T10:00:00.000Z',
      refCount: 1,
    };
    const parsed = attachmentMetadataSchema.parse(raw);
    const meta: AttachmentMetadata = parsed;
    expect(meta.id).toBe('att_type_check');
  });

  it('rejects a negative refCount', () => {
    expect(() =>
      attachmentMetadataSchema.parse({
        id: 'att_bad',
        sha256: SHA256,
        attachment: {
          kind: 'local-file',
          path: 'x.ts',
          sha256: SHA256,
          mime: 'text/plain',
          size: 10,
        },
        createdAt: '2026-04-16T00:00:00.000Z',
        refCount: -1,
      }),
    ).toThrow();
  });

  it('rejects an invalid createdAt timestamp', () => {
    expect(() =>
      attachmentMetadataSchema.parse({
        id: 'att_bad2',
        sha256: SHA256,
        attachment: {
          kind: 'local-file',
          path: 'x.ts',
          sha256: SHA256,
          mime: 'text/plain',
          size: 10,
        },
        createdAt: 'not-a-date',
        refCount: 0,
      }),
    ).toThrow();
  });
});

// ─── attachmentRefSchema ──────────────────────────────────────────────────────

describe('attachmentRefSchema', () => {
  it('round-trips a minimal ref row (task owner)', () => {
    const input = {
      attachmentId: 'att_abc123',
      ownerType: 'task' as const,
      ownerId: 'T766',
      attachedAt: '2026-04-16T08:30:00.000Z',
    };
    const result = attachmentRefSchema.parse(input);
    expect(result.attachmentId).toBe('att_abc123');
    expect(result.ownerType).toBe('task');
    expect(result.ownerId).toBe('T766');
    expect(result.attachedBy).toBeUndefined();
  });

  it('round-trips a ref row with all owner types and attachedBy', () => {
    const ownerTypes = [
      'task',
      'observation',
      'session',
      'decision',
      'learning',
      'pattern',
    ] as const;

    for (const ownerType of ownerTypes) {
      const result = attachmentRefSchema.parse({
        attachmentId: 'att_xyz',
        ownerType,
        ownerId: 'owner-001',
        attachedAt: '2026-04-16T08:30:00.000Z',
        attachedBy: 'cleo-prime',
      });
      expect(result.ownerType).toBe(ownerType);
      expect(result.attachedBy).toBe('cleo-prime');
    }
  });

  it('type-checks inferred result is assignable to AttachmentRef', () => {
    const raw = {
      attachmentId: 'att_type',
      ownerType: 'observation' as const,
      ownerId: 'O-abc123',
      attachedAt: '2026-04-16T00:00:00.000Z',
    };
    const parsed = attachmentRefSchema.parse(raw);
    const ref: AttachmentRef = parsed;
    expect(ref.ownerId).toBe('O-abc123');
  });

  it('rejects an invalid ownerType', () => {
    expect(() =>
      attachmentRefSchema.parse({
        attachmentId: 'att_xyz',
        ownerType: 'message',
        ownerId: 'msg_001',
        attachedAt: '2026-04-16T08:30:00.000Z',
      }),
    ).toThrow();
  });

  it('rejects an empty attachmentId', () => {
    expect(() =>
      attachmentRefSchema.parse({
        attachmentId: '',
        ownerType: 'task',
        ownerId: 'T001',
        attachedAt: '2026-04-16T08:30:00.000Z',
      }),
    ).toThrow();
  });

  it('rejects an invalid attachedAt datetime', () => {
    expect(() =>
      attachmentRefSchema.parse({
        attachmentId: 'att_ok',
        ownerType: 'task',
        ownerId: 'T001',
        attachedAt: 'yesterday',
      }),
    ).toThrow();
  });
});
