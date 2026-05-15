/**
 * Image input routing helpers — ported from Hermes `agent/image_routing.py`.
 *
 * Two modes decide how user-attached images are presented to the main LLM on
 * each turn:
 *
 * - `native`:  attach image bytes / data-URL as a multimodal content part.
 *              Provider adapters (Anthropic, OpenAI, Gemini …) translate to
 *              their vendor format.
 * - `text`:    run a vision-analysis step and prepend a textual description.
 *              The main model only sees prose; no pixels are forwarded.
 *
 * Resolution is done once per turn by {@link decideImageInputMode}.
 * Per-image and per-request validation is done by {@link validateImagesForProvider}.
 *
 * @module image-routing
 * @task T9276 (T-LLM-CRED Phase 3)
 * @task T9296 (W4d — wire validateImagesForProvider into transport complete())
 * @epic T9261
 */

import type {
  TransportImageBlock,
  TransportMessage,
  TransportRequest,
} from '@cleocode/contracts/llm/normalized-response.js';

/**
 * Image input mode for an LLM turn.
 *
 * - `'native'` — pass image bytes / data-URL directly to the model.
 * - `'text'`   — describe the image via an auxiliary vision step; send prose
 *                to the main model.
 *
 * @task T9276
 */
export type ImageInputMode = 'native' | 'text';

/**
 * Per-provider maximum image size in bytes.
 *
 * The table mirrors Hermes' reactive shrink-on-413 logic. These values are
 * exposed so that an upload layer can proactively warn the user, but actual
 * enforcement should remain reactive (attempt full size → shrink on rejection)
 * to avoid silently degrading quality for providers that accept larger files.
 *
 * Returns `Number.POSITIVE_INFINITY` for unknown providers (via
 * {@link imageSizeLimitFor}).
 *
 * @task T9276
 */
export const PROVIDER_IMAGE_SIZE_LIMITS: Readonly<Record<string, number>> = Object.freeze({
  anthropic: 5 * 1024 * 1024, // 5 MB — Anthropic hard limit per image
  openai: 49 * 1024 * 1024, // 49 MB
  gemini: 100 * 1024 * 1024, // 100 MB
  google: 100 * 1024 * 1024, // alias for gemini
  bedrock: 5 * 1024 * 1024, // Claude-on-Bedrock mirrors Anthropic ceiling
});

/**
 * Configuration knobs for {@link decideImageInputMode}.
 *
 * @task T9276
 */
export interface DecideImageInputModeConfig {
  /**
   * Explicit mode override from agent config (`image_input_mode` key).
   *
   * - `'native'` / `'text'` — honour immediately, skip capability check.
   * - `'auto'`              — apply resolution logic (default).
   */
  imageInputMode?: 'native' | 'text' | 'auto';

  /**
   * `true` when the operator has configured an explicit auxiliary vision
   * backend (not `'auto'`, not blank). When set, the text pipeline is
   * preferred in `auto` mode regardless of model vision capability, because
   * the operator deliberately chose a dedicated vision provider.
   */
  auxVisionConfigured?: boolean;
}

/**
 * Decide whether images on the current turn should be forwarded natively to
 * the LLM or pre-processed via an auxiliary vision model.
 *
 * Resolution order (matches Hermes `decide_image_input_mode`):
 * 1. Explicit `'native'` or `'text'` in `config.imageInputMode` wins immediately.
 * 2. `auto` + auxiliary vision configured → `'text'` (operator intent).
 * 3. `auto` + model supports native vision → `'native'`.
 * 4. Otherwise → `'text'` (safe fallback for non-vision models).
 *
 * @param provider - Inference provider ID (e.g. `'anthropic'`, `'openrouter'`).
 * @param model    - Model slug as sent to the provider (e.g. `'claude-opus-4-5'`).
 * @param config   - Optional routing config. Defaults to `auto` + no aux vision.
 * @returns `'native'` or `'text'`.
 *
 * @task T9276
 */
export function decideImageInputMode(
  provider: string,
  model: string,
  config?: DecideImageInputModeConfig,
): ImageInputMode {
  const mode = config?.imageInputMode ?? 'auto';

  if (mode === 'native') return 'native';
  if (mode === 'text') return 'text';

  // auto: prefer text when operator has a dedicated vision backend configured.
  if (config?.auxVisionConfigured) return 'text';

  return supportsNativeVision(provider, model) ? 'native' : 'text';
}

/**
 * Return `true` if the `(provider, model)` pair is known to support native
 * multimodal vision input.
 *
 * Mirrors Hermes' `_lookup_supports_vision` capability table. Expand as new
 * vision-capable models ship; the safe default for unknown models is `false`
 * (→ text fallback, no quality regression).
 *
 * @param provider - Normalised provider ID.
 * @param model    - Model slug (case-insensitive match).
 *
 * @internal
 */
function supportsNativeVision(provider: string, model: string): boolean {
  const p = provider.toLowerCase();
  const m = model.toLowerCase();

  // Anthropic: all Claude 3+ models support vision.
  if (p === 'anthropic') return true;

  // OpenAI: GPT-4o family, GPT-4.1, GPT-5, o-series reasoning models.
  if (p === 'openai') return /gpt-4o|gpt-4-vision|gpt-4\.1|gpt-5|o1|o3/.test(m);

  // Google / Gemini: Gemini 1.5 and later generations.
  if (p === 'gemini' || p === 'google') return /1\.5|2\.0|2\.5|3\.0/.test(m);

  // OpenRouter: pass-through — trust model slug for known vision families.
  if (p === 'openrouter') return /vision|gpt-4o|claude|gemini|grok|llama-3\.[2-9]/.test(m);

  // xAI: Grok vision variants and grok-2+.
  if (p === 'xai') return /vision|grok-2/.test(m);

  return false;
}

/**
 * Sniff an image MIME type from the leading bytes of the raw file content.
 *
 * Filename-based detection (`Content-Type` headers, file extensions) is
 * unreliable when upstream platforms lie — Discord, for example, can serve a
 * PNG with `content_type=image/webp` for certain proxied images. Anthropic
 * strictly validates that the declared `media_type` matches the actual bytes
 * and returns HTTP 400 on mismatch, so magic-byte sniffing is authoritative.
 *
 * Recognises: `image/png`, `image/jpeg`, `image/gif`, `image/webp`,
 * `image/bmp`, `image/heic`. Returns `null` for unrecognised formats.
 *
 * @param raw - Leading bytes of the image file (at least 12 bytes recommended).
 * @returns MIME type string, or `null` if the format is not recognised.
 *
 * @task T9276
 */
export function sniffMimeFromBytes(raw: Uint8Array): string | null {
  if (raw.length < 4) return null;

  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (raw[0] === 0x89 && raw[1] === 0x50 && raw[2] === 0x4e && raw[3] === 0x47) {
    return 'image/png';
  }

  // JPEG: FF D8 FF
  if (raw[0] === 0xff && raw[1] === 0xd8 && raw[2] === 0xff) {
    return 'image/jpeg';
  }

  // GIF87a / GIF89a: 47 49 46 38
  if (raw[0] === 0x47 && raw[1] === 0x49 && raw[2] === 0x46 && raw[3] === 0x38) {
    return 'image/gif';
  }

  // WebP: "RIFF" at [0..3], "WEBP" at [8..11]
  if (
    raw.length >= 12 &&
    raw[0] === 0x52 &&
    raw[1] === 0x49 &&
    raw[2] === 0x46 &&
    raw[3] === 0x46 &&
    raw[8] === 0x57 &&
    raw[9] === 0x45 &&
    raw[10] === 0x42 &&
    raw[11] === 0x50
  ) {
    return 'image/webp';
  }

  // BMP: "BM"
  if (raw[0] === 0x42 && raw[1] === 0x4d) {
    return 'image/bmp';
  }

  // HEIC/HEIF: "ftyp" at [4..7], brand at [8..11]
  if (
    raw.length >= 12 &&
    raw[4] === 0x66 &&
    raw[5] === 0x74 &&
    raw[6] === 0x79 &&
    raw[7] === 0x70
  ) {
    const brand = String.fromCharCode(raw[8], raw[9], raw[10], raw[11]);
    if (['heic', 'heix', 'hevc', 'heim', 'heis', 'hevx', 'mif1', 'msf1'].includes(brand)) {
      return 'image/heic';
    }
  }

  return null;
}

/**
 * Resolve the per-image upload size limit for the given provider.
 *
 * Returns `Number.POSITIVE_INFINITY` for unknown providers so callers can
 * safely compare without special-casing the unknown case.
 *
 * @param provider - Provider ID (case-insensitive).
 * @returns Size limit in bytes.
 *
 * @task T9276
 */
export function imageSizeLimitFor(provider: string): number {
  return PROVIDER_IMAGE_SIZE_LIMITS[provider.toLowerCase()] ?? Number.POSITIVE_INFINITY;
}

// ---------------------------------------------------------------------------
// Per-provider image count limits
// ---------------------------------------------------------------------------

/**
 * Maximum number of image blocks allowed per request per provider.
 *
 * The limit is conservative — set to the documented hard limit for each
 * provider. Requests exceeding this count are rejected before the SDK call
 * so we don't waste a round-trip.
 *
 * @task T9296
 */
export const PROVIDER_IMAGE_COUNT_LIMITS: Readonly<Record<string, number>> = Object.freeze({
  anthropic: 20, // Anthropic: up to 20 images per request
  openai: 10, // OpenAI: max 10 per request (vision-capable models)
  gemini: 16, // Gemini 1.5 supports up to 16 images
  google: 16,
  bedrock: 20, // Claude-on-Bedrock mirrors Anthropic
});

/**
 * Maximum image count for a provider.
 *
 * Returns `Number.POSITIVE_INFINITY` for unknown providers.
 *
 * @param provider - Provider ID (case-insensitive).
 * @returns Maximum image count.
 *
 * @task T9296
 */
export function imageCountLimitFor(provider: string): number {
  return PROVIDER_IMAGE_COUNT_LIMITS[provider.toLowerCase()] ?? Number.POSITIVE_INFINITY;
}

// ---------------------------------------------------------------------------
// ImageRoutingError
// ---------------------------------------------------------------------------

/**
 * Thrown by {@link validateImagesForProvider} when the request violates
 * per-provider image constraints.
 *
 * Carries enough context for the caller to log or surface the issue without
 * re-inspecting the request.
 *
 * @task T9296
 */
export class ImageRoutingError extends Error {
  /** Stable LAFS error code. */
  readonly code = 'E_LLM_IMAGE_ROUTING';

  /**
   * @param provider   - Provider that rejected the image set.
   * @param violation  - Human-readable reason.
   * @param imageCount - Number of images in the rejected request.
   * @param sizeLimitBytes - Applicable size limit (may be per-image or total).
   */
  constructor(
    public readonly provider: string,
    public readonly violation: 'image_count_exceeded' | 'image_size_exceeded',
    public readonly imageCount: number,
    public readonly sizeLimitBytes?: number,
  ) {
    super(
      violation === 'image_count_exceeded'
        ? `ImageRoutingError: provider '${provider}' allows at most ${imageCountLimitFor(provider)} images per request (got ${imageCount})`
        : `ImageRoutingError: provider '${provider}' image size exceeds ${(sizeLimitBytes ?? 0) / 1024 / 1024}MB limit`,
    );
    this.name = 'ImageRoutingError';
  }
}

// ---------------------------------------------------------------------------
// validateImagesForProvider
// ---------------------------------------------------------------------------

/**
 * Validate images in a {@link TransportRequest} against the per-provider size
 * and count limits.
 *
 * Walks all messages in the request, counts image blocks, and checks each
 * base64 image's byte-length against the provider's per-image size limit.
 *
 * Throws {@link ImageRoutingError} on violation; returns the request unchanged
 * on success so callers can use it in a fluent pass-through style.
 *
 * URL-sourced images (source.type === 'url') are not size-checked — the
 * provider is responsible for enforcing limits on URLs it fetches.
 *
 * @param request  - Provider-neutral transport request.
 * @param provider - Provider identifier (e.g. `'anthropic'`, `'openai'`).
 * @returns The original request unchanged (convenience pass-through).
 * @throws {ImageRoutingError} When image constraints are violated.
 *
 * @task T9296
 */
export function validateImagesForProvider(
  request: TransportRequest,
  provider: string,
): TransportRequest {
  const sizeLimit = imageSizeLimitFor(provider);
  const countLimit = imageCountLimitFor(provider);

  let totalImageCount = 0;

  for (const message of request.messages) {
    const blocks = extractImageBlocks(message);
    for (const block of blocks) {
      totalImageCount++;

      if (totalImageCount > countLimit) {
        throw new ImageRoutingError(provider, 'image_count_exceeded', totalImageCount);
      }

      // Only size-check base64 images — URL images are checked by the provider.
      if (block.source.type === 'base64') {
        const byteLength = base64ByteLength(block.source.data);
        if (byteLength > sizeLimit) {
          throw new ImageRoutingError(provider, 'image_size_exceeded', totalImageCount, sizeLimit);
        }
      }
    }
  }

  return request;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Extract all image blocks from a single {@link TransportMessage}.
 *
 * Returns an empty array when the message content is a plain string or
 * contains no image blocks.
 *
 * @internal
 */
function extractImageBlocks(message: TransportMessage): readonly TransportImageBlock[] {
  if (typeof message.content === 'string') return [];
  return message.content.filter((block): block is TransportImageBlock => block.type === 'image');
}

/**
 * Estimate the byte length of a base64-encoded string.
 *
 * Formula: `floor(base64.length * 3 / 4)` adjusted for trailing `=` padding.
 * This is an upper-bound estimate — the actual payload may be 1-2 bytes
 * smaller due to `=` padding, but the overestimate is safe for limit checks.
 *
 * @param base64 - Base64-encoded string (may include or omit padding).
 * @returns Estimated byte length.
 *
 * @internal
 */
function base64ByteLength(base64: string): number {
  const len = base64.length;
  if (len === 0) return 0;
  const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0;
  return Math.floor((len * 3) / 4) - padding;
}
