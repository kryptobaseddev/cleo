/**
 * Interactive System One setup: `cleo decide config` on a TTY, and the
 * `system-one` section of `cleo setup`.
 *
 * Steps: pick the provider (layahost first, recommended) → name the profile
 * (Enter keeps the provider name, T12733) → `jev` only: the URL → the API key through {@link WizardIO.secret} (never echoed) → probe
 * `GET /v1/models` → pick the model (layahost defaults to its routing model)
 * → when another profile is active, whether to make this one active → optionally
 * confirm a one-question smoke test → save (which probes again and re-detects
 * capabilities; other profiles are kept) → run the smoke test through the
 * saved profile when confirmed.
 *
 * All logic lives here; the IO is injected, so tests drive it with a stub and
 * the CLI with readline. Nothing this module returns or prints carries the
 * key: only the masked last-4 preview from the saved summary.
 *
 * @task T12713
 * @task T12733
 * @epic T12486
 */

import type { WizardIO } from '../setup/wizard.js';
import {
  isAllowedDecideBaseUrl,
  isValidDecideProfileName,
  listDecideProfiles,
} from './credentials.js';
import { isValidDecisionModelName, listJevModels } from './jev-wire.js';
import {
  askDecideDebug,
  configureDecide,
  DEFAULT_DECIDE_PROBE_TIMEOUT_MS,
  type DecideAskResult,
  type DecideConfigureResult,
} from './operations.js';
import { type DecisionProviderPreset, listDecisionProviderPresets } from './providers.js';

/** How many times the wizard re-asks for a URL or model name before giving up. */
export const DECIDE_WIZARD_MAX_ATTEMPTS = 3;

/** State the smoke test judges; the question should come back "yes". */
const SMOKE_STATE = 'CLEO setup check: the System One provider was just configured.';
const SMOKE_QUESTION = 'The text says a provider was configured.';

/** Options for {@link runDecideWizard}. */
export interface DecideWizardOptions {
  /** `fetch` for the model probe and the save-time probe; tests inject a stub. */
  readonly fetch?: typeof fetch;
  /** Deadline for each probe, ms. Default {@link DEFAULT_DECIDE_PROBE_TIMEOUT_MS}. */
  readonly timeoutMs?: number;
  /** Smoke-test runner. Default: one `decide ask` through the saved settings. */
  readonly smoke?: () => Promise<DecideAskResult>;
  /** Project root for the smoke test's audit line. Default: the resolved project root. */
  readonly projectRoot?: string;
}

/** Result of {@link runDecideWizard}. Secret-free. */
export interface DecideWizardResult {
  /** Whether settings were saved. */
  readonly configured: boolean;
  /** One-line human summary. */
  readonly summary: string;
  /** The saved settings, when saved. */
  readonly config?: DecideConfigureResult;
  /** The smoke-test answer, when one ran. */
  readonly smoke?: DecideAskResult;
}

/** Ask for a profile name (Enter → `fallback`) until it is valid, or give up. */
async function askProfileName(io: WizardIO, fallback: string): Promise<string | undefined> {
  for (let attempt = 0; attempt < DECIDE_WIZARD_MAX_ATTEMPTS; attempt++) {
    const name = (await io.prompt(`Profile name (Enter for "${fallback}"):`)).trim();
    if (!name) return fallback;
    if (isValidDecideProfileName(name)) return name;
    io.warn(
      'Profile names use 1-32 lowercase letters, digits or -, starting and ending with a letter or digit.',
    );
  }
  return undefined;
}

/**
 * Whether the new profile becomes active: yes for the first profile or one
 * already active; otherwise ask (default no, so adding a second key never
 * silently switches everyday decisions).
 */
async function chooseActivation(io: WizardIO, profile: string): Promise<boolean> {
  const { active } = listDecideProfiles();
  if (active === null || active === profile) return true;
  return io.confirm(
    `Make "${profile}" the active profile for everyday decisions? ("${active}" is active now)`,
    false,
  );
}

/** Ask for a base URL until it is acceptable, or give up. */
async function askBaseUrl(io: WizardIO): Promise<string | undefined> {
  for (let attempt = 0; attempt < DECIDE_WIZARD_MAX_ATTEMPTS; attempt++) {
    const url = (
      await io.prompt('Jev-compatible base URL (e.g. https://provider.example):')
    ).trim();
    if (!url) return undefined;
    if (isAllowedDecideBaseUrl(url)) return url;
    io.warn(
      'That URL is not accepted: use an absolute https:// URL (plain http:// only for localhost, 127.0.0.1 or ::1), without user:pass@.',
    );
  }
  return undefined;
}

/** Ask for a model name until it is valid, or give up. */
async function askModelName(io: WizardIO): Promise<string | undefined> {
  for (let attempt = 0; attempt < DECIDE_WIZARD_MAX_ATTEMPTS; attempt++) {
    const model = (await io.prompt('Model name (the provider listed none):')).trim();
    if (!model) return undefined;
    if (isValidDecisionModelName(model)) return model;
    io.warn('Model names may contain only letters, digits and . _ : / @ - (1-128 characters).');
  }
  return undefined;
}

/**
 * Choose the model: the preset default first (layahost), then the listed
 * models in the provider's order. With one candidate there is nothing to ask.
 */
async function chooseModel(
  io: WizardIO,
  preset: DecisionProviderPreset,
  listed: readonly string[],
): Promise<string | undefined> {
  const fallback = preset.defaultModel;
  const candidates = fallback ? [fallback, ...listed.filter((m) => m !== fallback)] : [...listed];
  if (candidates.length === 0) return askModelName(io);
  if (candidates.length === 1) {
    io.info(`Model: ${candidates[0]}`);
    return candidates[0];
  }
  const question = fallback
    ? `Which model? (${fallback} is the recommended default)`
    : 'Which model?';
  return io.select(question, candidates);
}

/**
 * Run the interactive System One setup.
 *
 * @param io - Prompt surface. The key is read with {@link WizardIO.secret}.
 * @param opts - Injectable `fetch`, deadline and smoke runner.
 * @returns Whether settings were saved, a summary and the secret-free results.
 * @throws {DecideCredentialsError} Only when the save itself rejects the settings.
 */
export async function runDecideWizard(
  io: WizardIO,
  opts: DecideWizardOptions = {},
): Promise<DecideWizardResult> {
  const presets = listDecisionProviderPresets();
  const picked = await io.select(
    'Which System One provider?',
    presets.map((p) => p.label),
  );
  const preset = presets.find((p) => p.label === picked) ?? presets[0];
  if (!preset) return { configured: false, summary: 'skipped (no provider presets)' };

  const profile = await askProfileName(io, preset.kind);
  if (!profile) {
    io.warn('No valid profile name entered; System One left unchanged.');
    return { configured: false, summary: 'skipped (no valid profile name)' };
  }

  let baseUrl = preset.defaultBaseUrl;
  if (preset.requiresUrl || !baseUrl) {
    baseUrl = await askBaseUrl(io);
    if (!baseUrl) {
      io.warn('No valid URL entered; System One left unchanged.');
      return { configured: false, summary: 'skipped (no valid URL)' };
    }
  }

  const apiKey = (await io.secret(`${preset.kind} API key (input hidden):`)).trim();
  if (!apiKey) {
    io.warn('No API key entered; System One left unchanged.');
    return { configured: false, summary: 'skipped (empty api key)' };
  }

  const timeoutMs = opts.timeoutMs ?? DEFAULT_DECIDE_PROBE_TIMEOUT_MS;
  let listed: string[] = [];
  try {
    listed = await listJevModels({ baseUrl, apiKey }, AbortSignal.timeout(timeoutMs), {
      fetch: opts.fetch,
    });
    io.info(`Reached ${baseUrl}: ${listed.length} model(s) listed.`);
  } catch (err) {
    io.warn(
      `Could not list models at ${baseUrl}: ${err instanceof Error ? err.message : 'probe failed'}`,
    );
    if (!(await io.confirm('Save these settings anyway?', false))) {
      return { configured: false, summary: 'cancelled (provider probe failed)' };
    }
  }

  const model = await chooseModel(io, preset, listed);
  if (!model) {
    io.warn(
      'No model chosen; System One left unchanged (the provider rejects requests without one).',
    );
    return { configured: false, summary: 'skipped (no model)' };
  }

  const activate = await chooseActivation(io, profile);
  const wantsSmoke = await io.confirm(
    'After saving, ask one test question to confirm it works? (one billed decision)',
    true,
  );

  const config = await configureDecide({
    provider: preset.kind,
    baseUrl,
    apiKey,
    model,
    profile,
    activate,
    fetch: opts.fetch,
    timeoutMs,
  });
  const role = config.active ? 'active' : `inactive; switch with: cleo decide use ${profile}`;
  io.info(
    `Saved profile ${profile} (${preset.kind} at ${config.baseUrl ?? baseUrl}, ${role}): model ${config.model ?? 'none'}, key ${config.keyPreview ?? '…'} (${config.providerState}).`,
  );
  if (config.warning) io.warn(config.warning);

  const summary = `${profile} (${preset.kind}) configured${config.active ? ' and active' : ''} (model ${config.model ?? 'none'}, ${config.providerState})`;
  if (!wantsSmoke) return { configured: true, summary, config };

  const smoke = await (
    opts.smoke ??
    (() =>
      askDecideDebug({
        state: SMOKE_STATE,
        question: SMOKE_QUESTION,
        profile,
        ...(opts.projectRoot ? { projectRoot: opts.projectRoot } : {}),
      }))
  )();
  if (smoke.source === 'provider') {
    io.info(`Smoke test answered by the provider in ${smoke.latencyMs} ms.`);
  } else {
    io.warn(
      `Smoke test fell back to the heuristic (${smoke.fallbackReason ?? smoke.source}). Check \`cleo decide status\`.`,
    );
  }
  return { configured: true, summary, config, smoke };
}
