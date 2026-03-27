/**
 * Execution context builder for CANT workflows.
 *
 * Resolves variable references and manages the scope chain for workflow
 * execution. Variables from workflow parameters, step outputs, and
 * intermediate bindings are tracked in a hierarchical scope.
 *
 * @see docs/specs/CANT-DSL-SPEC.md Section 7.2 (Workflow Execution)
 */

import type { ExecutionScope } from './types.js';

/**
 * Creates a new root execution scope with initial variable bindings.
 *
 * @param initialBindings - Initial variable values (typically workflow parameters).
 * @returns A new root scope.
 */
export function createScope(initialBindings: Record<string, unknown> = {}): ExecutionScope {
  return {
    variables: { ...initialBindings },
  };
}

/**
 * Creates a child scope that inherits from a parent.
 *
 * Lookups in the child scope fall through to the parent if not found locally.
 * This is used for parallel arms, loop iterations, and nested blocks.
 *
 * @param parent - The parent scope.
 * @param localBindings - Local variable overrides for this child scope.
 * @returns A new child scope.
 */
export function createChildScope(
  parent: ExecutionScope,
  localBindings: Record<string, unknown> = {},
): ExecutionScope {
  return {
    variables: { ...localBindings },
    parent,
  };
}

/**
 * Resolves a variable name in the scope chain.
 *
 * Searches the current scope first, then walks up the parent chain.
 *
 * @param scope - The scope to search in.
 * @param name - The variable name to resolve.
 * @returns The variable value, or `undefined` if not found in any scope.
 */
export function resolveVariable(scope: ExecutionScope, name: string): unknown {
  // Check current scope
  if (name in scope.variables) {
    return scope.variables[name];
  }

  // Check parent chain
  if (scope.parent) {
    return resolveVariable(scope.parent, name);
  }

  return undefined;
}

/**
 * Sets a variable in the current scope (does not affect parent scopes).
 *
 * @param scope - The scope to modify.
 * @param name - The variable name to set.
 * @param value - The value to assign.
 */
export function setVariable(scope: ExecutionScope, name: string, value: unknown): void {
  scope.variables[name] = value;
}

/**
 * Resolves `{variable}` placeholders in a template string against the scope.
 *
 * Performs single-pass replacement per the T07 security rule: nested
 * interpolation within resolved values is treated as literal text.
 *
 * @param template - The string containing `{variable}` placeholders.
 * @param scope - The execution scope for variable resolution.
 * @returns The string with all placeholders resolved.
 * @throws {Error} If a referenced variable is not found in any scope.
 */
export function resolveTemplate(template: string, scope: ExecutionScope): string {
  return template.replace(/\{([^}]+)\}/g, (_match, varName: string) => {
    const value = resolveVariable(scope, varName);
    if (value === undefined) {
      throw new Error(`Variable '${varName}' not found in execution scope`);
    }
    return String(value);
  });
}

/**
 * Merges step output into the current scope.
 *
 * Binds `<stepName>.stdout`, `<stepName>.stderr`, and `<stepName>.exitCode`
 * for use in subsequent step variable resolution.
 *
 * @param scope - The scope to add bindings to.
 * @param stepName - The name of the completed step.
 * @param output - The step output to merge.
 */
export function mergeStepOutput(
  scope: ExecutionScope,
  stepName: string,
  output: Record<string, unknown>,
): void {
  // Bind the full output object under the step name
  scope.variables[stepName] = output;

  // Also bind dotted access for convenience
  for (const [key, value] of Object.entries(output)) {
    scope.variables[`${stepName}.${key}`] = value;
  }
}

/**
 * Collects all variable bindings visible from the given scope (including parents).
 *
 * Parent bindings are overridden by child bindings of the same name.
 *
 * @param scope - The scope to flatten.
 * @returns A flat record of all visible variable bindings.
 */
export function flattenScope(scope: ExecutionScope): Record<string, unknown> {
  const parentVars = scope.parent ? flattenScope(scope.parent) : {};
  return { ...parentVars, ...scope.variables };
}
