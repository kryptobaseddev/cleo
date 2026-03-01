/**
 * Anti-Hallucination Validation Rules - Re-export stub
 *
 * Canonical location: src/core/validation/validation-rules.ts
 * This file re-exports for backward compatibility with MCP engine consumers.
 * @task T5095
 */
export {
  validateTitleDescription,
  validateTimestamps,
  validateIdUniqueness,
  validateNoDuplicateDescription,
  validateHierarchy,
  validateStatusTransition,
  validateNewTask,
  hasErrors,
  type RuleViolation,
} from '../../core/validation/validation-rules.js';
