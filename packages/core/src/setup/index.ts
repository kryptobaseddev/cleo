/**
 * Setup wizard entry point (E-CONFIG-AUTH-UNIFY E3 / T9420).
 *
 * Re-exports the engine + every built-in section + a convenience
 * factory that wires the canonical order. Both `cleo setup` (T9421)
 * and the Studio `/setup` route (T-E3-8) consume this surface.
 *
 * V2 additions (T9607): re-exports {@link WizardInterruptError}.
 *
 * @task T9420
 * @task T9607
 * @epic T9402
 * @epic T9591
 */

import { createBrainSection } from './sections/brain.js';
import { createHarnessSection } from './sections/harness.js';
import { createIdentitySection } from './sections/identity.js';
import { createLlmSection } from './sections/llm.js';
import { createProjectConventionsSection } from './sections/project-conventions.js';
import { createSentientSection } from './sections/sentient.js';
import { createVerificationSection } from './sections/verification.js';
import { WizardRunner, type WizardSectionRunner } from './wizard.js';

export { createBrainSection } from './sections/brain.js';
export { createHarnessSection } from './sections/harness.js';
export { createIdentitySection } from './sections/identity.js';

export { createLlmSection } from './sections/llm.js';
export { createProjectConventionsSection } from './sections/project-conventions.js';
export { createSentientSection } from './sections/sentient.js';
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
 *   2. `identity`            — agent name / SOUL.md before any agent dispatch
 *   3. `sentient`            — daemon enablement after credentials exist
 *   4. `project-conventions` — strictness preset before harness/brain layering
 *   5. `harness`             — operator selects Pi vs Claude Code (T9425)
 *   6. `brain`               — BRAIN memory bridge mode (T9425)
 *   7. `verification`        — read-only health checks (T9594)
 *
 * @returns Fresh array of section runner instances.
 * @task T9420
 * @task T9425
 * @task T9594
 */
export function createBuiltinSections(): WizardSectionRunner[] {
  return [
    createLlmSection(),
    createIdentitySection(),
    createSentientSection(),
    createProjectConventionsSection(),
    createHarnessSection(),
    createBrainSection(),
    createVerificationSection(),
  ];
}

/**
 * Construct a {@link WizardRunner} pre-wired with the built-in sections.
 *
 * @returns A ready-to-run wizard runner.
 * @task T9420
 */
export function createDefaultWizardRunner(): WizardRunner {
  return new WizardRunner(createBuiltinSections());
}
