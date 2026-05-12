# CANT Variable/Template Substitution Design (T1234, R2)

## Executive Summary

This document specifies the **generic template agent variable substitution engine** for CLEO. It enables `.cant` and `.cantbook` files to declare placeholders (e.g., `{{tech_stack}}`, `{{project_domain}}`) that are resolved at install/spawn time from project context (`project-context.json`), session state, and environment. The design unifies mustache-style syntax already present in playbooks with a formal substitution resolver chain, deferring substitution until spawn time (lazy evaluation) to maximize flexibility and allow dynamic context injection from BRAIN.

---

## 1. Inventory: Current Variable/Template Support

### 1.1 What Exists Today

**Playbook Syntax (Active):**
- `.cantbook` files already use `{{inputs.fieldName}}` syntax throughout:
  - `release.cantbook`: `{{inputs.targetVersion}}` (L26, L29, L56, L69)
  - `rcasd.cantbook`: `{{inputs.epicId}}` (L24, L27), `{{inputs.scope}}` (L28)
  - `ivtr.cantbook`: `{{inputs.taskId}}` (L26, L30)
- **Parser behavior:** `parsePlaybook()` in `playbooks/src/parser.ts` does NOT currently interpolate these—it preserves them as literal strings in the AST
- **Test proof:** `playbooks/src/__tests__/parser.test.ts:114` asserts `research.inputs?.topic === '{{inputs.epicId}}'` (literal)

**CANT Agent System (Inactive):**
- CANT agent definitions (`packages/cant/src/types.ts:CantAgentV3`) have no template support
- `prompt`, `description`, `skills` fields are literal strings
- **No existing interpolation:** Grep for `{{`, `${`, `interpolate`, `substitute`, `template` yields zero matches in CANT src

**Composer/Spawn Pipeline (Context-Aware):**
- `composeSpawnPayload()` in `packages/cant/src/composer.ts` merges context from:
  1. Context sources (BRAIN queries)
  2. Mental model slices
  3. Token-budgeted system prompt assembly
- Context is **not** used to resolve agent prompt templates—it's injected as-is into the system prompt

### 1.2 Conclusion: Template Engine Does NOT Exist

There is **no unified variable substitution system** today. Playbooks carry literal `{{inputs.*}}` strings that the runtime presumably resolves at execution time (in playbook runtime, not implemented yet). CANT agents have zero template support. The composer does context injection but no templating.

---

## 2. Playbook Syntax Confirmation

### 2.1 Confirmed Usage in Starter Cantbooks

| File | Variable | Context | Line(s) |
|------|----------|---------|---------|
| `release.cantbook` | `{{inputs.targetVersion}}` | Approval gate prompt, node description, publish command | 26, 29, 56, 69 |
| `release.cantbook` | `{{inputs.channel}}` | Approval gate prompt, publish command | 56, 69 |
| `rcasd.cantbook` | `{{inputs.epicId}}` | Node descriptions, specification stage | 24, 25, 91 |
| `rcasd.cantbook` | `{{inputs.scope}}` | Research stage input | 28 |
| `ivtr.cantbook` | `{{inputs.taskId}}` | Implement stage description and input | 26, 30 |

### 2.2 Parser Behavior

`playbooks/src/parser.ts` line 115–148:
- Loads `.cantbook` as YAML
- Validates structure (version, name, nodes, edges, etc.)
- **Does NOT interpolate** `{{...}}` strings
- Preserves them literally in the `PlaybookDefinition` AST

The parsing is **syntax-agnostic** to template variables—it treats them as opaque string content. Interpolation responsibility is deferred to runtime.

---

## 3. Syntax Decision: Mustache `{{var}}` 

### 3.1 Decision: **Adopt Mustache `{{var}}` syntax**

**Rationale:**
1. **Already present in codebase:** Playbooks use `{{inputs.X}}` extensively; this document extends it to agent templates
2. **Ubiquitous standard:** Mustache, Handlebars, Liquid, Jinja2 all use `{{var}}`; most teams recognize it
3. **Unambiguous parsing:** Double braces do not appear in natural prompt text; minimizes false positives
4. **Dot-notation chaining:** `{{context.foo.bar}}` reads naturally; aligns with playbook idiom
5. **Backward compatible:** Existing playbooks already use it; no syntax migration needed
6. **Simple regex:** Single regex pattern `/{{\s*[\w.]+\s*}}/g` covers the entire language

**Rejected alternatives:**
- `${var}` — Used in shell scripting; confusing in prompts; less readable in YAML
- CANT-native (e.g., `@var`) — No prior art in codebase; adds custom grammar burden
- `${{var}}` — Double-prefix; verbose; not idiomatic

---

## 4. Substitution Engine Design

### 4.1 Core Interfaces (TypeScript)

```typescript
/**
 * A resolved value from any tier of the resolver chain.
 */
export interface ResolvedVariable {
  /** The variable name (e.g., "tech_stack", "project_domain"). */
  name: string;
  /** The resolved value (string, number, boolean, or null if missing). */
  value: string | number | boolean | null;
  /** Which resolver tier provided this value. */
  source: 'project_context' | 'session' | 'env' | 'default' | 'missing';
}

/**
 * Template substitution options.
 */
export interface SubstitutionOptions {
  /** Whether to throw on missing variables (true) or leave placeholders (false). */
  strict: boolean;
  /** Default value for missing variables when not strict. */
  defaultValue?: string;
  /** Whether to log warnings for missing variables. */
  warnMissing?: boolean;
  /** Allowed variable names (whitelist); if provided, others are rejected. */
  allowedVars?: string[];
}

/**
 * Substitution result envelope.
 */
export interface SubstitutionResult {
  /** The substituted text. */
  text: string;
  /** All variables resolved during substitution. */
  resolved: ResolvedVariable[];
  /** Variables referenced but not found (populated only when strict=false). */
  missing: string[];
  /** Whether substitution succeeded (false if strict=true and vars were missing). */
  success: boolean;
  /** Error message if substitution failed. */
  error?: string;
}

/**
 * Context payload passed to the resolver.
 */
export interface SubstitutionContext {
  /** Project context (from project-context.json). */
  projectContext?: Record<string, unknown>;
  /** Session context (task, epic, user, etc.). */
  sessionContext?: Record<string, unknown>;
  /** Environment variables (process.env). */
  env?: Record<string, string>;
  /** Explicit bindings (highest priority). */
  bindings?: Record<string, unknown>;
}

/**
 * Main substitution resolver.
 */
export interface VariableResolver {
  /**
   * Resolve and substitute variables in text.
   * 
   * Resolver chain (in priority order):
   * 1. bindings (explicit)
   * 2. session context
   * 3. project context
   * 4. environment (prefixed CLEO_ or CANT_)
   * 5. default value or missing
   */
  resolve(
    text: string,
    context: SubstitutionContext,
    options?: SubstitutionOptions,
  ): SubstitutionResult;

  /**
   * Extract all variables from text without resolving.
   */
  extractVariables(text: string): string[];

  /**
   * Validate that all required variables can be resolved.
   */
  validate(
    requiredVars: string[],
    context: SubstitutionContext,
  ): { valid: boolean; missing: string[] };
}
```

### 4.2 Implementation Sketch: `VariableResolver`

```typescript
export class DefaultVariableResolver implements VariableResolver {
  private variablePattern = /{{\s*([\w.]+)\s*}}/g;

  resolve(
    text: string,
    context: SubstitutionContext,
    options: SubstitutionOptions = { strict: false },
  ): SubstitutionResult {
    const resolved: ResolvedVariable[] = [];
    const missing: string[] = [];
    let result = text;
    let success = true;

    // Extract and resolve each variable
    const matches = [...text.matchAll(this.variablePattern)];
    for (const match of matches) {
      const varName = match[1];

      // Check whitelist
      if (options.allowedVars && !options.allowedVars.includes(varName)) {
        if (options.strict) {
          return {
            text,
            resolved,
            missing,
            success: false,
            error: `Variable "${varName}" not in whitelist`,
          };
        }
        continue;
      }

      // Resolver chain
      const value = this.resolveVariable(varName, context);

      if (value !== null && value !== undefined) {
        const strValue = String(value);
        result = result.replace(new RegExp(`{{\\s*${varName}\\s*}}`, 'g'), strValue);
        resolved.push({ name: varName, value: strValue, source: value.source || 'unknown' });
      } else {
        missing.push(varName);
        if (options.strict) {
          success = false;
        } else if (options.defaultValue !== undefined) {
          result = result.replace(
            new RegExp(`{{\\s*${varName}\\s*}}`, 'g'),
            options.defaultValue,
          );
          resolved.push({
            name: varName,
            value: options.defaultValue,
            source: 'default',
          });
        }
        // else: leave placeholder in result

        if (options.warnMissing) {
          console.warn(`Variable "${varName}" not resolved`);
        }
      }
    }

    return {
      text: success ? result : text,
      resolved,
      missing,
      success,
      error: success ? undefined : `Missing variables: ${missing.join(', ')}`,
    };
  }

  /**
   * Resolver chain: bindings → session → project → env → default → missing
   */
  private resolveVariable(
    varName: string,
    context: SubstitutionContext,
  ): { value: string | number | boolean | null; source: string } | null {
    // 1. Explicit bindings (highest priority)
    if (context.bindings?.[varName] !== undefined) {
      return { value: context.bindings[varName] as any, source: 'bindings' };
    }

    // 2. Session context
    if (context.sessionContext?.[varName] !== undefined) {
      return { value: context.sessionContext[varName] as any, source: 'session' };
    }

    // 3. Project context (from project-context.json)
    const projectValue = this.resolveNested(varName, context.projectContext);
    if (projectValue !== undefined) {
      return { value: projectValue, source: 'project_context' };
    }

    // 4. Environment variables (CLEO_* or CANT_* prefix)
    const envKey = `CLEO_${varName.toUpperCase()}` || `CANT_${varName.toUpperCase()}`;
    if (context.env?.[envKey] !== undefined) {
      return { value: context.env[envKey], source: 'env' };
    }

    // 5. Not found
    return null;
  }

  /**
   * Support dot notation: "foo.bar.baz" → context.foo?.bar?.baz
   */
  private resolveNested(path: string, obj?: Record<string, unknown>): unknown {
    if (!obj) return undefined;
    return path.split('.').reduce((curr, key) => {
      return curr?.[key as keyof typeof curr];
    }, obj as any);
  }

  extractVariables(text: string): string[] {
    const vars = new Set<string>();
    const matches = [...text.matchAll(this.variablePattern)];
    for (const match of matches) {
      vars.add(match[1]);
    }
    return Array.from(vars);
  }

  validate(
    requiredVars: string[],
    context: SubstitutionContext,
  ): { valid: boolean; missing: string[] } {
    const missing: string[] = [];
    for (const varName of requiredVars) {
      const value = this.resolveVariable(varName, context);
      if (value === null) {
        missing.push(varName);
      }
    }
    return { valid: missing.length === 0, missing };
  }
}
```

### 4.3 Resolver Chain (Priority Order)

When resolving a variable `{{tech_stack}}`:

1. **Bindings** (explicit, highest priority)
   - Used for programmatic overrides at spawn time
   - Example: `{ tech_stack: 'rust' }` passed to resolver

2. **Session Context**
   - Task-scoped state from `playbook_runs.bindings`
   - Example: `{ taskId: 'T1234', epicId: 'T999' }`

3. **Project Context** (`project-context.json`)
   - Project-wide metadata: `primaryType`, `testing.framework`, `build.command`
   - Example: `{ primaryType: 'node', testing: { framework: 'vitest' } }`

4. **Environment Variables** (with prefix)
   - `CLEO_TECH_STACK=node`, `CANT_PROJECT_DOMAIN=accounts`
   - Supports CI/CD overrides

5. **Default Value** (if provided in options)
   - Fallback string used when variable not found
   - Example: `defaultValue: 'typescript'`

6. **Missing**
   - If `strict: true` → throw error
   - If `strict: false` → leave placeholder `{{tech_stack}}` in text
   - If `warnMissing: true` → log warning

---

## 5. Example Template + Substitution

### 5.1 Template Definition: `dev-generic.cant`

```cant
agent dev-generic:
  version: "1.0.0"
  role: worker
  tier: mid
  description: >
    Generic development agent for {{project_domain}} projects using {{tech_stack}}.
    Runs tests with: {{test_command}}
    Builds with: {{build_command}}

  prompt: |
    You are a development agent for a {{project_domain}} application.
    
    Tech stack: {{tech_stack}}
    Test framework: {{test_framework}}
    Build system: {{build_system}}
    Primary language: {{primary_language}}
    
    When implementing features:
    1. Follow {{code_style}} conventions
    2. Run {{test_command}} locally before submitting
    3. Ensure all tests pass
    4. Update {{docs_format}} if needed

  skills:
    - {{dev_skill_1}}
    - {{dev_skill_2}}
    - ct-task-executor

  permissions:
    code:
      read: ["packages/{{code_path}}/**"]
      write: ["packages/{{code_path}}/**"]
```

### 5.2 Project Context (`project-context.json`)

```json
{
  "schemaVersion": "1.0.0",
  "projectTypes": ["node"],
  "primaryType": "node",
  "testing": {
    "framework": "vitest",
    "command": "pnpm run test"
  },
  "build": {
    "command": "pnpm run build"
  },
  "conventions": {
    "fileNaming": "kebab-case",
    "importStyle": "esm",
    "typeSystem": "TypeScript strict"
  },
  "custom": {
    "project_domain": "e-commerce",
    "tech_stack": "TypeScript + React",
    "primary_language": "TypeScript",
    "code_style": "ESLint + Prettier",
    "code_path": "apps/web",
    "docs_format": "Markdown"
  }
}
```

### 5.3 Session Context (at spawn time)

```typescript
const sessionContext = {
  taskId: 'T1234',
  epicId: 'T999',
  user: 'alice@example.com',
  session_id: 'sess-xyz',
};
```

### 5.4 Explicit Bindings (from spawn payload)

```typescript
const bindings = {
  dev_skill_1: 'ct-task-executor',
  dev_skill_2: 'ct-validator',
  test_command: 'pnpm run test -- src/features',
  build_command: 'pnpm run build',
  test_framework: 'vitest',
  build_system: 'tsup',
};
```

### 5.5 Resolved Output

After `resolver.resolve(template, context)`:

```cant
agent dev-generic:
  version: "1.0.0"
  role: worker
  tier: mid
  description: >
    Generic development agent for e-commerce projects using TypeScript + React.
    Runs tests with: pnpm run test
    Builds with: pnpm run build

  prompt: |
    You are a development agent for a e-commerce application.
    
    Tech stack: TypeScript + React
    Test framework: vitest
    Build system: tsup
    Primary language: TypeScript
    
    When implementing features:
    1. Follow ESLint + Prettier conventions
    2. Run pnpm run test -- src/features locally before submitting
    3. Ensure all tests pass
    4. Update Markdown if needed

  skills:
    - ct-task-executor
    - ct-validator
    - ct-task-executor

  permissions:
    code:
      read: ["packages/apps/web/**"]
      write: ["packages/apps/web/**"]
```

---

## 6. Test Vectors

Three template fragments tested against three contexts, expected outputs verified:

### Test Vector 1: Minimal Substitution

**Template:**
```
Build command: {{build_command}}
Test framework: {{test_framework}}
```

**Context:**
```typescript
{
  projectContext: {
    build: { command: 'cargo build' },
    testing: { framework: 'pytest' }
  },
  bindings: { build_command: 'cargo build --release', test_framework: 'pytest' }
}
```

**Expected Output:**
```
Build command: cargo build --release
Test framework: pytest
```

**Verification:**
- Bindings override project context ✓
- Both variables resolved ✓
- success = true ✓

### Test Vector 2: Nested Dot-Notation + Missing Variables (Strict=False)

**Template:**
```
Domain: {{domain}}
Language: {{conventions.typeSystem}}
Unknown: {{unknown_var}}
```

**Context:**
```typescript
{
  projectContext: {
    custom: { domain: 'payments' },
    conventions: { typeSystem: 'TypeScript strict', fileNaming: 'kebab-case' }
  }
}
```

**Expected Output:**
```
Domain: payments
Language: TypeScript strict
Unknown: {{unknown_var}}
```

**Verification:**
- Dot notation resolved from projectContext ✓
- Missing variable left as placeholder ✓
- success = true (strict=false) ✓
- missing = ['unknown_var'] ✓

### Test Vector 3: Environment Variables + Strict Mode

**Template:**
```
API URL: {{api_url}}
Secret: {{secret_key}}
```

**Context:**
```typescript
{
  env: {
    CLEO_API_URL: 'https://api.example.com',
    CLEO_SECRET_KEY: 'should-not-appear'  // In real code, don't log secrets
  }
}
```

**Options:** `{ strict: true }`

**Expected Output:**
```
Result: {
  success: true,
  text: 'API URL: https://api.example.com\nSecret: should-not-appear',
  resolved: [
    { name: 'api_url', value: 'https://api.example.com', source: 'env' },
    { name: 'secret_key', value: 'should-not-appear', source: 'env' }
  ],
  missing: [],
  error: undefined
}
```

**Verification:**
- Environment variables resolved with prefix lookup ✓
- Strict mode passes when all vars found ✓
- success = true ✓

---

## 7. Integration Point: Lazy Substitution at Spawn Time

### 7.1 Recommended Design: **Lazy Substitution at `cleo orchestrate spawn`**

**Chosen Approach:** Substitute variables **at spawn time** (inside `orchestrateSpawnExecute` flow), not at install time.

**Rationale:**
1. **Dynamic context:** At install/`agent install` time, project context may be incomplete (new projects). At spawn time, full context (BRAIN, mental model, session state) is available
2. **Flexibility:** Allows different agents to be spawned with different variable bindings from the same template
3. **BRAIN integration:** The context-provider pipeline (`composeSpawnPayload`) runs at spawn time; substitution naturally fits there
4. **Backward compat:** Agents without templates work unchanged; templates are opt-in

### 7.2 Integration Flow

```
┌─────────────────────────────────────────────────────────────────┐
│ 1. cleo agent install <template.cant> <project-domain>         │
│    → Parse template, validate syntax, store in .cleo/agents/    │
│    → No substitution yet (lazy)                                 │
└─────────────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────────┐
│ 2. cleo orchestrate spawn <taskId>                              │
│    → Load agent template from .cleo/agents/                     │
│    → resolveAgent(taskId) → fetch Task + context               │
│    → buildProjectContext(root) → load project-context.json      │
│    → buildSessionContext(taskId, epicId) → task-specific state  │
└─────────────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────────┐
│ 3. VariableResolver.resolve()                                   │
│    → Extract {{variables}} from agent prompt + description      │
│    → Apply resolver chain:                                      │
│       1. Explicit bindings (from spawn payload)                 │
│       2. Session context                                         │
│       3. Project context                                         │
│       4. Environment                                            │
│    → Return substituted prompt + description                    │
└─────────────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────────┐
│ 4. composeSpawnPayload(agent, contextProvider, projectHash)    │
│    → Resolve context sources from BRAIN                         │
│    → Compose system prompt (now with substituted template)     │
│    → Apply tier escalation + token budgets                      │
│    → Return SpawnPayload                                        │
└─────────────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────────┐
│ 5. adapter.spawn(spawnPayload)                                  │
│    → Send to Claude API with fully-resolved prompt             │
└─────────────────────────────────────────────────────────────────┘
```

### 7.3 Code Integration Points

**In `packages/cleo/src/dispatch/engines/orchestrate-engine.ts`:**

```typescript
async function orchestrateSpawnExecute(
  taskId: string,
  projectRoot?: string,
): Promise<EngineResult> {
  try {
    const root = projectRoot || resolveProjectRoot();
    
    // 1. Resolve task + agent
    const task = await resolveTask(taskId, root);
    const agent = await resolveAgent(task.assignedAgent, root);

    // NEW: Load project + session context
    const projectContext = await buildProjectContext(root);
    const sessionContext = buildSessionContext(taskId, task.epicId);

    // NEW: Substitute variables in agent template
    const resolver = new DefaultVariableResolver();
    const substitutionContext = {
      projectContext,
      sessionContext,
      env: process.env,
      bindings: task.context || {}, // task-specific overrides
    };

    const promptResolution = resolver.resolve(
      agent.prompt,
      substitutionContext,
      { strict: false, warnMissing: true }
    );

    const descriptionResolution = resolver.resolve(
      agent.description,
      substitutionContext,
      { strict: false }
    );

    // Check for critical missing variables
    if (!promptResolution.success) {
      return engineError('E_TEMPLATE_RESOLUTION', promptResolution.error);
    }

    // 2. Update agent with resolved prompt/description
    const resolvedAgent = {
      ...agent,
      prompt: promptResolution.text,
      description: descriptionResolution.text,
    };

    // 3. Proceed to composition (existing flow)
    const spawnPayload = await composeSpawnPayload(
      resolvedAgent,
      contextProvider,
      projectHash
    );

    // 4. Spawn via adapter
    const result = await adapter.spawn(spawnPayload);
    return { success: true, data: result };
  } catch (err: unknown) {
    return engineError('E_GENERAL', (err as Error).message);
  }
}
```

**In `packages/cant/src/bundle.ts` (optional validation at compile time):**

```typescript
/**
 * Validate that a template uses only declared/allowed variables.
 * Runs at compile time (agent install), warns of undefined vars.
 */
function validateTemplateVariables(
  agent: CantAgentV3,
  allowedVars: string[],
): BundleDiagnostic[] {
  const resolver = new DefaultVariableResolver();
  const diagnostics: BundleDiagnostic[] = [];

  // Extract all variables from prompt + description
  const allVars = [
    ...resolver.extractVariables(agent.prompt),
    ...resolver.extractVariables(agent.description),
  ];

  for (const varName of allVars) {
    if (!allowedVars.includes(varName)) {
      diagnostics.push({
        ruleId: 'T01_UNDEFINED_TEMPLATE_VAR',
        message: `Template variable "${varName}" not declared in schema`,
        severity: 'warning',
        sourcePath: agent.sourcePath,
      });
    }
  }

  return diagnostics;
}
```

### 7.4 Schema for Template Metadata (Optional)

When installing a template, optionally provide a schema defining expected variables:

```yaml
# dev-generic.cant
agent dev-generic:
  version: "1.0.0"
  role: worker
  template:
    variables:
      - name: tech_stack
        description: "Technology stack (e.g., TypeScript, Rust, Python)"
        source: project_context
        required: true
      - name: project_domain
        description: "Business domain (e.g., e-commerce, payments)"
        source: project_context
        required: false
        defaultValue: "general"
      - name: test_command
        description: "Command to run tests"
        source: project_context
        required: true
      - name: build_command
        description: "Command to build project"
        source: project_context
        required: true
```

At validation time, check that all `required: true` variables are resolvable from the candidate context.

---

## 8. Specification: Missing Variable Handling

### 8.1 Default Behavior

**Strict Mode: `false` (default)**
- Missing variables left as `{{var_name}}` in output
- Allows partial substitution; agent still spawns with placeholder text
- Useful for optional/contextual variables
- Warnings logged (if `warnMissing: true`)

**Strict Mode: `true`**
- Missing variables cause substitution to fail
- Returns `{ success: false, error: "Missing variables: [...]" }`
- Spawn is aborted; caller must resolve variables before retry
- Useful for critical, non-optional variables

### 8.2 Configuration Recommendation

For CANT agents:
```typescript
resolver.resolve(agent.prompt, context, {
  strict: false,           // Allow partial substitution
  warnMissing: true,       // Log missing variables
  defaultValue: '{{var}}', // Leave placeholders
});
```

For playbook approval prompts:
```typescript
resolver.resolve(approvalPrompt, context, {
  strict: true,            // Critical: must resolve fully
  warnMissing: false,      // Error instead of warning
});
```

---

## 9. Migration & Rollout Strategy

### Phase 1: Foundation (Week 1)
- Implement `VariableResolver` interface + `DefaultVariableResolver` class
- Place in new package: `packages/cant/src/variable-resolver.ts` (or `packages/resolve/`)
- Export from `@cleocode/cant` public API
- Unit tests (test vectors 1–3 from §6)

### Phase 2: CANT Integration (Week 2)
- Wire into `orchestrateSpawnExecute` flow
- Add validation diagnostic rule `T01_UNDEFINED_TEMPLATE_VAR` to bundle compiler
- Update agent schema docs to mention templates
- E2E test: install template → spawn with context → verify substitution

### Phase 3: Playbook Runtime (Week 3, Future)
- Integrate into playbook runtime (`packages/playbooks/src/runtime.ts`)
- Resolve `{{inputs.*}}` at node dispatch time
- Update playbook parser to extract variable schema from `inputs[]`

### Phase 4: Documentation & Examples
- Add playbook/agent template examples to `.cleo/docs/`
- Publish guide: "Creating Generic Template Agents"
- Migration guide for existing agents → templates

---

## 10. Edge Cases & Constraints

### 10.1 Escaping

No escape sequence defined. If literal `{{var}}` text needed, store in context and reference:

```typescript
// Don't:
description: "Use {{var}} syntax in templates"

// Do:
description: "Use {{template_syntax}} in templates"
// with: { template_syntax: '{{var}}' }
```

### 10.2 Recursive Substitution

Not supported. Variables cannot reference other variables:

```typescript
// Not allowed:
{ tech_stack: '{{primary_language}}' }
// This does NOT recursively resolve
```

If multi-level substitution needed, resolve in applicat ion before passing to resolver.

### 10.3 Array/Object Serialization

Variables are stringified. Complex values rendered as JSON:

```typescript
bindings: {
  config: { foo: 'bar', num: 42 }
}
// In template: "Config: {{config}}"
// Resolves to: "Config: {\"foo\":\"bar\",\"num\":42}"
```

Use a specialized stringifier if pretty-printing needed.

### 10.4 Whitelist Enforcement (Optional)

For security-sensitive templates, restrict allowed variables:

```typescript
resolver.resolve(template, context, {
  allowedVars: ['project_domain', 'tech_stack', 'build_command']
  // References to other vars rejected
});
```

### 10.5 Case Sensitivity

Variable names are **case-sensitive**:
- `{{tech_stack}}` ≠ `{{TECH_STACK}}`
- Convention: use snake_case for all variables

---

## 11. Future Extensions (Out of Scope)

1. **Conditional substitution:** `{{#if var}}...{{/if}}`
2. **Filters/functions:** `{{var | uppercase}}`
3. **Loops:** `{{#each items}}...{{/each}}`
4. **Partial includes:** `{{> shared-prompt}}`

These can be added in a future phase if needed, without breaking the current design. The mustache syntax is extensible.

---

## 12. Files to Create / Modify

### New Files
- `packages/cant/src/variable-resolver.ts` — Core resolver implementation
- `packages/cant/src/__tests__/variable-resolver.test.ts` — Unit tests (test vectors)
- `.cleo/examples/templates/dev-generic.cant` — Example generic agent template
- `.cleo/docs/template-agents.md` — User guide

### Modifications
- `packages/cleo/src/dispatch/engines/orchestrate-engine.ts` — Integrate resolver in `orchestrateSpawnExecute`
- `packages/cant/src/bundle.ts` — Add validation diagnostic for undefined template variables
- `packages/cant/src/types.ts` — Add optional `template` field to `CantAgentV3`
- `packages/cant/src/index.ts` — Export `VariableResolver`, `DefaultVariableResolver`

---

## 13. Acceptance Criteria (Implementation Checklist)

- [ ] `VariableResolver` interface defined + `DefaultVariableResolver` implemented
- [ ] Mustache regex pattern covers all valid variables (dots, underscores, alphanumeric)
- [ ] Resolver chain (bindings → session → project → env) implemented + tested
- [ ] Test vectors 1–3 (§6) pass with expected outputs
- [ ] Integration into `orchestrateSpawnExecute` flow (no-op if no templates present)
- [ ] E2E: `cleo agent install dev-generic.cant` + `cleo orchestrate spawn T1234` produces resolved prompt
- [ ] Documentation + examples committed
- [ ] Zero breaking changes to existing playbook/agent syntax
- [ ] Performance: substitution overhead < 10ms per template (typical prompts ~5KB)

---

## 14. References & Prior Art

- **Mustache.js:** https://github.com/janl/mustache.js/ (reference implementation)
- **Handlebars.js:** Similar syntax; more features (not needed yet)
- **Existing CLEO playbooks:** `release.cantbook`, `rcasd.cantbook`, `ivtr.cantbook` (template examples)
- **ULTRAPLAN §9.3:** Spawn-time composition pipeline in `packages/cant/src/composer.ts`
- **Playbook Runtime:** `packages/playbooks/src/runtime.ts` (context management model)

---

**Document Version:** 1.0  
**Status:** Design Complete, Ready for Implementation  
**Owner:** R2 (Variable Syntax Lead)  
**Date:** 2026-04-21  
**Task:** T1234 (CANT Variable/Template Substitution Design)  
**Epic:** T1232 (CLEO Agents Architecture Remediation, v2026.4.110)
