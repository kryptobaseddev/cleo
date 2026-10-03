/**
 * Heavy-command hook delivery for `cleo init`, `cleo upgrade`, `cleo doctor`
 * and the session briefing (T13124).
 *
 * The hook (`cleo hook heavy-command`, T12983) routes agent-run tests, builds
 * and typechecks through `cleo run`, the machine-wide ResourceGovernor. It only
 * helps where it is installed. init/upgrade used to install it through
 * `AdapterManager`, whose discovery finds no adapter in any project, and a
 * try/catch swallowed every failure, so on 2026-10-03 it was installed nowhere.
 * Delivery is now its own step, with one outcome per provider in the report,
 * and `cleo doctor` plus the briefing say when a provider in use lacks it.
 *
 * The per-provider installers live in `@cleocode/adapters` (provider delivery).
 * That package builds on this one, so it is loaded at run time through its
 * light `@cleocode/adapters/heavy-command-hook` entry point and validated
 * against the {@link HeavyHookDeliveryApi} contract.
 *
 * @module resources/heavy-command-hook-delivery
 * @task T13124
 * @epic T13121
 */

import type {
  HeavyCommandHookMode,
  HeavyHookCliProbe,
  HeavyHookDeliveryApi,
  HeavyHookDeliveryOptions,
  HeavyHookDeliveryOutcome,
  HeavyHookInspection,
} from '@cleocode/contracts';
import { configuredHeavyHookMode, resolveHeavyHookMode } from './heavy-command.js';

/** The adapters entry point that carries the delivery functions. */
export const HEAVY_HOOK_DELIVERY_MODULE = '@cleocode/adapters/heavy-command-hook';

/** The command that installs or refreshes only this hook. */
export const HEAVY_HOOK_FIX = 'cleo doctor heavy-command-hook --fix';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** Whether a loaded module export implements {@link HeavyHookDeliveryApi}. */
function isDeliveryApi(value: unknown): value is HeavyHookDeliveryApi {
  return (
    isRecord(value) &&
    typeof value.syncProjectHeavyCommandHooks === 'function' &&
    typeof value.inspectProjectHeavyCommandHooks === 'function' &&
    typeof value.probeHeavyHookCli === 'function'
  );
}

/**
 * Load the delivery functions from `@cleocode/adapters`. The specifier is held
 * in a variable so TypeScript does not resolve it at build time (adapters
 * references core, so a static import would be a build cycle).
 *
 * @returns the delivery API.
 * @throws when the module is missing or does not export the API.
 */
export async function loadHeavyHookDelivery(): Promise<HeavyHookDeliveryApi> {
  const specifier = HEAVY_HOOK_DELIVERY_MODULE;
  const mod: unknown = await import(specifier);
  const api = isRecord(mod) ? mod.heavyHookDeliveryApi : undefined;
  if (!isDeliveryApi(api)) {
    // @sync-invariant none:local-only a broken install of the adapters package; writes project config files, never a synced row
    throw new Error(`${specifier} does not export heavyHookDeliveryApi`);
  }
  return api;
}

/**
 * The hook mode init/upgrade install from: `resources.heavyCommandHook`
 * (default `rewrite`). The `CLEO_HEAVY_COMMAND_HOOK` environment variable
 * switches the hook at run time only and does not change what is installed.
 *
 * @param projectRoot - the project whose config to read.
 */
export async function installedHeavyHookMode(projectRoot: string): Promise<HeavyCommandHookMode> {
  return resolveHeavyHookMode(undefined, await configuredHeavyHookMode(projectRoot));
}

/** What {@link deliverHeavyCommandHooks} did. */
export interface HeavyHookDeliveryReport {
  /** The mode installed from. */
  readonly mode: HeavyCommandHookMode;
  /** One outcome per provider. */
  readonly outcomes: readonly HeavyHookDeliveryOutcome[];
}

/**
 * Install, refresh or remove the hook for every provider in use in the project.
 *
 * @param projectRoot - the project root.
 * @param options - environment and provider list (tests); `api` replaces the
 *   run-time loaded adapters module.
 * @returns the mode and each provider's outcome.
 * @throws only when the adapters module cannot be loaded.
 */
export async function deliverHeavyCommandHooks(
  projectRoot: string,
  options: HeavyHookDeliveryOptions & { readonly api?: HeavyHookDeliveryApi } = {},
): Promise<HeavyHookDeliveryReport> {
  const { api: injected, ...delivery } = options;
  const api = injected ?? (await loadHeavyHookDelivery());
  const mode = await installedHeavyHookMode(projectRoot);
  const outcomes = await api.syncProjectHeavyCommandHooks(projectRoot, mode, delivery);
  return { mode, outcomes };
}

/** What {@link inspectHeavyCommandHooks} found. */
export interface HeavyHookInspectionReport {
  /** The configured mode. */
  readonly mode: HeavyCommandHookMode;
  /** One inspection per provider. */
  readonly inspections: readonly HeavyHookInspection[];
}

/**
 * Read-only: the hook's state for every provider in the project.
 *
 * @param projectRoot - the project root.
 * @param options - environment and provider list (tests); `api` replaces the
 *   run-time loaded adapters module.
 * @returns the mode and each provider's state.
 * @throws only when the adapters module cannot be loaded.
 */
export async function inspectHeavyCommandHooks(
  projectRoot: string,
  options: HeavyHookDeliveryOptions & { readonly api?: HeavyHookDeliveryApi } = {},
): Promise<HeavyHookInspectionReport> {
  const { api: injected, ...delivery } = options;
  const api = injected ?? (await loadHeavyHookDelivery());
  const mode = await installedHeavyHookMode(projectRoot);
  return { mode, inspections: api.inspectProjectHeavyCommandHooks(projectRoot, mode, delivery) };
}

/**
 * Whether the `cleo` on PATH, as the hook resolves it from the project, can
 * answer the hook (an installed hook in front of an older CLEO governs
 * nothing). Starts that `cleo` once.
 *
 * @param projectRoot - the project root.
 * @param options - environment (tests); `api` replaces the run-time loaded
 *   adapters module.
 * @throws only when the adapters module cannot be loaded.
 */
export async function probeHeavyHookCliFor(
  projectRoot: string,
  options: HeavyHookDeliveryOptions & { readonly api?: HeavyHookDeliveryApi } = {},
): Promise<HeavyHookCliProbe> {
  const { api: injected, ...delivery } = options;
  const api = injected ?? (await loadHeavyHookDelivery());
  return api.probeHeavyHookCli(projectRoot, delivery);
}

/**
 * Whether any provider has CLEO's hook in place (installed or outdated), so
 * the `cleo` it calls matters.
 *
 * @param inspections - the providers' states.
 */
export function heavyHookPresent(inspections: readonly HeavyHookInspection[]): boolean {
  return inspections.some((i) => i.state === 'installed' || i.state === 'outdated');
}

/** One line of an init/upgrade report about the hook. */
export interface HeavyHookReportLine {
  /** `applied`: something was written; `skipped`: the hook is not (fully) in place. */
  readonly status: 'applied' | 'skipped';
  /** What happened, naming the provider and file. */
  readonly details: string;
  /** Why the hook is not in place (`skipped` only). */
  readonly reason?: string;
  /** The exact remedy (`skipped` only). */
  readonly fix?: string;
}

/**
 * The report lines for a delivery: every write, and every provider in use
 * whose hook could not be put in place (blocked, unsupported or failed).
 * Unchanged hooks and providers not in use add nothing.
 *
 * @param outcomes - the delivery outcomes.
 * @returns the lines, in provider order.
 */
export function heavyHookReportLines(
  outcomes: readonly HeavyHookDeliveryOutcome[],
): readonly HeavyHookReportLine[] {
  const lines: HeavyHookReportLine[] = [];
  for (const o of outcomes) {
    switch (o.status) {
      case 'installed':
      case 'updated':
      case 'removed':
        lines.push({
          status: 'applied',
          details: `heavy-command hook (${o.provider}): ${o.status} ${o.target}`,
        });
        break;
      case 'blocked':
      case 'unsupported':
      case 'failed':
        lines.push({
          status: 'skipped',
          details: `heavy-command hook (${o.provider}): ${o.status}, ${o.target}`,
          reason: `${o.provider} ${o.status}: ${o.reason ?? 'no reason given'}`,
          ...(o.remedy === undefined ? {} : { fix: o.remedy }),
        });
        break;
      default:
        break;
    }
  }
  return lines;
}

/** States that need the user's attention (the provider is in use). */
const PROBLEM_STATES: ReadonlySet<HeavyHookInspection['state']> = new Set([
  'missing',
  'outdated',
  'blocked',
  'unreadable',
]);

/**
 * Whether an inspection is a problem the user should fix: the hook is
 * missing, outdated, blocked or unreadable for a provider in use (or present
 * while the mode is off).
 *
 * @param inspection - one provider's state.
 */
export function isHeavyHookProblem(inspection: HeavyHookInspection): boolean {
  return PROBLEM_STATES.has(inspection.state);
}

/**
 * The one-line briefing warning when a provider in use has no working hook,
 * or `null` when every provider in use is covered (or the check itself
 * fails; doctor reports that). Kimi's permanent `unsupported` state is left to
 * `cleo doctor`, so the briefing does not repeat it every session.
 *
 * @param projectRoot - the project root.
 * @param options - environment and provider list (tests); `api` replaces the
 *   run-time loaded adapters module.
 */
export async function heavyHookBriefingWarning(
  projectRoot: string,
  options: HeavyHookDeliveryOptions & { readonly api?: HeavyHookDeliveryApi } = {},
): Promise<string | null> {
  let report: HeavyHookInspectionReport;
  try {
    // No git spawns on the briefing path (review LOW-5); `cleo doctor` runs them.
    report = await inspectHeavyCommandHooks(projectRoot, { gitChecks: false, ...options });
  } catch {
    return null;
  }
  const problems = report.inspections.filter(isHeavyHookProblem);
  if (problems.length === 0) return null;
  const list = problems.map((p) => `${p.provider} (${p.state})`).join(', ');
  return (
    `Heavy-command hook not in place for ${list}: agent-run tests, builds and typechecks ` +
    `bypass the machine-wide resource budget. Remedy: ${HEAVY_HOOK_FIX}`
  );
}
