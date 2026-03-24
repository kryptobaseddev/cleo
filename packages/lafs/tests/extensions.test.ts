/**
 * Tests for A2A Extensions Support (T098)
 */

import { describe, it, expect } from 'vitest';
import request from 'supertest';
import express from 'express';
import {
  parseExtensionsHeader,
  negotiateExtensions,
  formatExtensionsHeader,
  buildLafsExtension,
  buildExtension,
  isValidExtensionKind,
  validateExtensionDeclaration,
  ExtensionSupportRequiredError,
  extensionNegotiationMiddleware,
  LAFS_EXTENSION_URI,
  A2A_EXTENSIONS_HEADER,
} from '../src/a2a/extensions.js';
import type { AgentExtension } from '@a2a-js/sdk';
import { discoveryMiddleware, type DiscoveryConfig } from '../src/discovery.js';

// ============================================================================
// parseExtensionsHeader
// ============================================================================

describe('parseExtensionsHeader', () => {
  it('should return empty array for undefined', () => {
    expect(parseExtensionsHeader(undefined)).toEqual([]);
  });

  it('should return empty array for empty string', () => {
    expect(parseExtensionsHeader('')).toEqual([]);
  });

  it('should parse single URI', () => {
    expect(parseExtensionsHeader('https://example.com/ext/v1')).toEqual([
      'https://example.com/ext/v1',
    ]);
  });

  it('should parse multiple comma-separated URIs', () => {
    const result = parseExtensionsHeader(
      'https://example.com/ext1,https://example.com/ext2,https://example.com/ext3'
    );
    expect(result).toEqual([
      'https://example.com/ext1',
      'https://example.com/ext2',
      'https://example.com/ext3',
    ]);
  });

  it('should trim whitespace from URIs', () => {
    const result = parseExtensionsHeader(
      '  https://example.com/ext1 , https://example.com/ext2 '
    );
    expect(result).toEqual([
      'https://example.com/ext1',
      'https://example.com/ext2',
    ]);
  });

  it('should filter empty entries from trailing commas', () => {
    const result = parseExtensionsHeader('https://example.com/ext1,,');
    expect(result).toEqual(['https://example.com/ext1']);
  });
});

// ============================================================================
// negotiateExtensions
// ============================================================================

describe('negotiateExtensions', () => {
  const agentExtensions: AgentExtension[] = [
    { uri: 'https://example.com/ext1', description: 'Ext 1', required: false },
    { uri: 'https://example.com/ext2', description: 'Ext 2', required: true },
    { uri: LAFS_EXTENSION_URI, description: 'LAFS', required: false },
  ];

  it('should activate all supported extensions', () => {
    const result = negotiateExtensions(
      ['https://example.com/ext1', 'https://example.com/ext2', LAFS_EXTENSION_URI],
      agentExtensions
    );
    expect(result.activated).toEqual([
      'https://example.com/ext1',
      'https://example.com/ext2',
      LAFS_EXTENSION_URI,
    ]);
    expect(result.unsupported).toEqual([]);
    expect(result.missingRequired).toEqual([]);
    expect(result.activatedByKind).toBeDefined();
  });

  it('should ignore unsupported extensions per spec', () => {
    const result = negotiateExtensions(
      ['https://example.com/ext1', 'https://unknown.com/ext'],
      agentExtensions
    );
    expect(result.activated).toEqual(['https://example.com/ext1']);
    expect(result.unsupported).toEqual(['https://unknown.com/ext']);
  });

  it('should flag missing required extensions', () => {
    const result = negotiateExtensions(
      ['https://example.com/ext1'],
      agentExtensions
    );
    expect(result.missingRequired).toEqual(['https://example.com/ext2']);
  });

  it('should not flag required extensions that are present', () => {
    const result = negotiateExtensions(
      ['https://example.com/ext2'],
      agentExtensions
    );
    expect(result.missingRequired).toEqual([]);
  });

  it('should handle empty requested list', () => {
    const result = negotiateExtensions([], agentExtensions);
    expect(result.activated).toEqual([]);
    expect(result.unsupported).toEqual([]);
    expect(result.missingRequired).toEqual(['https://example.com/ext2']);
  });

  it('should handle empty agent extensions', () => {
    const result = negotiateExtensions(['https://example.com/ext1'], []);
    expect(result.activated).toEqual([]);
    expect(result.unsupported).toEqual(['https://example.com/ext1']);
    expect(result.missingRequired).toEqual([]);
  });
});

// ============================================================================
// formatExtensionsHeader
// ============================================================================

describe('formatExtensionsHeader', () => {
  it('should join URIs with comma', () => {
    expect(
      formatExtensionsHeader(['https://ext1.com', 'https://ext2.com'])
    ).toBe('https://ext1.com,https://ext2.com');
  });

  it('should handle single URI', () => {
    expect(formatExtensionsHeader(['https://ext1.com'])).toBe('https://ext1.com');
  });

  it('should handle empty array', () => {
    expect(formatExtensionsHeader([])).toBe('');
  });
});

// ============================================================================
// buildLafsExtension
// ============================================================================

describe('buildLafsExtension', () => {
  it('should build with default params', () => {
    const ext = buildLafsExtension();
    expect(ext.uri).toBe(LAFS_EXTENSION_URI);
    expect(ext.description).toBe('LAFS envelope protocol for structured agent responses');
    expect(ext.required).toBe(false);
    expect(ext.params).toEqual({
      supportsContextLedger: false,
      supportsTokenBudgets: false,
      envelopeSchema: 'https://lafs.dev/schemas/v1/envelope.schema.json',
      kind: 'profile',
    });
  });

  it('should build with custom params', () => {
    const ext = buildLafsExtension({
      supportsContextLedger: true,
      supportsTokenBudgets: true,
      envelopeSchema: 'https://custom.example.com/schema.json',
    });
    expect(ext.params).toEqual({
      supportsContextLedger: true,
      supportsTokenBudgets: true,
      envelopeSchema: 'https://custom.example.com/schema.json',
      kind: 'profile',
    });
  });

  it('should set required flag', () => {
    const ext = buildLafsExtension({ required: true });
    expect(ext.required).toBe(true);
  });

  it('should always use canonical LAFS URI', () => {
    const ext = buildLafsExtension();
    expect(ext.uri).toBe('https://lafs.dev/extensions/envelope/v1');
  });

  it('supports all extension kinds via generic builder', () => {
    const extKinds = ['data-only', 'profile', 'method', 'state-machine'] as const;
    for (const kind of extKinds) {
      const ext = buildExtension({
        uri: `https://example.com/ext/${kind}`,
        description: `${kind} extension`,
        kind,
      });
      expect((ext.params as Record<string, unknown>)['kind']).toBe(kind);
      expect(validateExtensionDeclaration(ext).valid).toBe(true);
      expect(isValidExtensionKind(kind)).toBe(true);
    }
  });

  it('rejects invalid extension kind declarations', () => {
    const invalid = {
      uri: 'https://example.com/ext/invalid',
      description: 'invalid extension',
      required: false,
      params: { kind: 'invalid-kind' },
    } as AgentExtension;

    const result = validateExtensionDeclaration(invalid);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('invalid extension kind');
  });
});

// ============================================================================
// ExtensionSupportRequiredError
// ============================================================================

describe('ExtensionSupportRequiredError', () => {
  it('should construct with missing extensions', () => {
    const error = new ExtensionSupportRequiredError(['https://ext1.com', 'https://ext2.com']);
    expect(error.name).toBe('ExtensionSupportRequiredError');
    expect(error.code).toBe(-32008);
    expect(error.httpStatus).toBe(400);
    expect(error.grpcStatus).toBe('FAILED_PRECONDITION');
    expect(error.missingExtensions).toEqual(['https://ext1.com', 'https://ext2.com']);
    expect(error.message).toContain('https://ext1.com');
  });

  it('should convert to JSON-RPC error', () => {
    const error = new ExtensionSupportRequiredError(['https://ext1.com']);
    const rpcError = error.toJSONRPCError();
    expect(rpcError.code).toBe(-32008);
    expect(rpcError.message).toContain('ext1.com');
    expect(rpcError.data).toEqual({ missingExtensions: ['https://ext1.com'] });
  });

  it('should convert to Problem Details', () => {
    const error = new ExtensionSupportRequiredError(['https://ext1.com']);
    const pd = error.toProblemDetails();
    expect(pd['type']).toBe('https://a2a-protocol.org/errors/extension-support-required');
    expect(pd['title']).toBe('Extension Support Required');
    expect(pd['status']).toBe(400);
    expect(pd['detail']).toContain('ext1.com');
    expect(pd['missingExtensions']).toEqual(['https://ext1.com']);
  });
});

// ============================================================================
// extensionNegotiationMiddleware (supertest)
// ============================================================================

describe('extensionNegotiationMiddleware', () => {
  const lafsExt = buildLafsExtension();
  const agentExtensions: AgentExtension[] = [lafsExt];

  function createApp(options: { extensions: AgentExtension[]; enforceRequired?: boolean }) {
    const app = express();
    app.use(extensionNegotiationMiddleware(options));
    app.get('/test', (req, res) => {
      res.json({ extensions: res.locals['a2aExtensions'] });
    });
    return app;
  }

  it('should activate LAFS extension when requested', async () => {
    const app = createApp({ extensions: agentExtensions });
    const response = await request(app)
      .get('/test')
      .set('A2A-Extensions', LAFS_EXTENSION_URI)
      .expect(200);

    expect(response.body.extensions.activated).toContain(LAFS_EXTENSION_URI);
    expect(response.headers[A2A_EXTENSIONS_HEADER.toLowerCase()]).toContain(LAFS_EXTENSION_URI);
  });

  it('should also accept X-A2A-Extensions header (SDK compat)', async () => {
    const app = createApp({ extensions: agentExtensions });
    const response = await request(app)
      .get('/test')
      .set('X-A2A-Extensions', LAFS_EXTENSION_URI)
      .expect(200);

    expect(response.body.extensions.activated).toContain(LAFS_EXTENSION_URI);
  });

  it('should set response header with activated extensions', async () => {
    const app = createApp({ extensions: agentExtensions });
    const response = await request(app)
      .get('/test')
      .set('A2A-Extensions', LAFS_EXTENSION_URI)
      .expect(200);

    const header = response.headers[A2A_EXTENSIONS_HEADER.toLowerCase()];
    expect(header).toBeDefined();
    expect(header).toContain(LAFS_EXTENSION_URI);
  });

  it('should reject with 400 when required extensions are missing', async () => {
    const requiredExt: AgentExtension[] = [
      { uri: 'https://example.com/required', description: 'Required', required: true },
    ];
    const app = createApp({ extensions: requiredExt });

    const response = await request(app)
      .get('/test')
      .expect(400);

    expect(response.body.type).toBe('https://a2a-protocol.org/errors/extension-support-required');
    expect(response.body.status).toBe(400);
    expect(response.headers['content-type']).toMatch(/application\/problem\+json/);
  });

  it('should not reject when enforceRequired is false', async () => {
    const requiredExt: AgentExtension[] = [
      { uri: 'https://example.com/required', description: 'Required', required: true },
    ];
    const app = createApp({ extensions: requiredExt, enforceRequired: false });

    const response = await request(app)
      .get('/test')
      .expect(200);

    expect(response.body.extensions.missingRequired).toContain('https://example.com/required');
  });

  it('should ignore unsupported extensions', async () => {
    const app = createApp({ extensions: agentExtensions });
    const response = await request(app)
      .get('/test')
      .set('A2A-Extensions', `${LAFS_EXTENSION_URI},https://unknown.com/ext`)
      .expect(200);

    expect(response.body.extensions.activated).toEqual([LAFS_EXTENSION_URI]);
    expect(response.body.extensions.unsupported).toEqual(['https://unknown.com/ext']);
  });

  it('should proceed with empty extensions when no header sent', async () => {
    const app = createApp({ extensions: agentExtensions });
    const response = await request(app)
      .get('/test')
      .expect(200);

    expect(response.body.extensions.activated).toEqual([]);
    expect(response.body.extensions.requested).toEqual([]);
  });
});

// ============================================================================
// Discovery Integration
// ============================================================================

describe('Discovery integration: autoIncludeLafsExtension', () => {
  it('should add LAFS extension to Agent Card with autoIncludeLafsExtension: true', async () => {
    const config: DiscoveryConfig = {
      agent: {
        name: 'test-agent',
        description: 'Test agent',
        version: '1.0.0',
        url: 'https://example.com',
        capabilities: { streaming: false },
        defaultInputModes: ['application/json'],
        defaultOutputModes: ['application/json'],
        skills: [],
      },
      autoIncludeLafsExtension: true,
    };

    const app = express();
    app.use(discoveryMiddleware(config));

    const response = await request(app)
      .get('/.well-known/agent-card.json')
      .expect(200);

    const extensions = response.body.capabilities?.extensions;
    expect(extensions).toBeDefined();
    expect(extensions).toHaveLength(1);
    expect(extensions[0].uri).toBe(LAFS_EXTENSION_URI);
    expect(extensions[0].required).toBe(false);
    expect(extensions[0].params.envelopeSchema).toBe(
      'https://lafs.dev/schemas/v1/envelope.schema.json'
    );
  });

  it('should respect custom options in autoIncludeLafsExtension', async () => {
    const config: DiscoveryConfig = {
      agent: {
        name: 'test-agent',
        description: 'Test agent',
        version: '1.0.0',
        url: 'https://example.com',
        capabilities: { streaming: false },
        defaultInputModes: ['application/json'],
        defaultOutputModes: ['application/json'],
        skills: [],
      },
      autoIncludeLafsExtension: {
        required: true,
        supportsContextLedger: true,
      },
    };

    const app = express();
    app.use(discoveryMiddleware(config));

    const response = await request(app)
      .get('/.well-known/agent-card.json')
      .expect(200);

    const ext = response.body.capabilities.extensions[0];
    expect(ext.required).toBe(true);
    expect(ext.params.supportsContextLedger).toBe(true);
  });

  it('should not add LAFS extension when autoIncludeLafsExtension is absent', async () => {
    const config: DiscoveryConfig = {
      agent: {
        name: 'test-agent',
        description: 'Test agent',
        version: '1.0.0',
        url: 'https://example.com',
        capabilities: { streaming: false, extensions: [] },
        defaultInputModes: ['application/json'],
        defaultOutputModes: ['application/json'],
        skills: [],
      },
    };

    const app = express();
    app.use(discoveryMiddleware(config));

    const response = await request(app)
      .get('/.well-known/agent-card.json')
      .expect(200);

    expect(response.body.capabilities.extensions).toEqual([]);
  });
});
