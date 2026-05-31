/**
 * Template Parser Engine (thin re-export shim).
 *
 * The template-parser adapter was relocated to `@cleocode/runtime/gateway`
 * (R3-K1 · T11455 · SG-RUNTIME-UNIFICATION) as a dependency of the relocated
 * engine barrel. This shim re-exports the full surface so any in-package
 * consumer importing from `'../engines/template-parser.js'` compiles unchanged.
 *
 * @task T5705
 * @task T11455
 * @epic T5701
 */

export {
  generateTemplateConfig,
  getTemplateForSubcommand,
  type IssueTemplate,
  parseIssueTemplates,
  type TemplateConfig,
  type TemplateSection,
  validateLabels,
} from '@cleocode/runtime/gateway';
