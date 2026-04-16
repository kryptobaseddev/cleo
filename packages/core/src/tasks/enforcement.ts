import { type AcceptanceItem, ExitCode, type Task } from '@cleocode/contracts';
import { loadConfig } from '../config.js';

export interface ValidationResult {
  valid: boolean;
  error?: string;
  fix?: string;
  exitCode?: ExitCode;
}

export interface AddTaskEnforcementOptions {
  acceptance?: AcceptanceItem[];
  priority?: string;
}

export interface UpdateTaskEnforcementOptions {
  acceptance?: AcceptanceItem[];
}

export interface AcceptanceEnforcement {
  validateCreation(options: AddTaskEnforcementOptions): ValidationResult;
  validateUpdate(task: Task, updates: UpdateTaskEnforcementOptions): ValidationResult;
  validateCompletion(task: Task): ValidationResult;
  checkMinimumCriteria(criteria: AcceptanceItem[], minCriteria: number): boolean;
}

function checkMin(criteria: AcceptanceItem[], min: number): boolean {
  return Array.isArray(criteria) && criteria.length >= min;
}

export async function createAcceptanceEnforcement(cwd?: string): Promise<AcceptanceEnforcement> {
  // In VITEST, default to 'off' when config is absent. Tests that need
  // enforcement active write their own config, which overrides the default.
  const isTest = !!process.env.VITEST;

  const config = await loadConfig(cwd);
  const acceptance = config.enforcement?.acceptance;
  const mode = acceptance?.mode ?? (isTest ? 'off' : 'block');
  const requiredForPriorities = acceptance?.requiredForPriorities ?? [
    'critical',
    'high',
    'medium',
    'low',
  ];
  const minCriteria = acceptance?.minimumCriteria ?? 3;
  const defaultPriority = 'medium';

  return {
    checkMinimumCriteria: checkMin,

    validateCreation(options: AddTaskEnforcementOptions): ValidationResult {
      const priority = options.priority ?? defaultPriority;

      if (mode === 'off') return { valid: true };

      if (requiredForPriorities.includes(priority)) {
        const hasEnough = checkMin(options.acceptance ?? [], minCriteria);
        if (!hasEnough) {
          const msg = `Task requires at least ${minCriteria} acceptance criteria (priority: ${priority})`;
          if (mode === 'block') {
            return {
              valid: false,
              error: msg,
              fix: `Add --acceptance "criterion 1" --acceptance "criterion 2" --acceptance "criterion 3"`,
              exitCode: ExitCode.VALIDATION_ERROR,
            };
          } else if (mode === 'warn') {
            return { valid: true, error: msg };
          }
        }
      }
      return { valid: true };
    },

    validateUpdate(task: Task, updates: UpdateTaskEnforcementOptions): ValidationResult {
      if (mode === 'off') return { valid: true };

      if (updates.acceptance !== undefined) {
        if (mode === 'block' && requiredForPriorities.includes(task.priority)) {
          if (!checkMin(updates.acceptance, minCriteria)) {
            return {
              valid: false,
              error: `Task requires at least ${minCriteria} acceptance criteria`,
              fix: `Provide at least ${minCriteria} criteria when updating acceptance`,
              exitCode: ExitCode.VALIDATION_ERROR,
            };
          }
        }
      }

      return { valid: true };
    },

    validateCompletion(task: Task): ValidationResult {
      if (mode === 'off') return { valid: true };

      if (requiredForPriorities.includes(task.priority)) {
        if (!checkMin(task.acceptance ?? [], minCriteria)) {
          const msg = `Task ${task.id} requires at least ${minCriteria} acceptance criteria before completion`;
          if (mode === 'block') {
            return {
              valid: false,
              error: msg,
              fix: `Add criteria: cleo update ${task.id} --acceptance "criterion 1" --acceptance "criterion 2"`,
              exitCode: ExitCode.VALIDATION_ERROR,
            };
          } else if (mode === 'warn') {
            return { valid: true, error: msg };
          }
        }
      }
      return { valid: true };
    },
  };
}
