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
        // Per-role bindings.
        for (const [role, binding] of Object.entries(options.roleBindings ?? {})) {
          if (!isWhoamiRole(role)) continue;
          await writeRoleBinding(role, binding);
          changes.push(`${role} → ${binding.provider}/${binding.model ?? '(default)'}`);
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
