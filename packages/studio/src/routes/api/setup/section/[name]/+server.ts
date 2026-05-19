/**
 * POST /api/setup/section/:name — run a single wizard section.
 *
 * Bridges the Studio `/setup` UI to the canonical {@link WizardSectionRunner}
 * pipeline shipped from `@cleocode/core/setup`. The browser supplies a
 * single JSON payload describing how the section should behave; the
 * server constructs a {@link WizardOptions} bag plus a queue-backed
 * `WizardIO` and invokes the matching section runner from
 * {@link createBuiltinSections}.
 *
 * Request body:
 * ```
 * {
 *   nonInteractive?: boolean,
 *   provider?: string, apiKey?: string, label?: string,
 *   agentName?: string, soulMdContent?: string,
 *   sentientEnabled?: boolean, tier2Enabled?: boolean,
 *   strictness?: 'strict' | 'standard' | 'minimal',
 *   harness?: 'pi' | 'claude-code',
 *   brainBridgeMode?: 'digest' | 'file' | 'disabled',
 *   brainRetentionDays?: number,
 *   brainEmbeddingEnabled?: boolean,
 *   signaldockEnabled?: boolean,
 *   signaldockEndpoint?: string,
 *   studioEnabled?: boolean,
 *   conduitPath?: string,
 *   poolSeedingConsent?: boolean,
 *   acEnforcementMode?: 'block' | 'warn' | 'off',
 *   sessionAutoStart?: boolean,
 *   signaldockAutoConnect?: boolean,
 *   projectRoot?: string,
 * }
 * ```
 *
 * Response (LAFS):
 * ```
 * { success: true, data: { section, success, changes, summary } }
 * ```
 *
 *   - `section`   — echoed section id so the client can correlate
 *   - `success`   — `true` when the runner returned without surfacing
 *                   any `io.error()` lines (i.e. no recoverable failure)
 *   - `changes`   — `result.changed` from the section runner
 *   - `summary`   — `result.summary` line from the section runner
 *
 * The endpoint is intentionally write-only against the section: it never
 * echoes back secret material, never returns the request payload, and
 * never reads credentials. The `/keys` route remains the single read
 * surface for credential listings.
 *
 * SECURITY: the LLM section route is bypassed by the Studio UI in favour
 * of POST /api/credentials directly (T9426) so that the only place the
 * API key crosses the wire is the dedicated credential endpoint. This
 * handler still supports `llm` for parity with `cleo setup --section llm`
 * but the API key, when supplied, is forwarded straight to the wizard
 * section which routes it through `addCredential` — same persistence
 * path as POST /api/credentials.
 *
 * @task T9427
 * @epic E-CONFIG-AUTH-UNIFY (E3 §5.3 T-E3-8)
 */

import {
  createBuiltinSections,
  type WizardIO,
  type WizardOptions,
  WizardRunner,
  type WizardSection,
} from '@cleocode/core/setup/index.js';
import { json } from '@sveltejs/kit';
import { err, isParseError, ok, parseJsonBody } from '../../../memory/_lafs.js';
import type { RequestHandler } from './$types';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * POST response payload.
 *
 * @task T9427
 */
export interface RunSectionData {
  /** Echoed wizard-section id (`'llm'`, `'project-conventions'`, …). */
  section: WizardSection;
  /** `true` when the section completed without surfacing an `io.error()`. */
  success: boolean;
  /** Mirrors {@link WizardSectionResult.changed}. */
  changes: boolean;
  /** Mirrors {@link WizardSectionResult.summary}. */
  summary: string;
}

// ---------------------------------------------------------------------------
// Allowed section ids — keep aligned with `WizardSection` union.
// ---------------------------------------------------------------------------

const ALLOWED_SECTIONS: ReadonlySet<WizardSection> = new Set<WizardSection>([
  'llm',
  'identity',
  'harness',
  'sentient',
  'project-conventions',
  'brain',
  'integrations',
  'verification',
]);

// ---------------------------------------------------------------------------
// Server-side WizardIO
// ---------------------------------------------------------------------------

/**
 * Headless {@link WizardIO} implementation for the HTTP path.
 *
 * The Studio `/setup` flow operates in **non-interactive** mode: every
 * answer the section needs is supplied up-front via `WizardOptions`.
 * If a section nevertheless asks a question (an unforeseen path),
 * `prompt`/`confirm`/`select` throw so the failure surfaces as a
 * deterministic 500 instead of hanging.
 *
 * `info` / `warn` / `error` messages are captured so the response
 * `success` field can flip to `false` when the section surfaced a
 * recoverable error via `io.error()`.
 *
 * @internal
 */
class HttpWizardIO implements WizardIO {
  /** Captured info/warn/error lines, in emission order. */
  readonly errors: string[] = [];
  readonly warns: string[] = [];

  async prompt(question: string): Promise<string> {
    throw new Error(
      `HttpWizardIO: section attempted an interactive prompt ('${question}') ` +
        `but the Studio /setup flow only supports non-interactive section runs. ` +
        `Pass the required field via the POST body.`,
    );
  }

  async confirm(question: string): Promise<boolean> {
    throw new Error(
      `HttpWizardIO: section attempted an interactive confirm ('${question}') ` +
        `but the Studio /setup flow only supports non-interactive section runs.`,
    );
  }

  async select<T extends string>(question: string): Promise<T> {
    throw new Error(
      `HttpWizardIO: section attempted an interactive select ('${question}') ` +
        `but the Studio /setup flow only supports non-interactive section runs.`,
    );
  }

  info(_message: string): void {
    // Section info lines are deliberately not echoed back — they are
    // CLI-shaped and would leak noise into the JSON response. The
    // Studio UI renders its own copy via the `summary` field.
  }

  warn(message: string): void {
    this.warns.push(message);
  }

  error(message: string): void {
    this.errors.push(message);
  }
}

// ---------------------------------------------------------------------------
// Body parsing
// ---------------------------------------------------------------------------

/**
 * Narrow a parsed JSON body into a {@link WizardOptions} bag.
 *
 * Each field is pulled defensively — unknown types collapse to
 * `undefined` rather than propagating to the section. The wizard
 * sections themselves enforce that their required inputs are present
 * (e.g. `llm` requires `provider` + `apiKey`).
 *
 * @internal
 */
function buildOptions(body: Record<string, unknown>): WizardOptions {
  const options: WizardOptions = {};

  if (body['nonInteractive'] !== false) {
    // Default to non-interactive — the HTTP surface has no way to
    // resolve prompts. Callers may explicitly opt out only for tests.
    options.nonInteractive = true;
  } else {
    options.nonInteractive = false;
  }

  if (typeof body['provider'] === 'string') options.provider = body['provider'];
  if (typeof body['apiKey'] === 'string') options.apiKey = body['apiKey'];
  if (typeof body['label'] === 'string') options.label = body['label'];
  if (typeof body['agentName'] === 'string') options.agentName = body['agentName'];
  if (typeof body['soulMdContent'] === 'string') options.soulMdContent = body['soulMdContent'];
  if (typeof body['sentientEnabled'] === 'boolean')
    options.sentientEnabled = body['sentientEnabled'];
  if (typeof body['tier2Enabled'] === 'boolean') options.tier2Enabled = body['tier2Enabled'];

  const strictness = body['strictness'];
  if (strictness === 'strict' || strictness === 'standard' || strictness === 'minimal') {
    options.strictness = strictness;
  }

  const harness = body['harness'];
  if (harness === 'pi' || harness === 'claude-code') {
    options.harness = harness;
  }

  const bridgeMode = body['brainBridgeMode'];
  if (bridgeMode === 'digest' || bridgeMode === 'file' || bridgeMode === 'disabled') {
    options.brainBridgeMode = bridgeMode;
  }

  if (typeof body['projectRoot'] === 'string') options.projectRoot = body['projectRoot'];

  // --- V2 fields (E-CLEO-SETUP-V2 §3.2 / T9614) ---

  if (typeof body['brainRetentionDays'] === 'number')
    options.brainRetentionDays = body['brainRetentionDays'];
  if (typeof body['brainEmbeddingEnabled'] === 'boolean')
    options.brainEmbeddingEnabled = body['brainEmbeddingEnabled'];
  if (typeof body['signaldockEnabled'] === 'boolean')
    options.signaldockEnabled = body['signaldockEnabled'];
  if (typeof body['signaldockEndpoint'] === 'string')
    options.signaldockEndpoint = body['signaldockEndpoint'];
  if (typeof body['studioEnabled'] === 'boolean') options.studioEnabled = body['studioEnabled'];
  if (typeof body['conduitPath'] === 'string') options.conduitPath = body['conduitPath'];
  if (typeof body['poolSeedingConsent'] === 'boolean')
    options.poolSeedingConsent = body['poolSeedingConsent'];
  if (typeof body['signaldockAutoConnect'] === 'boolean')
    options.signaldockAutoConnect = body['signaldockAutoConnect'];

  const acMode = body['acEnforcementMode'];
  if (acMode === 'block' || acMode === 'warn' || acMode === 'off') {
    options.acEnforcementMode = acMode;
  }

  if (typeof body['sessionAutoStart'] === 'boolean')
    options.sessionAutoStart = body['sessionAutoStart'];

  return options;
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

/**
 * POST /api/setup/section/:name — run the named wizard section.
 *
 * @task T9427
 */
export const POST: RequestHandler = async ({ request, params }) => {
  const name = params.name;
  if (!name || typeof name !== 'string' || !ALLOWED_SECTIONS.has(name as WizardSection)) {
    return json(
      err(
        'E_VALIDATION',
        `Unknown wizard section '${String(name)}'. ` +
          `Allowed: ${Array.from(ALLOWED_SECTIONS).join(', ')}.`,
      ),
      { status: 400 },
    );
  }
  const section = name as WizardSection;

  const body = await parseJsonBody(request);
  if (isParseError(body)) {
    return json(err('E_VALIDATION', body._parseError), { status: 400 });
  }

  const options = buildOptions(body);
  const io = new HttpWizardIO();

  try {
    const runner = new WizardRunner(createBuiltinSections());
    const result = await runner.runSection(section, io, options);
    return json(
      ok<RunSectionData>({
        section,
        success: io.errors.length === 0,
        changes: result.changed,
        summary: result.summary,
      }),
    );
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return json(err('E_SECTION_FAILED', `Section '${section}' failed: ${message}`), {
      status: 500,
    });
  }
};
