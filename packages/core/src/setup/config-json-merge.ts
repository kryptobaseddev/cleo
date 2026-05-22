/**
 * Per-section `--config-json` → {@link WizardOptions} merger.
 *
 * Extracted from `packages/cleo/src/cli/commands/setup.ts` per the AGENTS.md
 * Package-Boundary Check: this is pure JSON-schema merging logic with no
 * citty / readline / browser dependencies — it belongs in core where it
 * can be unit-tested without spinning up the CLI and reused by any consumer
 * (Studio routes, programmatic API, scripts) that needs the same merge.
 *
 * The function mutates the supplied {@link WizardOptions} bag in place,
 * preserving the long-standing contract that the flat `args` bag takes
 * precedence over `configJson` values (explicit flags win).
 *
 * @task T9985
 * @epic T9985 (E8-CLI-LAYERING)
 * @saga T9977 (SG-WORKTRUNK-OWN)
 * @see AGENTS.md § "Package-Boundary Check (MANDATORY)"
 */

import type { WizardOptions } from './wizard.js';

/**
 * Section IDs recognised by the built-in setup wizard. Keys outside this set
 * are silently dropped during merging — preserves forward-compatibility while
 * still preventing typos from leaking arbitrary fields into `WizardOptions`.
 *
 * Mirrors {@link createBuiltinSections} in `./index.ts`.
 *
 * @public
 */
export const WIZARD_SECTION_IDS: ReadonlySet<string> = new Set<string>([
  'llm',
  'identity',
  'harness',
  'sentient',
  'project-conventions',
  'brain',
  'integrations',
  'verification',
]);

/**
 * Merge a per-section config-json bag into the flat {@link WizardOptions} bag.
 *
 * The `configJson` object maps section IDs to WizardOptions sub-objects.
 * Only keys recognised as WizardOptions fields are merged; unknown keys and
 * unrecognised section IDs are silently ignored. The flat `out` bag takes
 * precedence over `configJson` values (explicit CLI flags win).
 *
 * The function mutates `out` in place and also stores the original parsed bag
 * at `out.configJson` so sections can inspect the per-section sub-object if
 * they need to.
 *
 * @param parsed - Already-parsed JSON object (caller ensures this is an object).
 * @param out    - Mutable WizardOptions being assembled — merged into here.
 *
 * @public
 * @task T9985
 */
export function mergeConfigJson(
  parsed: Record<string, Record<string, unknown>>,
  out: WizardOptions,
): void {
  // Store the raw bag so sections / downstream code can inspect it.
  out.configJson = parsed;

  for (const [sectionId, sectionOpts] of Object.entries(parsed)) {
    // Silently skip unrecognised section keys — forward-compatibility.
    if (!WIZARD_SECTION_IDS.has(sectionId)) continue;
    if (typeof sectionOpts !== 'object' || sectionOpts === null) continue;

    // Merge every recognised WizardOptions field from the per-section bag.
    // Only set fields that are not already set from explicit CLI flags (they
    // take precedence).  Caller does not know which fields are applicable to
    // which section — all fields live at the top level per the WizardOptions
    // contract.

    if ('provider' in sectionOpts && out.provider === undefined) {
      if (typeof sectionOpts['provider'] === 'string' && sectionOpts['provider'] !== '') {
        out.provider = sectionOpts['provider'] as string;
      }
    }
    if ('apiKey' in sectionOpts && out.apiKey === undefined) {
      if (typeof sectionOpts['apiKey'] === 'string' && sectionOpts['apiKey'] !== '') {
        out.apiKey = sectionOpts['apiKey'] as string;
      }
    }
    if ('label' in sectionOpts && out.label === undefined) {
      if (typeof sectionOpts['label'] === 'string' && sectionOpts['label'] !== '') {
        out.label = sectionOpts['label'] as string;
      }
    }
    if ('agentName' in sectionOpts && out.agentName === undefined) {
      if (typeof sectionOpts['agentName'] === 'string' && sectionOpts['agentName'] !== '') {
        out.agentName = sectionOpts['agentName'] as string;
      }
    }
    if ('soulMdContent' in sectionOpts && out.soulMdContent === undefined) {
      if (typeof sectionOpts['soulMdContent'] === 'string' && sectionOpts['soulMdContent'] !== '') {
        out.soulMdContent = sectionOpts['soulMdContent'] as string;
      }
    }
    if ('strictness' in sectionOpts && out.strictness === undefined) {
      const s = sectionOpts['strictness'];
      if (s === 'strict' || s === 'standard' || s === 'minimal') {
        out.strictness = s;
      }
    }
    if ('harness' in sectionOpts && out.harness === undefined) {
      const h = sectionOpts['harness'];
      if (h === 'pi' || h === 'claude-code') {
        out.harness = h;
      }
    }
    if ('brainBridgeMode' in sectionOpts && out.brainBridgeMode === undefined) {
      const b = sectionOpts['brainBridgeMode'];
      if (b === 'digest' || b === 'file' || b === 'disabled') {
        out.brainBridgeMode = b;
      }
    }
    if ('sentientEnabled' in sectionOpts && out.sentientEnabled === undefined) {
      if (typeof sectionOpts['sentientEnabled'] === 'boolean') {
        out.sentientEnabled = sectionOpts['sentientEnabled'];
      }
    }
    if ('tier2Enabled' in sectionOpts && out.tier2Enabled === undefined) {
      if (typeof sectionOpts['tier2Enabled'] === 'boolean') {
        out.tier2Enabled = sectionOpts['tier2Enabled'];
      }
    }
    if ('signaldockAutoConnect' in sectionOpts && out.signaldockAutoConnect === undefined) {
      if (typeof sectionOpts['signaldockAutoConnect'] === 'boolean') {
        out.signaldockAutoConnect = sectionOpts['signaldockAutoConnect'];
      }
    }
    if ('brainRetentionDays' in sectionOpts && out.brainRetentionDays === undefined) {
      const v = sectionOpts['brainRetentionDays'];
      if (typeof v === 'number' && Number.isInteger(v) && v >= 0) {
        out.brainRetentionDays = v;
      }
    }
    if ('brainEmbeddingEnabled' in sectionOpts && out.brainEmbeddingEnabled === undefined) {
      if (typeof sectionOpts['brainEmbeddingEnabled'] === 'boolean') {
        out.brainEmbeddingEnabled = sectionOpts['brainEmbeddingEnabled'];
      }
    }
    if ('signaldockEnabled' in sectionOpts && out.signaldockEnabled === undefined) {
      if (typeof sectionOpts['signaldockEnabled'] === 'boolean') {
        out.signaldockEnabled = sectionOpts['signaldockEnabled'];
      }
    }
    if ('signaldockEndpoint' in sectionOpts && out.signaldockEndpoint === undefined) {
      if (
        typeof sectionOpts['signaldockEndpoint'] === 'string' &&
        sectionOpts['signaldockEndpoint'] !== ''
      ) {
        out.signaldockEndpoint = sectionOpts['signaldockEndpoint'] as string;
      }
    }
    if ('studioEnabled' in sectionOpts && out.studioEnabled === undefined) {
      if (typeof sectionOpts['studioEnabled'] === 'boolean') {
        out.studioEnabled = sectionOpts['studioEnabled'];
      }
    }
    if ('conduitPath' in sectionOpts && out.conduitPath === undefined) {
      if (typeof sectionOpts['conduitPath'] === 'string' && sectionOpts['conduitPath'] !== '') {
        out.conduitPath = sectionOpts['conduitPath'] as string;
      }
    }
    if ('poolSeedingConsent' in sectionOpts && out.poolSeedingConsent === undefined) {
      if (typeof sectionOpts['poolSeedingConsent'] === 'boolean') {
        out.poolSeedingConsent = sectionOpts['poolSeedingConsent'];
      }
    }
    if ('acEnforcementMode' in sectionOpts && out.acEnforcementMode === undefined) {
      const m = sectionOpts['acEnforcementMode'];
      if (m === 'block' || m === 'warn' || m === 'off') {
        out.acEnforcementMode = m;
      }
    }
    if ('sessionAutoStart' in sectionOpts && out.sessionAutoStart === undefined) {
      if (typeof sectionOpts['sessionAutoStart'] === 'boolean') {
        out.sessionAutoStart = sectionOpts['sessionAutoStart'];
      }
    }
  }
}
