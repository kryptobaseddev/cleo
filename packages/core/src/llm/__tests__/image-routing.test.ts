/**
 * Tests for image-routing helpers (T9276 — T-LLM-CRED Phase 3).
 *
 * Covers:
 *  - {@link decideImageInputMode} — explicit override, aux-vision flag, auto resolution
 *  - {@link sniffMimeFromBytes}   — magic-byte MIME detection for all recognised formats
 *  - {@link imageSizeLimitFor}    — per-provider size limit table
 *
 * @task T9276
 */

import { describe, expect, it } from 'vitest';
import {
  decideImageInputMode,
  imageSizeLimitFor,
  PROVIDER_IMAGE_SIZE_LIMITS,
  sniffMimeFromBytes,
} from '../image-routing.js';

// ---------------------------------------------------------------------------
// decideImageInputMode
// ---------------------------------------------------------------------------

describe('decideImageInputMode', () => {
  describe('explicit override', () => {
    it('honours explicit native for anthropic', () => {
      expect(
        decideImageInputMode('anthropic', 'claude-haiku-4-5', { imageInputMode: 'native' }),
      ).toBe('native');
    });

    it('honours explicit text for gpt-4o (overrides capable model)', () => {
      expect(decideImageInputMode('openai', 'gpt-4o', { imageInputMode: 'text' })).toBe('text');
    });

    it('honours explicit native for unknown provider', () => {
      expect(decideImageInputMode('zzz-provider', 'some-model', { imageInputMode: 'native' })).toBe(
        'native',
      );
    });
  });

  describe('auto mode — aux vision configured', () => {
    it('returns text when auxVisionConfigured even for native-capable model', () => {
      expect(
        decideImageInputMode('anthropic', 'claude-opus-4-5', { auxVisionConfigured: true }),
      ).toBe('text');
    });

    it('returns text when auxVisionConfigured for openai vision model', () => {
      expect(decideImageInputMode('openai', 'gpt-4o', { auxVisionConfigured: true })).toBe('text');
    });
  });

  describe('auto mode — capability lookup', () => {
    // Anthropic — all models support vision
    it('returns native for anthropic + any model', () => {
      expect(decideImageInputMode('anthropic', 'claude-haiku-4-5')).toBe('native');
    });

    it('returns native for anthropic + claude-opus-4-5', () => {
      expect(decideImageInputMode('anthropic', 'claude-opus-4-5')).toBe('native');
    });

    // OpenAI — only specific families
    it('returns native for openai + gpt-4o', () => {
      expect(decideImageInputMode('openai', 'gpt-4o')).toBe('native');
    });

    it('returns native for openai + gpt-4o-mini', () => {
      expect(decideImageInputMode('openai', 'gpt-4o-mini')).toBe('native');
    });

    it('returns native for openai + gpt-4-vision-preview', () => {
      expect(decideImageInputMode('openai', 'gpt-4-vision-preview')).toBe('native');
    });

    it('returns native for openai + gpt-4.1', () => {
      expect(decideImageInputMode('openai', 'gpt-4.1')).toBe('native');
    });

    it('returns native for openai + o1', () => {
      expect(decideImageInputMode('openai', 'o1')).toBe('native');
    });

    it('returns native for openai + o3-mini', () => {
      expect(decideImageInputMode('openai', 'o3-mini')).toBe('native');
    });

    it('returns text for openai + gpt-3.5-turbo (non-vision)', () => {
      expect(decideImageInputMode('openai', 'gpt-3.5-turbo')).toBe('text');
    });

    it('returns text for openai + text-davinci-003', () => {
      expect(decideImageInputMode('openai', 'text-davinci-003')).toBe('text');
    });

    // Gemini / Google
    it('returns native for gemini + gemini-1.5-pro', () => {
      expect(decideImageInputMode('gemini', 'gemini-1.5-pro')).toBe('native');
    });

    it('returns native for google + gemini-2.0-flash', () => {
      expect(decideImageInputMode('google', 'gemini-2.0-flash')).toBe('native');
    });

    it('returns native for gemini + gemini-2.5-pro', () => {
      expect(decideImageInputMode('gemini', 'gemini-2.5-pro')).toBe('native');
    });

    it('returns text for gemini + gemini-1.0-pro (non-vision generation)', () => {
      expect(decideImageInputMode('gemini', 'gemini-1.0-pro')).toBe('text');
    });

    // OpenRouter
    it('returns native for openrouter + claude-3-opus (claude fragment)', () => {
      expect(decideImageInputMode('openrouter', 'anthropic/claude-3-opus')).toBe('native');
    });

    it('returns native for openrouter + gpt-4o via openai org', () => {
      expect(decideImageInputMode('openrouter', 'openai/gpt-4o')).toBe('native');
    });

    it('returns native for openrouter + llama-3.2-vision', () => {
      expect(decideImageInputMode('openrouter', 'meta-llama/llama-3.2-vision')).toBe('native');
    });

    it('returns text for openrouter + llama-3.1 (non-vision generation)', () => {
      // llama-3.1 does not match llama-3.[2-9]
      expect(decideImageInputMode('openrouter', 'meta-llama/llama-3.1-8b')).toBe('text');
    });

    // xAI
    it('returns native for xai + grok-2-vision', () => {
      expect(decideImageInputMode('xai', 'grok-2-vision')).toBe('native');
    });

    it('returns native for xai + grok-2', () => {
      expect(decideImageInputMode('xai', 'grok-2')).toBe('native');
    });

    it('returns text for xai + grok-1', () => {
      expect(decideImageInputMode('xai', 'grok-1')).toBe('text');
    });

    // Unknown provider
    it('returns text for unknown provider', () => {
      expect(decideImageInputMode('mystery-ai', 'some-model')).toBe('text');
    });

    // No config supplied
    it('returns native for anthropic with no config', () => {
      expect(decideImageInputMode('anthropic', 'claude-haiku-4-5')).toBe('native');
    });

    it('returns text for unknown model with no config', () => {
      expect(decideImageInputMode('openai', 'gpt-3.5-turbo')).toBe('text');
    });
  });

  describe('auto mode — case insensitivity', () => {
    it('handles uppercase provider', () => {
      expect(decideImageInputMode('ANTHROPIC', 'claude-opus-4-5')).toBe('native');
    });

    it('handles mixed-case model', () => {
      expect(decideImageInputMode('openai', 'GPT-4O')).toBe('native');
    });
  });
});

// ---------------------------------------------------------------------------
// sniffMimeFromBytes
// ---------------------------------------------------------------------------

describe('sniffMimeFromBytes', () => {
  it.each([
    [
      'PNG',
      new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]),
      'image/png',
    ],
    [
      'JPEG',
      new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01]),
      'image/jpeg',
    ],
    [
      'JPEG (EXIF)',
      new Uint8Array([0xff, 0xd8, 0xff, 0xe1, 0x00, 0x00, 0x45, 0x78, 0x69, 0x66, 0x00, 0x00]),
      'image/jpeg',
    ],
    [
      'GIF89a',
      new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x01, 0x00, 0x01, 0x00, 0x00, 0x00]),
      'image/gif',
    ],
    [
      'GIF87a',
      new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x37, 0x61, 0x01, 0x00, 0x01, 0x00, 0x00, 0x00]),
      'image/gif',
    ],
    [
      'WebP',
      new Uint8Array([
        0x52,
        0x49,
        0x46,
        0x46, // "RIFF"
        0x24,
        0x00,
        0x00,
        0x00, // file size (arbitrary)
        0x57,
        0x45,
        0x42,
        0x50, // "WEBP"
      ]),
      'image/webp',
    ],
    [
      'BMP',
      new Uint8Array([0x42, 0x4d, 0x36, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x36, 0x00]),
      'image/bmp',
    ],
    [
      'HEIC (heic brand)',
      new Uint8Array([
        0x00,
        0x00,
        0x00,
        0x18, // box size
        0x66,
        0x74,
        0x79,
        0x70, // "ftyp"
        0x68,
        0x65,
        0x69,
        0x63, // "heic"
      ]),
      'image/heic',
    ],
    [
      'HEIF (mif1 brand)',
      new Uint8Array([
        0x00,
        0x00,
        0x00,
        0x18,
        0x66,
        0x74,
        0x79,
        0x70, // "ftyp"
        0x6d,
        0x69,
        0x66,
        0x31, // "mif1"
      ]),
      'image/heic',
    ],
    [
      'HEIF (msf1 brand)',
      new Uint8Array([
        0x00,
        0x00,
        0x00,
        0x18,
        0x66,
        0x74,
        0x79,
        0x70,
        0x6d,
        0x73,
        0x66,
        0x31, // "msf1"
      ]),
      'image/heic',
    ],
  ] as const)('detects %s', (_label, bytes, expected) => {
    expect(sniffMimeFromBytes(bytes)).toBe(expected);
  });

  it('returns null for unknown magic bytes', () => {
    expect(sniffMimeFromBytes(new Uint8Array([0x00, 0x00, 0x00, 0x00]))).toBeNull();
  });

  it('returns null for too-short input (< 4 bytes)', () => {
    expect(sniffMimeFromBytes(new Uint8Array([0xff, 0xd8]))).toBeNull();
  });

  it('returns null for empty input', () => {
    expect(sniffMimeFromBytes(new Uint8Array([]))).toBeNull();
  });

  it('returns null for 3-byte input', () => {
    expect(sniffMimeFromBytes(new Uint8Array([0x89, 0x50, 0x4e]))).toBeNull();
  });

  it('returns null for a ftyp box with unknown brand', () => {
    const bytes = new Uint8Array([
      0x00,
      0x00,
      0x00,
      0x18,
      0x66,
      0x74,
      0x79,
      0x70, // "ftyp"
      0x6d,
      0x70,
      0x34,
      0x32, // "mp42" (MP4, not HEIC)
    ]);
    expect(sniffMimeFromBytes(bytes)).toBeNull();
  });

  it('returns null for RIFF without WEBP marker', () => {
    const bytes = new Uint8Array([
      0x52,
      0x49,
      0x46,
      0x46, // "RIFF"
      0x24,
      0x00,
      0x00,
      0x00,
      0x41,
      0x56,
      0x49,
      0x20, // "AVI " — not WEBP
    ]);
    expect(sniffMimeFromBytes(bytes)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// imageSizeLimitFor
// ---------------------------------------------------------------------------

describe('imageSizeLimitFor', () => {
  it('returns anthropic 5 MB', () => {
    expect(imageSizeLimitFor('anthropic')).toBe(5 * 1024 * 1024);
  });

  it('returns openai 49 MB', () => {
    expect(imageSizeLimitFor('openai')).toBe(49 * 1024 * 1024);
  });

  it('returns gemini 100 MB', () => {
    expect(imageSizeLimitFor('gemini')).toBe(100 * 1024 * 1024);
  });

  it('returns google 100 MB (alias for gemini)', () => {
    expect(imageSizeLimitFor('google')).toBe(100 * 1024 * 1024);
  });

  it('returns bedrock 5 MB', () => {
    expect(imageSizeLimitFor('bedrock')).toBe(5 * 1024 * 1024);
  });

  it('returns Infinity for unknown provider', () => {
    expect(imageSizeLimitFor('mystery-provider')).toBe(Number.POSITIVE_INFINITY);
  });

  it('is case-insensitive (ANTHROPIC)', () => {
    expect(imageSizeLimitFor('ANTHROPIC')).toBe(imageSizeLimitFor('anthropic'));
  });

  it('is case-insensitive (Gemini)', () => {
    expect(imageSizeLimitFor('Gemini')).toBe(imageSizeLimitFor('gemini'));
  });

  it('matches PROVIDER_IMAGE_SIZE_LIMITS constant for all known providers', () => {
    for (const [provider, limit] of Object.entries(PROVIDER_IMAGE_SIZE_LIMITS)) {
      expect(imageSizeLimitFor(provider)).toBe(limit);
    }
  });
});
