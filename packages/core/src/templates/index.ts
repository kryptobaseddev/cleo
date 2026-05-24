/**
 * Core Templates Module
 *
 * Barrel export for GitHub issue template parsing logic (T5701) and the
 * SSoT template registry over `TemplateManifestEntry[]` (T9877).
 *
 * @task T5705 T9877
 * @epic T5701 T9874
 * @saga T9855
 */

export { TEMPLATE_MANIFEST_ENTRIES } from './manifest-data.js';
export type {
  IssueTemplate,
  TemplateConfig,
  TemplateResult,
  TemplateSection,
} from './parser.js';
export {
  generateTemplateConfig,
  getTemplateForSubcommand,
  parseIssueTemplates,
  validateLabels,
} from './parser.js';
export type { InstalledStatus } from './registry.js';
export {
  getInstalledStatus,
  getTemplateById,
  getTemplateManifest,
  getTemplatesByKind,
} from './registry.js';
