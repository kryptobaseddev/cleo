/**
 * Barrel for the `cleo templates` command group.
 *
 * The dispatch wrapper lives at `packages/cleo/src/cli/commands/templates.ts`
 * (so the command-manifest generator — which only scans top-level
 * `commands/*.ts` files — picks it up). The wrapper imports the individual
 * subcommands from this barrel.
 *
 * @task T9886
 * @saga T9855
 * @epic T9874
 * @adr 076
 */

export type { TemplatesDiffResult } from './diff.js';
export { templatesDiffCommand, unifiedDiff } from './diff.js';
export type { TemplatesInstallResult } from './install.js';
export { templatesInstallCommand } from './install.js';
export type { TemplatesListResult } from './list.js';
export { templatesListCommand } from './list.js';
export type { TemplatesShowResult } from './show.js';
export { templatesShowCommand } from './show.js';
export type { TemplatesUpgradeOutcome, TemplatesUpgradeResult } from './upgrade.js';
export { templatesUpgradeCommand } from './upgrade.js';
export type { TemplatesValidateEntry, TemplatesValidateResult } from './validate.js';
export { templatesValidateCommand } from './validate.js';
