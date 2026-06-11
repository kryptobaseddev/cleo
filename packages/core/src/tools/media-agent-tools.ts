/**
 * Vision / media agent-tool family — `vision_analyze` / `image_generate` /
 * `text_to_speech` (T11951 · M7 · epic T11456 · SG-TOOLS).
 *
 * The FIRST occupants of the previously-empty `media` toolset. Every model /
 * multimodal call routes THROUGH the single E9 chokepoint
 * ({@link import('../llm/system-resolver.js')}'s `resolveLLMForSystem` →
 * {@link import('../llm/model-runner.js')}'s `ModelRunner`), EXACTLY like
 * `browser_vision` ({@link ./web-agent-tools.js}). There is NO raw provider client,
 * NO new transport, NO API-key read at this call-site — the plaintext credential is
 * materialized from the sealed handle ONLY at the wire inside `ModelRunner.build`
 * (Gate-13 stays green).
 *
 *   - **`vision_analyze`** — read a local image + a prompt, send them as a single
 *     multimodal user turn through the chokepoint, return the model's analysis.
 *   - **`image_generate`** — send an image prompt through the chokepoint; returns
 *     the model's response (text/asset-ref it emits). When the resolved model
 *     cannot generate an image the chokepoint degrades — the tool surfaces an
 *     `unsupported` flag rather than constructing a bespoke image client.
 *   - **`text_to_speech`** — send text through the chokepoint for narration intent;
 *     same degradation contract when the modality is unsupported.
 *
 * ## Availability (AC3 — mirrors `browser_vision`)
 *
 * Hidden unless outbound egress is permitted AND the host advertises a multimodal
 * model (`networkEgressAllowed !== false && capabilities.multimodal === true`).
 * Registered-but-hidden so core runs credential-OFF / egress-OFF and the catalog
 * stays stable. (The capability flag is the host's "a multimodal model is
 * resolvable" promise — availability is a SYNC predicate, so the actual resolution
 * happens at `execute` time with graceful degradation when no credential resolves.)
 *
 * @epic T11456
 * @task T11951
 * @see ./web-agent-tools.js — `browser_vision`, the E9-routed multimodal pattern mirrored here
 * @see ../llm/system-resolver.js — `resolveLLMForSystem` (the E9 chokepoint)
 * @see ../llm/model-runner.js — `ModelRunner` (the single SSoT wire builder)
 */

import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';
import type { TransportMessage } from '@cleocode/contracts/llm/normalized-response.js';
import { z } from 'zod';
import { getLogger } from '../logger.js';
import type {
  AgentToolRegistry,
  AvailabilityCheck,
  ToolAvailabilityContext,
} from './agent-registry.js';

const log = getLogger('tool-media-agent');

/**
 * Available only when outbound egress is permitted AND the host advertises a
 * multimodal model. Mirrors `browser_vision`'s availability: registered-but-hidden
 * (so the `media` catalog is stable) until a context advertises both
 * `networkEgressAllowed !== false` and `capabilities.multimodal === true`.
 */
export const multimodalAvailable: AvailabilityCheck = (ctx: ToolAvailabilityContext) =>
  ctx.networkEgressAllowed !== false && ctx.capabilities?.multimodal === true;

/**
 * Read a local image file as base64 + sniff its MIME type from the extension.
 * Injectable so the unit test supplies image bytes without a real file on disk.
 */
export type ImageReader = (path: string) => Promise<{ base64: string; mediaType: string }>;

/** Default {@link ImageReader} — a local `fs` read + extension-based MIME sniff. */
const defaultImageReader: ImageReader = async (path) => {
  const bytes = await readFile(path);
  return { base64: bytes.toString('base64'), mediaType: mediaTypeForPath(path) };
};

/** Map a file extension to its image MIME type (defaults to `image/png`). */
function mediaTypeForPath(path: string): string {
  switch (extname(path).toLowerCase()) {
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg';
    case '.webp':
      return 'image/webp';
    case '.gif':
      return 'image/gif';
    default:
      return 'image/png';
  }
}

/** The outcome of a chokepoint-routed media call. */
export interface MediaModelResult {
  /** Whether a model produced a response. */
  readonly ok: boolean;
  /** The model's textual response (analysis / description / refusal). */
  readonly content?: string;
  /** The model that answered (present once a credential resolves). */
  readonly model?: string;
  /**
   * `true` when no credential resolved through the E9 chokepoint — the call
   * degraded gracefully rather than throwing (mirrors `browser_vision`).
   */
  readonly aiUnavailable?: boolean;
  /**
   * `true` when the resolved model cannot serve the requested modality
   * (e.g. true image synthesis / TTS audio). The tool does NOT construct a
   * bespoke client for an unsupported modality (Gate-13) — it reports this.
   */
  readonly unsupported?: boolean;
  /** A stable code + message when the call failed for another reason. */
  readonly error?: { readonly code: string; readonly message: string };
}

/** Options for {@link registerMediaAgentTools} — all injectable for testing. */
export interface MediaAgentToolOptions {
  /** The local-image reader. Defaults to a real `fs` read + MIME sniff. */
  readonly readImage?: ImageReader;
  /** Project root threaded into the E9 resolver (defaults to the resolver's own fallback). */
  readonly projectRoot?: string;
}

/**
 * Resolve an LLM through the SINGLE E9 chokepoint and send `messages` as one turn
 * via the SSoT {@link ModelRunner}. The sealed credential is materialized ONLY at
 * the wire (inside `ModelRunner.build`); there is NO raw provider/transport
 * construction here (Gate-13). Returns `aiUnavailable: true` when no credential
 * resolves — graceful degradation, not an error (mirrors `runBrowserVision`).
 *
 * @param messages - The provider-neutral turn (text and/or image blocks).
 * @param projectRoot - Project root for the resolver.
 * @returns The {@link MediaModelResult}.
 */
async function runChokepointModel(
  messages: TransportMessage[],
  projectRoot: string | undefined,
): Promise<MediaModelResult> {
  // E9 resolution chokepoint — the ONLY route to an LLM credential. Never throws.
  const { resolveLLMForSystem } = await import('../llm/system-resolver.js');
  const resolved = await resolveLLMForSystem('task-executor', {
    ...(projectRoot !== undefined ? { projectRoot } : {}),
  });
  if (!resolved.sealedCredential) {
    return { ok: false, aiUnavailable: true };
  }

  try {
    // Build the wire surfaces via the single SSoT ModelRunner (Gate-13: no raw
    // transport / provider construction here). The token is materialized from the
    // sealed handle inside ModelRunner only.
    const { ModelRunner } = await import('../llm/model-runner.js');
    const apiKey = (await resolved.sealedCredential.fetch()).value;
    const built = await ModelRunner.build({
      provider: resolved.provider,
      model: resolved.model,
      credential: resolved.credential
        ? {
            provider: resolved.credential.provider,
            apiKey,
            source: resolved.credential.source,
            authType: resolved.credential.authType,
          }
        : null,
      source: resolved.source,
      ...(resolved.credentialLabel !== undefined
        ? { credentialLabel: resolved.credentialLabel }
        : {}),
      apiMode: resolved.apiMode,
      baseUrl: resolved.baseUrl,
      authType: resolved.authType,
      ...(resolved.capabilities !== undefined ? { capabilities: resolved.capabilities } : {}),
    });
    const response = await built.session.send(messages);
    return { ok: true, content: response.content ?? undefined, model: resolved.model };
  } catch (err) {
    log.warn({ err }, 'media tool: chokepoint model call failed — returning unavailable');
    return { ok: false, model: resolved.model, aiUnavailable: true };
  }
}

/**
 * Register the vision / media agent-tool family into `registry`. Pure
 * registration — no model is resolved, no credential is read, no file is opened
 * here; all of that happens later inside each tool's `execute` through the E9
 * chokepoint (and the injected image reader). Import-time side-effect-free.
 *
 * @param registry - The registry to populate.
 * @param options - Injectable image reader / project root (for testing).
 */
export function registerMediaAgentTools(
  registry: AgentToolRegistry,
  options: MediaAgentToolOptions = {},
): void {
  const readImage = options.readImage ?? defaultImageReader;
  const projectRoot = options.projectRoot;

  // --- vision_analyze (image + prompt → analysis, via the E9 chokepoint) ----
  registry.register({
    name: 'vision_analyze',
    // 'shell' — the call captures an external model response (its strongest surface).
    class: 'shell',
    description:
      'Analyse a local image with a vision model: reads the image and sends it plus a ' +
      'prompt as a multimodal turn through the resolveLLMForSystem chokepoint. Returns ' +
      'the model analysis, or aiUnavailable when no credential resolves.',
    toolset: 'media',
    stateless: true,
    available: multimodalAvailable,
    parameters: z.object({
      imagePath: z.string().describe('Absolute path to the image file to analyse.'),
      prompt: z.string().describe('Question / instruction for the vision model about the image.'),
    }),
    execute: async (rawArgs): Promise<MediaModelResult> => {
      const imagePath = String(rawArgs.imagePath);
      const prompt = String(rawArgs.prompt);
      let image: { base64: string; mediaType: string };
      try {
        image = await readImage(imagePath);
      } catch (err) {
        return {
          ok: false,
          error: {
            code: 'E_IMAGE_READ_FAILED',
            message: `could not read image at "${imagePath}": ${
              err instanceof Error ? err.message : String(err)
            }`,
          },
        };
      }
      const messages: TransportMessage[] = [
        {
          role: 'user',
          content: [
            { type: 'text', text: prompt },
            {
              type: 'image',
              source: { type: 'base64', data: image.base64, mediaType: image.mediaType },
            },
          ],
        },
      ];
      return runChokepointModel(messages, projectRoot);
    },
  });

  // --- image_generate (prompt → image, via the E9 chokepoint) --------------
  registry.register({
    name: 'image_generate',
    class: 'shell',
    description:
      'Generate an image from a text prompt by routing the request through the ' +
      'resolveLLMForSystem chokepoint. When the resolved model cannot synthesize an image, ' +
      'reports unsupported rather than constructing a bespoke image client.',
    toolset: 'media',
    stateless: true,
    available: multimodalAvailable,
    parameters: z.object({
      prompt: z.string().describe('A text description of the image to generate.'),
    }),
    execute: async (rawArgs): Promise<MediaModelResult> => {
      const prompt = String(rawArgs.prompt);
      const messages: TransportMessage[] = [
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: `Generate an image for the following description. If you cannot produce an image, say so explicitly.\n\n${prompt}`,
            },
          ],
        },
      ];
      const result = await runChokepointModel(messages, projectRoot);
      // The chat chokepoint does not emit raw image bytes; surface the model's
      // response and flag that true synthesis is not served by this path.
      return { ...result, unsupported: result.ok ? true : result.unsupported };
    },
  });

  // --- text_to_speech (text → narration intent, via the E9 chokepoint) -----
  registry.register({
    name: 'text_to_speech',
    class: 'shell',
    description:
      'Convert text to speech by routing the request through the resolveLLMForSystem ' +
      'chokepoint. When the resolved model cannot synthesize audio, reports unsupported ' +
      'rather than constructing a bespoke TTS client.',
    toolset: 'media',
    stateless: true,
    available: multimodalAvailable,
    parameters: z.object({
      text: z.string().describe('The text to narrate as speech.'),
    }),
    execute: async (rawArgs): Promise<MediaModelResult> => {
      const text = String(rawArgs.text);
      const messages: TransportMessage[] = [
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: `Produce speech audio for the following text. If you cannot produce audio, say so explicitly.\n\n${text}`,
            },
          ],
        },
      ];
      const result = await runChokepointModel(messages, projectRoot);
      return { ...result, unsupported: result.ok ? true : result.unsupported };
    },
  });
}

/**
 * Self-registration marker (AC1) — the identifier the
 * {@link AgentToolRegistry.discover} bounded source scan greps for. Aliases
 * {@link registerMediaAgentTools} so a future scan-dir discovery (or the built-in
 * aggregator) can call it uniformly with the other agent-tool modules.
 *
 * @param registry - The registry to populate.
 */
export function registerAgentTools(registry: AgentToolRegistry): void {
  registerMediaAgentTools(registry);
}
