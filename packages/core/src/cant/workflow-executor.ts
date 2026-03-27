/**
 * CANT workflow executor — orchestrates workflow statement execution.
 *
 * Walks the statement list of a `WorkflowDef` AST node, dispatching to
 * appropriate handlers for each statement type: sessions, pipelines,
 * parallel blocks, conditionals, loops, try/catch, approval gates,
 * bindings, directives, and output statements.
 *
 * Pipelines are delegated to the Rust executor via napi-rs bridge.
 * Sessions invoke the CLEO session machinery. Discretion conditions
 * are evaluated by a pluggable evaluator.
 *
 * @see docs/specs/CANT-DSL-SPEC.md Section 7.2 (Workflow Execution)
 */

import { ApprovalManager } from './approval.js';
import {
  createChildScope,
  createScope,
  flattenScope,
  resolveVariable,
  setVariable,
} from './context-builder.js';
import type { DiscretionEvaluator } from './discretion.js';
import { DefaultDiscretionEvaluator, RateLimitedDiscretionEvaluator } from './discretion.js';
import { executeParallel } from './parallel-runner.js';
import type { ParallelArm as ParallelArmRunner } from './parallel-runner.js';
import type {
  DiscretionContext,
  ExecutionResult,
  ExecutionScope,
  JoinStrategy,
  StepResult,
} from './types.js';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** Configuration options for the workflow executor. */
export interface WorkflowExecutorConfig {
  /** Maximum number of discretion evaluations per workflow run (default: 100). */
  maxDiscretionEvaluations?: number;
  /** The session ID for this execution. */
  sessionId?: string;
  /** The agent ID performing the execution. */
  agentId?: string;
}

// ---------------------------------------------------------------------------
// Statement type discriminators (from cant-core AST)
//
// These are lightweight type guards for the AST Statement enum variants.
// The real AST types come from the Rust parser; here we use structural
// matching to avoid tight coupling with the napi binding shape.
// ---------------------------------------------------------------------------

/** Loose AST statement shape — mirrors cant-core Statement variants. */
interface AstStatement {
  type?: string;
  [key: string]: unknown;
}

/** A workflow definition with a name, params, and body statements. */
interface WorkflowDef {
  name: { value: string };
  params: Array<{ name: { value: string } }>;
  body: AstStatement[];
}

// ---------------------------------------------------------------------------
// Workflow Executor
// ---------------------------------------------------------------------------

/**
 * Executes CANT workflow definitions.
 *
 * The executor processes each statement in the workflow body sequentially,
 * maintaining an execution scope for variable bindings and dispatching to
 * the appropriate handler based on statement type.
 */
export class WorkflowExecutor {
  private readonly discretionEvaluator: DiscretionEvaluator;
  private readonly approvalManager: ApprovalManager;
  private readonly config: WorkflowExecutorConfig;

  /**
   * Creates a new workflow executor.
   *
   * @param discretionEvaluator - Custom discretion evaluator (default: stub that returns true).
   * @param approvalManager - Approval token manager (default: new instance).
   * @param config - Executor configuration.
   */
  constructor(
    discretionEvaluator: DiscretionEvaluator = new DefaultDiscretionEvaluator(),
    approvalManager: ApprovalManager = new ApprovalManager(),
    config: WorkflowExecutorConfig = {},
  ) {
    const maxEvals = config.maxDiscretionEvaluations ?? 100;
    this.discretionEvaluator = new RateLimitedDiscretionEvaluator(discretionEvaluator, maxEvals);
    this.approvalManager = approvalManager;
    this.config = config;
  }

  /**
   * Executes a workflow definition with the given parameter values.
   *
   * @param workflow - The parsed workflow AST node.
   * @param context - Parameter values and initial context.
   * @returns Execution result with outputs and step results.
   */
  async execute(
    workflow: WorkflowDef,
    context: Record<string, unknown> = {},
  ): Promise<ExecutionResult> {
    const start = Date.now();
    const scope = createScope(context);
    const steps: StepResult[] = [];
    const outputs: Record<string, unknown> = {};

    // Bind workflow parameters to scope
    for (const param of workflow.params) {
      const value = context[param.name.value];
      if (value !== undefined) {
        setVariable(scope, param.name.value, value);
      }
    }

    let success = true;

    for (const statement of workflow.body) {
      const stepStart = Date.now();

      try {
        const result = await this.executeStatement(statement, scope, outputs);
        if (result) {
          steps.push({ ...result, duration: Date.now() - stepStart });
          if (!result.success) {
            success = false;
            break;
          }
        }
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        steps.push({
          name: getStatementName(statement),
          type: getStatementType(statement),
          success: false,
          error,
          duration: Date.now() - stepStart,
        });
        success = false;
        break;
      }
    }

    return {
      success,
      outputs,
      steps,
      duration: Date.now() - start,
    };
  }

  /**
   * Dispatches a single statement to the appropriate handler.
   */
  private async executeStatement(
    statement: AstStatement,
    scope: ExecutionScope,
    outputs: Record<string, unknown>,
  ): Promise<StepResult | null> {
    const stmtType = detectStatementType(statement);

    switch (stmtType) {
      case 'Binding':
        return this.executeBinding(statement, scope);
      case 'Output':
        return this.executeOutput(statement, scope, outputs);
      case 'Conditional':
        return this.executeConditional(statement, scope, outputs);
      case 'Parallel':
        return this.executeParallelBlock(statement, scope, outputs);
      case 'Session':
        return this.executeSession(statement, scope);
      case 'Pipeline':
        return this.executePipeline(statement, scope);
      case 'ApprovalGate':
        return this.executeApprovalGate(statement, scope);
      case 'Repeat':
        return this.executeRepeat(statement, scope, outputs);
      case 'ForLoop':
        return this.executeForLoop(statement, scope, outputs);
      case 'LoopUntil':
        return this.executeLoopUntil(statement, scope, outputs);
      case 'TryCatch':
        return this.executeTryCatch(statement, scope, outputs);
      case 'Directive':
        return this.executeDirective(statement, scope);
      case 'Comment':
        return null; // Comments are no-ops
      default:
        return {
          name: getStatementName(statement),
          type: 'binding',
          success: true,
          duration: 0,
        };
    }
  }

  /** Execute a let binding statement. */
  private async executeBinding(
    statement: AstStatement,
    scope: ExecutionScope,
  ): Promise<StepResult> {
    const name = (statement as { name?: { value: string } }).name?.value ?? 'binding';
    const value = (statement as { value?: unknown }).value;
    setVariable(scope, name, value);
    return { name, type: 'binding', success: true, output: value, duration: 0 };
  }

  /** Execute an output binding statement. */
  private async executeOutput(
    statement: AstStatement,
    scope: ExecutionScope,
    outputs: Record<string, unknown>,
  ): Promise<StepResult> {
    const name = (statement as { name?: { value: string } }).name?.value ?? 'output';
    const value = (statement as { value?: unknown }).value;
    outputs[name] = value;
    setVariable(scope, name, value);
    return { name, type: 'output', success: true, output: value, duration: 0 };
  }

  /** Execute an if/elif/else conditional. */
  private async executeConditional(
    statement: AstStatement,
    scope: ExecutionScope,
    outputs: Record<string, unknown>,
  ): Promise<StepResult> {
    const conditional = statement as {
      condition?: { Discretion?: { prose: string }; Expression?: unknown };
      then_body?: AstStatement[];
      elif_branches?: Array<{
        condition: { Discretion?: { prose: string }; Expression?: unknown };
        body: AstStatement[];
      }>;
      else_body?: AstStatement[];
    };

    // Evaluate the if condition
    const ifResult = await this.evaluateCondition(conditional.condition, scope);

    if (ifResult) {
      for (const stmt of conditional.then_body ?? []) {
        await this.executeStatement(stmt, scope, outputs);
      }
      return { name: 'if', type: 'conditional', success: true, output: true, duration: 0 };
    }

    // Check elif branches
    for (const elif of conditional.elif_branches ?? []) {
      const elifResult = await this.evaluateCondition(elif.condition, scope);
      if (elifResult) {
        for (const stmt of elif.body) {
          await this.executeStatement(stmt, scope, outputs);
        }
        return { name: 'elif', type: 'conditional', success: true, output: true, duration: 0 };
      }
    }

    // Execute else branch
    if (conditional.else_body) {
      for (const stmt of conditional.else_body) {
        await this.executeStatement(stmt, scope, outputs);
      }
    }

    return { name: 'else', type: 'conditional', success: true, output: false, duration: 0 };
  }

  /** Execute a parallel block with arms. */
  private async executeParallelBlock(
    statement: AstStatement,
    scope: ExecutionScope,
    outputs: Record<string, unknown>,
  ): Promise<StepResult> {
    const parallel = statement as {
      modifier?: string;
      arms?: Array<{ name: string; body: AstStatement }>;
    };

    const strategy: JoinStrategy =
      parallel.modifier === 'Race' ? 'race'
      : parallel.modifier === 'Settle' ? 'settle'
      : 'all';

    const arms: ParallelArmRunner[] = (parallel.arms ?? []).map((arm) => ({
      name: arm.name,
      execute: async () => {
        const childScope = createChildScope(scope);
        const armOutputs: Record<string, unknown> = {};
        const result = await this.executeStatement(arm.body, childScope, armOutputs);
        return result?.output;
      },
    }));

    const result = await executeParallel(arms, strategy);

    // Bind arm results to the parent scope
    for (const [name, value] of Object.entries(result.results)) {
      setVariable(scope, name, value);
    }

    return {
      name: 'parallel',
      type: 'parallel',
      success: result.success,
      output: result.results,
      duration: 0,
    };
  }

  /** Execute a session invocation (stub — real session dispatch is a separate integration). */
  private async executeSession(
    statement: AstStatement,
    _scope: ExecutionScope,
  ): Promise<StepResult> {
    const session = statement as {
      target?: { Prompt?: string; Agent?: string };
    };
    const targetName = session.target?.Prompt ?? session.target?.Agent ?? 'session';
    // Stub: real session dispatch integrates with CLEO session machinery
    return {
      name: targetName,
      type: 'session',
      success: true,
      output: { stub: true, target: targetName },
      duration: 0,
    };
  }

  /** Execute a pipeline definition (stub — real pipeline calls Rust via napi-rs). */
  private async executePipeline(
    statement: AstStatement,
    _scope: ExecutionScope,
  ): Promise<StepResult> {
    const pipeline = statement as { name?: { value: string } };
    const name = pipeline.name?.value ?? 'pipeline';
    // Stub: real implementation calls Rust pipeline executor via napi-rs bridge
    return {
      name,
      type: 'pipeline',
      success: true,
      output: { stub: true },
      duration: 0,
    };
  }

  /** Execute an approval gate. */
  private async executeApprovalGate(
    statement: AstStatement,
    scope: ExecutionScope,
  ): Promise<StepResult> {
    const gate = statement as {
      properties?: Array<{ key: { value: string }; value: { raw?: string } }>;
    };

    const message =
      gate.properties?.find((p) => p.key.value === 'message')?.value?.raw ?? 'Approval required';
    const gateName = 'approval-gate';

    const workflowHash = ApprovalManager.computeWorkflowHash(JSON.stringify(statement));
    const token = this.approvalManager.generateToken(
      this.config.sessionId ?? 'unknown-session',
      'workflow',
      gateName,
      message,
      workflowHash,
      this.config.agentId ?? 'unknown-agent',
    );

    // In production, the executor would suspend the session here and
    // wait for a /approve directive. For now, return the token info.
    return {
      name: gateName,
      type: 'approval',
      success: true,
      output: { tokenId: token.token, message, status: token.status },
      duration: 0,
    };
  }

  /** Execute a repeat N loop. */
  private async executeRepeat(
    statement: AstStatement,
    scope: ExecutionScope,
    outputs: Record<string, unknown>,
  ): Promise<StepResult> {
    const repeat = statement as { count?: { value?: number }; body?: AstStatement[] };
    const count = repeat.count?.value ?? 1;

    for (let i = 0; i < count; i++) {
      const iterScope = createChildScope(scope, { _iteration: i });
      for (const stmt of repeat.body ?? []) {
        await this.executeStatement(stmt, iterScope, outputs);
      }
    }

    return { name: `repeat(${count})`, type: 'loop', success: true, output: count, duration: 0 };
  }

  /** Execute a for-in loop. */
  private async executeForLoop(
    statement: AstStatement,
    scope: ExecutionScope,
    outputs: Record<string, unknown>,
  ): Promise<StepResult> {
    const forLoop = statement as {
      variable?: { value: string };
      iterable?: unknown;
      body?: AstStatement[];
    };

    const varName = forLoop.variable?.value ?? 'item';
    const iterable = forLoop.iterable;
    const items = Array.isArray(iterable) ? iterable : [];

    for (const item of items) {
      const iterScope = createChildScope(scope, { [varName]: item });
      for (const stmt of forLoop.body ?? []) {
        await this.executeStatement(stmt, iterScope, outputs);
      }
    }

    return {
      name: `for(${varName})`,
      type: 'loop',
      success: true,
      output: items.length,
      duration: 0,
    };
  }

  /** Execute a loop-until block. */
  private async executeLoopUntil(
    statement: AstStatement,
    scope: ExecutionScope,
    outputs: Record<string, unknown>,
  ): Promise<StepResult> {
    const loop = statement as { body?: AstStatement[]; condition?: unknown };
    let iterations = 0;
    const maxIterations = 10000;

    do {
      iterations++;
      if (iterations > maxIterations) {
        throw new Error(`Loop exceeded maximum iterations (${maxIterations})`);
      }

      for (const stmt of loop.body ?? []) {
        await this.executeStatement(stmt, scope, outputs);
      }

      const conditionMet = await this.evaluateCondition(loop.condition, scope);
      if (conditionMet) break;
    } while (true);

    return {
      name: 'loop-until',
      type: 'loop',
      success: true,
      output: iterations,
      duration: 0,
    };
  }

  /** Execute a try/catch/finally block. */
  private async executeTryCatch(
    statement: AstStatement,
    scope: ExecutionScope,
    outputs: Record<string, unknown>,
  ): Promise<StepResult> {
    const tryCatch = statement as {
      try_body?: AstStatement[];
      catch_name?: string;
      catch_body?: AstStatement[];
      finally_body?: AstStatement[];
    };

    let success = true;
    let error: string | undefined;

    try {
      for (const stmt of tryCatch.try_body ?? []) {
        await this.executeStatement(stmt, scope, outputs);
      }
    } catch (err) {
      success = false;
      error = err instanceof Error ? err.message : String(err);

      if (tryCatch.catch_body) {
        const catchScope = createChildScope(scope, {
          [tryCatch.catch_name ?? 'err']: error,
        });
        for (const stmt of tryCatch.catch_body) {
          await this.executeStatement(stmt, catchScope, outputs);
        }
      }
    } finally {
      if (tryCatch.finally_body) {
        for (const stmt of tryCatch.finally_body) {
          await this.executeStatement(stmt, scope, outputs);
        }
      }
    }

    return { name: 'try-catch', type: 'conditional', success, error, duration: 0 };
  }

  /** Execute a CANT directive statement. */
  private async executeDirective(
    statement: AstStatement,
    _scope: ExecutionScope,
  ): Promise<StepResult> {
    const directive = statement as {
      verb?: string;
      addresses?: string[];
      task_refs?: string[];
    };

    // Stub: real implementation dispatches via CLEO operations
    return {
      name: `/${directive.verb ?? 'unknown'}`,
      type: 'directive',
      success: true,
      output: {
        verb: directive.verb,
        addresses: directive.addresses,
        taskRefs: directive.task_refs,
      },
      duration: 0,
    };
  }

  /**
   * Evaluate a condition (regular expression or discretion).
   */
  private async evaluateCondition(
    condition: unknown,
    scope: ExecutionScope,
  ): Promise<boolean> {
    if (!condition) return true;

    const cond = condition as {
      Discretion?: { prose: string };
      Expression?: unknown;
    };

    if (cond.Discretion) {
      const context: DiscretionContext = {
        sessionId: this.config.sessionId ?? '',
        taskRefs: [],
        agentId: this.config.agentId ?? '',
        variables: flattenScope(scope),
        condition: cond.Discretion.prose,
        precedingResults: {},
      };
      return this.discretionEvaluator.evaluate(cond.Discretion.prose, context);
    }

    // For regular expressions, return true as a stub
    // Real implementation would evaluate the expression against the scope
    return true;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Detect the statement type from an AST statement object. */
function detectStatementType(statement: AstStatement): string {
  if ('Binding' in statement) return 'Binding';
  if ('Output' in statement) return 'Output';
  if ('Conditional' in statement || 'condition' in statement && 'then_body' in statement) return 'Conditional';
  if ('Parallel' in statement || 'arms' in statement) return 'Parallel';
  if ('Session' in statement || 'target' in statement) return 'Session';
  if ('Pipeline' in statement || ('steps' in statement && 'name' in statement)) return 'Pipeline';
  if ('ApprovalGate' in statement) return 'ApprovalGate';
  if ('Repeat' in statement || 'count' in statement) return 'Repeat';
  if ('ForLoop' in statement || ('variable' in statement && 'iterable' in statement)) return 'ForLoop';
  if ('LoopUntil' in statement) return 'LoopUntil';
  if ('TryCatch' in statement || 'try_body' in statement) return 'TryCatch';
  if ('Directive' in statement || 'verb' in statement) return 'Directive';
  if ('Comment' in statement || 'text' in statement) return 'Comment';
  return statement.type ?? 'unknown';
}

/** Extract a human-readable name from a statement. */
function getStatementName(statement: AstStatement): string {
  const named = statement as { name?: { value: string } | string; verb?: string };
  if (typeof named.name === 'object' && named.name?.value) return named.name.value;
  if (typeof named.name === 'string') return named.name;
  if (named.verb) return `/${named.verb}`;
  return detectStatementType(statement);
}

/** Map a statement to a StepResult type category. */
function getStatementType(
  statement: AstStatement,
): StepResult['type'] {
  const t = detectStatementType(statement);
  const mapping: Record<string, StepResult['type']> = {
    Session: 'session',
    Pipeline: 'pipeline',
    Parallel: 'parallel',
    Conditional: 'conditional',
    Repeat: 'loop',
    ForLoop: 'loop',
    LoopUntil: 'loop',
    ApprovalGate: 'approval',
    Binding: 'binding',
    Output: 'output',
    Directive: 'directive',
  };
  return mapping[t] ?? 'binding';
}
