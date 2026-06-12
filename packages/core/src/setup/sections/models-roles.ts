/**
 * `models-roles` setup wizard section (T11726 · M3).
 *
 * Sits immediately after the `llm` section in the canonical order. Where `llm`
 * lands a credential in the pool, this section binds WHAT to use:
 *
 *   1. **default model** — pick the global default model (`cleo llm use`
 *      equivalent → `llm.default.model`), sourcing choices from the live
 *      models.dev catalog for the default provider.
 *   2. **per-role profiles** — optionally pin each role in the canonical
 *      {@link WHOAMI_ROLE_IDS} set to a provider/model (`cleo llm profile`
 *      equivalent → `llm.roles.<role>`).
 *
 * ## Non-interactive contract (AC3)
 *
 * Driveable entirely from {@link WizardOptions}:
 *   - `options.defaultModel` → write the global default model.
 *   - `options.roleBindings[role]` → write `llm.roles.<role>` for each entry.
 * Missing inputs short-circuit cleanly with `changed: false` (never a throw,
 * never a half-written binding).
 *
 * ## Idempotency (AC4)
 *
 * `isConfigured()` returns `true` when a default model OR any role binding is
 * already present in the global config, so the wizard skips the section unless
 * `--reset` is passed.
 *
 * @module setup/sections/models-roles
 * @task T11726
 * @epic T11671 (E6-ONBOARDING-FRONT-DOOR)
 */

import type { RoleName } from '@cleocode/contracts';
import { WHOAMI_ROLE_IDS } from '@cleocode/contracts';
import { loadConfig, setConfigValue } from '../../config.js';
import {
  catalogKeyForProvider,
  listProviderModels,
  resolveProviderDefaultModel,
} from '../../llm/catalog-model-resolver.js';
import type { LocalModelFitEnvelope } from '../../llm/local-model-fit.js';
import { LOCAL_FIT_FLOOR_GB } from '../../llm/local-model-fit.js';
import type { WizardIO, WizardOptions, WizardSectionRunner } from '../wizard.js';

/**
 * Sentinel option offered in interactive pickers meaning "leave this unset".
 *
 * @internal
 */
const SKIP_CHOICE = '(skip)';

/**
 * Read the current global LLM config block (best-effort — returns `{}` on any
 * read error so the section degrades gracefully on a fresh install).
 *
 * @internal
 */
async function readLlmConfig(): Promise<{
  defaultProvider?: string;
  defaultModel?: string;
  roles?: Record<string, unknown>;
}> {
  try {
    const cfg = await loadConfig();
    const llm = cfg.llm;
    const def = llm?.default;
    return {
      defaultProvider: def?.provider,
      defaultModel: def?.model,
      roles: (llm?.roles as Record<string, unknown> | undefined) ?? {},
    };
  } catch {
    return {};
  }
}

/**
 * Build the model choice list for a provider from the catalog, capped for a
 * scannable menu. Always includes the {@link SKIP_CHOICE} sentinel last.
 *
 * @internal
 */
function modelChoicesForProvider(provider: string): string[] {
  const key = catalogKeyForProvider(provider);
  const models = listProviderModels(key);
  return [...models, SKIP_CHOICE];
}

/**
 * Build the `models-roles` section runner (T11726).
 *
 * @returns A {@link WizardSectionRunner} for the models/roles section.
 * @task T11726
 */
export function createModelsRolesSection(): WizardSectionRunner {
  return {
    section: 'models-roles',
    title: 'Default model + per-role profiles',
    optional: true,

    /**
     * Already configured when a default model or any role binding exists (AC4).
     */
    async isConfigured(_options: WizardOptions): Promise<boolean> {
      const cfg = await readLlmConfig();
      const hasDefaultModel = typeof cfg.defaultModel === 'string' && cfg.defaultModel !== '';
      const hasRole = Boolean(cfg.roles && Object.keys(cfg.roles).length > 0);
      return hasDefaultModel || hasRole;
    },

    async run(io: WizardIO, options: WizardOptions) {
      io.info(
        'Selects the default model (cleo llm use) and optional per-role profiles (cleo llm profile).\n' +
          'Model choices come from the cached models.dev catalog — run `cleo llm refresh-catalog` to update it.',
      );

      const cfg = await readLlmConfig();
      const defaultProvider = options.provider ?? cfg.defaultProvider;
      const changes: string[] = [];

      // --- Non-interactive path (AC3) -------------------------------------
      if (options.nonInteractive === true) {
        // Default model.
        if (options.defaultModel) {
          await setConfigValue('llm.default.model', options.defaultModel, undefined, {
            global: true,
          });
          if (defaultProvider) {
            await setConfigValue('llm.default.provider', defaultProvider, undefined, {
              global: true,
            });
          }
          changes.push(`default model → ${options.defaultModel}`);
        }
        // Per-role bindings. A provider-only entry is completed with the
        // provider's catalog-default model: the role resolver's tier-2 check
        // requires BOTH provider AND model (`role-resolver.ts` tier 2), so a
        // model-less binding would be dead config that the resolver silently
        // falls through — while isConfigured() starts skipping the section
        // (T11725 takeover review).
        for (const [role, binding] of Object.entries(options.roleBindings ?? {})) {
          if (!isWhoamiRole(role)) continue;
          let model = binding.model;
          if (!model) {
            model =
              resolveProviderDefaultModel(catalogKeyForProvider(binding.provider)) ?? undefined;
          }
          if (!model) {
            io.warn(
              `Skipping role binding ${role} → ${binding.provider}: no model supplied and ` +
                `no catalog default found for '${binding.provider}'. ` +
                `Re-run with {"${role}": {"provider": "${binding.provider}", "model": "<id>"}}.`,
            );
            continue;
          }
          await writeRoleBinding(role, { ...binding, model });
          changes.push(`${role} → ${binding.provider}/${model}`);
        }
        if (changes.length === 0) {
          return {
            changed: false,
            summary: 'skipped (non-interactive: no --default-model / role bindings supplied)',
          };
        }
        return { changed: true, summary: changes.join('; ') };
      }

      // --- Interactive path -----------------------------------------------
      if (!defaultProvider) {
        io.info(
          'No default provider configured yet — run the LLM section (or `cleo login`) first, ' +
            'then re-run setup to pin models/roles.',
        );
        return { changed: false, summary: 'skipped (no provider configured)' };
      }

      // 1. Default model selection.
      // For local (ollama) providers: use fit-gated recommendations (T11983 AC).
      // RECOMMEND-NEVER-KILL: never auto-pull, never auto-select; present ranked
      // options from `rankLocalModelFit`; machines below the 4 GB floor get
      // cloud-only guidance.
      if (defaultProvider === 'ollama') {
        const modelPicked = await _pickOllamaModelInteractive(io);
        if (modelPicked) {
          await setConfigValue('llm.default.model', modelPicked, undefined, { global: true });
          await setConfigValue('llm.default.provider', 'ollama', undefined, { global: true });
          changes.push(`default model → ${modelPicked}`);
        }
      } else {
        const modelChoices = modelChoicesForProvider(defaultProvider);
        if (modelChoices.length > 1) {
          const picked = await io.select(
            `Default model for ${defaultProvider}?`,
            modelChoices as readonly string[],
          );
          if (picked !== SKIP_CHOICE) {
            await setConfigValue('llm.default.model', picked, undefined, { global: true });
            await setConfigValue('llm.default.provider', defaultProvider, undefined, {
              global: true,
            });
            changes.push(`default model → ${picked}`);
          }
        } else {
          // Catalog empty — fall back to the resolver's latest, or a free prompt.
          const latest = resolveProviderDefaultModel(catalogKeyForProvider(defaultProvider));
          const typed = (
            await io.prompt(
              `Default model for ${defaultProvider}${latest ? ` [${latest}]` : ''} (blank to skip):`,
            )
          ).trim();
          const model = typed || latest || '';
          if (model) {
            await setConfigValue('llm.default.model', model, undefined, { global: true });
            await setConfigValue('llm.default.provider', defaultProvider, undefined, {
              global: true,
            });
            changes.push(`default model → ${model}`);
          }
        }
      }

      // 2. Optional per-role profiles.
      const pinRoles = await io.confirm('Pin per-role profiles now? (advanced)', false);
      if (pinRoles) {
        for (const role of WHOAMI_ROLE_IDS) {
          const choices = modelChoicesForProvider(defaultProvider);
          const picked = await io.select(
            `Model for role '${role}' on ${defaultProvider}?`,
            choices as readonly string[],
          );
          if (picked !== SKIP_CHOICE) {
            await writeRoleBinding(role, { provider: defaultProvider, model: picked });
            changes.push(`${role} → ${defaultProvider}/${picked}`);
          }
        }
      }

      if (changes.length === 0) {
        return { changed: false, summary: 'no models/roles changes' };
      }
      return { changed: true, summary: changes.join('; ') };
    },
  };
}

/**
 * Narrow an arbitrary string to a {@link RoleName} in the whoami-enumerable set.
 *
 * @internal
 */
function isWhoamiRole(role: string): role is RoleName {
  return (WHOAMI_ROLE_IDS as readonly string[]).includes(role);
}

/**
 * Write a per-role binding (`llm.roles.<role>.{provider,model,credentialLabel}`)
 * to the global config.
 *
 * @internal
 */
async function writeRoleBinding(
  role: RoleName,
  binding: { provider: string; model?: string; credentialLabel?: string },
): Promise<void> {
  await setConfigValue(`llm.roles.${role}.provider`, binding.provider, undefined, { global: true });
  if (binding.model) {
    await setConfigValue(`llm.roles.${role}.model`, binding.model, undefined, { global: true });
  }
  if (binding.credentialLabel) {
    await setConfigValue(`llm.roles.${role}.credentialLabel`, binding.credentialLabel, undefined, {
      global: true,
    });
  }
}

// ---------------------------------------------------------------------------
// Fit-gated local (Ollama) model picker (T11983 AC)
// ---------------------------------------------------------------------------

/**
 * Injectable dependency for the Ollama model picker — lets tests stub out
 * `rankLocalModelFit` without reaching into the real OS/network layer.
 *
 * @internal
 */
export type LocalModelFitRanker = () => Promise<LocalModelFitEnvelope>;

/**
 * The default ranker used in production: calls the real `rankLocalModelFit`.
 *
 * Lazy import keeps this module free of heavy OS-level side effects at parse
 * time (Gate-13 compliance: no transport construction at import).
 *
 * @internal
 */
async function defaultLocalModelFitRanker(): Promise<LocalModelFitEnvelope> {
  const { rankLocalModelFit } = await import('../../llm/local-model-fit.js');
  return rankLocalModelFit();
}

/**
 * Interactive Ollama model picker driven by fit-gated recommendations (T11983).
 *
 * Behaviour:
 * - Calls `rankLocalModelFit` to detect hardware + Ollama state.
 * - Below the 4 GB floor → informs the user (cloud-only guidance) and returns
 *   `null` (caller skips the binding).
 * - Above the floor with recommendations → presents a ranked pick list of
 *   2–3 candidates (never auto-selects, never auto-pulls — RECOMMEND-NEVER-KILL).
 * - Already-pulled models are surfaced first with a `[pulled]` tag.
 * - Free-text fallback offered as the last option so the user can type any tag.
 * - Returns the chosen model tag, or `null` if the user skipped.
 *
 * The ranker is injectable so tests can supply a stub envelope without
 * hitting the OS or network.
 *
 * @param io - Wizard I/O surface.
 * @param ranker - Override the fit ranker for tests (defaults to the real one).
 * @returns The chosen Ollama model tag, or `null` when the user skipped / below floor.
 *
 * @task T11983
 */
export async function _pickOllamaModelInteractive(
  io: WizardIO,
  ranker: LocalModelFitRanker = defaultLocalModelFitRanker,
): Promise<string | null> {
  io.info('Detecting local hardware for Ollama model fit ranking…');

  let fitEnvelope: LocalModelFitEnvelope;
  try {
    fitEnvelope = await ranker();
  } catch (err) {
    io.warn(
      `Hardware detection failed: ${err instanceof Error ? err.message : String(err)}. ` +
        'Falling back to manual model entry.',
    );
    const typed = (
      await io.prompt('Enter Ollama model tag (e.g. gemma4:e2b) or blank to skip:')
    ).trim();
    return typed || null;
  }

  const hw = fitEnvelope.hardware;
  io.info(
    `  Hardware: ${hw.totalRamGb.toFixed(1)} GB RAM, ` +
      (hw.vramTotalGb !== null ? `${hw.vramTotalGb.toFixed(1)} GB VRAM` : 'no GPU detected') +
      (fitEnvelope.ollamaRunning ? ', Ollama running' : ', Ollama not running'),
  );

  // Below floor: guide to cloud-only.
  if (fitEnvelope.noRecommendationReason) {
    io.warn(
      `\nLocal model recommendation not available: ${fitEnvelope.noRecommendationReason}\n` +
        `This machine has ${hw.totalRamGb.toFixed(1)} GB RAM — local LLM inference requires at least ${LOCAL_FIT_FLOOR_GB} GB.\n` +
        'Please use a cloud provider (anthropic, openai, gemini, etc.) instead.',
    );
    return null;
  }

  // Build choice list from fit recommendations.
  const recs = fitEnvelope.recommendations;
  if (recs.length === 0) {
    io.warn('No local model candidates fit this machine. Consider a cloud provider.');
    const typed = (await io.prompt('Enter Ollama model tag manually (blank to skip):')).trim();
    return typed || null;
  }

  io.info('\nRecommended local models (ranked by hardware fit):');
  const choices: string[] = recs.map((r) => {
    const tag = r.candidate.modelTag;
    const pulled = r.alreadyPulled ? ' [pulled]' : '';
    return `${tag}${pulled} (${r.fitTier})`;
  });
  // Always offer a manual-entry option so the user is never locked in.
  choices.push('(enter manually)');
  choices.push(SKIP_CHOICE);

  const picked = await io.select('Choose a local model for Ollama:', choices as readonly string[]);

  if (picked === SKIP_CHOICE) return null;

  if (picked === '(enter manually)') {
    const typed = (await io.prompt('Enter Ollama model tag (e.g. gemma4:e2b):')).trim();
    return typed || null;
  }

  // Strip the suffix annotation to get the raw model tag.
  const rawTag = picked.split(' ')[0] ?? picked;
  return rawTag;
}
