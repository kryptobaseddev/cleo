/**
 * Setup wizard entry point (E-CONFIG-AUTH-UNIFY E3 / T9420).
 *
 * Re-exports the engine + every built-in section + a convenience
 * factory that wires the canonical order. Both `cleo setup` (T9421)
 * and the Studio `/setup` route (T-E3-8) consume this surface.
 *
 * V2 additions (T9607): re-exports {@link WizardInterruptError}.
 * V2 additions (T9608): re-exports {@link createIntegrationsSection}.
 *
 * @task T9420
 * @task T9607
 * @task T9608
 * @epic T9402
 * @epic T9591
 */

import { createBrainSection } from './sections/brain.js';
import { createHarnessSection } from './sections/harness.js';
import { createIdentitySection } from './sections/identity.js';
import { createIntegrationsSection } from './sections/integrations.js';
import { createLlmSection, type LlmSectionDeps } from './sections/llm.js';
import { createModelsRolesSection } from './sections/models-roles.js';
import { createProjectConventionsSection } from './sections/project-conventions.js';
import { createSentientSection } from './sections/sentient.js';
import { createTelemetrySection } from './sections/telemetry.js';
import { createVerificationSection } from './sections/verification.js';
import { WizardRunner, type WizardSectionRunner } from './wizard.js';

// Per-section `--config-json` → WizardOptions merger (T9985 / E8-CLI-LAYERING).
export { mergeConfigJson, WIZARD_SECTION_IDS } from './config-json-merge.js';
export { createBrainSection } from './sections/brain.js';
export { createHarnessSection } from './sections/harness.js';
export { createIdentitySection } from './sections/identity.js';
export { createIntegrationsSection } from './sections/integrations.js';
export { createLlmSection, type LlmSectionDeps } from './sections/llm.js';
export { createModelsRolesSection } from './sections/models-roles.js';
export { createProjectConventionsSection } from './sections/project-conventions.js';
export { createSentientSection } from './sections/sentient.js';
export { createTelemetrySection } from './sections/telemetry.js';
export {
  createVerificationSection,
  type VerificationCheck,
} from './sections/verification.js';
export {
  StubWizardIO,
  WizardFatalError,
  WizardInterruptError,
  type WizardIO,
  type WizardOptions,
  WizardRunner,
  type WizardRunResult,
  type WizardSection,
  type WizardSectionResult,
  type WizardSectionRunner,
} from './wizard.js';

/**
 * Construct every built-in {@link WizardSectionRunner} in canonical order.
 *
 * Order matters: `cleo setup` walks the list verbatim. The current
 * order is:
 *   1. `llm`                 — credentials are the prerequisite for everything else
 *   2. `models-roles`        — default model + per-role profiles (T11726)
 *   3. `identity`            — agent name / SOUL.md before any agent dispatch
 *   4. `sentient`            — daemon enablement after credentials exist
 *   5. `project-conventions` — strictness preset before harness/brain layering
 *   6. `harness`             — operator selects Pi vs Claude Code (T9425)
 *   7. `brain`               — BRAIN memory bridge mode (T9425)
 *   8. `integrations`        — SignalDock + Studio + Conduit (T9608)
 *   9. `telemetry`           — anonymous skills-usage telemetry (T9673)
 *  10. `verification`        — read-only health checks (T9594)
 *
 * @param llmDeps - Optional dependencies forwarded to the `llm` section — most
 *   notably the interactive OAuth token acquirer (T11727). The CLI surface
 *   passes the real acquirer so the wizard OAuth path runs the inline engine;
 *   programmatic callers omit it (OAuth path points the user at `cleo login`).
 * @returns Fresh array of section runner instances.
 * @task T9420
 * @task T9425
 * @task T9594
 * @task T9608
 * @task T9673
 * @task T11726
 * @task T11727
 */
export function createBuiltinSections(llmDeps: LlmSectionDeps = {}): WizardSectionRunner[] {
  return [
    createLlmSection(llmDeps),
    createModelsRolesSection(),
    createIdentitySection(),
    createSentientSection(),
    createProjectConventionsSection(),
    createHarnessSection(),
    createBrainSection(),
    createIntegrationsSection(),
    createTelemetrySection(),
    createVerificationSection(),
  ];
}

/**
 * Construct a {@link WizardRunner} pre-wired with the built-in sections.
 *
 * @param llmDeps - Optional `llm` section dependencies (see
 *   {@link createBuiltinSections}); forwards the interactive OAuth acquirer.
 * @returns A ready-to-run wizard runner.
 * @task T9420
 * @task T11727
 */
export function createDefaultWizardRunner(llmDeps: LlmSectionDeps = {}): WizardRunner {
  return new WizardRunner(createBuiltinSections(llmDeps));
}
