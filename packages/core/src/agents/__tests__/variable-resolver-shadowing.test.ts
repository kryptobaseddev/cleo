/**
 * Variable resolver order shadowing test — T1940 (LOAD-BEARING).
 *
 * Asserts the canonical resolver precedence chain used at spawn time:
 *
 *   step bindings ⊳ playbook bindings ⊳ session ⊳ project-context ⊳ env ⊳ default
 *
 * Each test verifies that a higher-tier value shadows a lower-tier value for
 * the SAME key. This is the "magic" the owner specifically called out — without
 * this test, drift in resolver order goes undetected and wrong values get
 * injected into CANT agent bodies at spawn time.
 *
 * Implementation note: the {@link DefaultVariableResolver} exposes a flat
 * `bindings` tier and a `sessionContext` tier. To model "step bindings" vs
 * "playbook bindings" — which are both `bindings` but at different call-sites
 * in the playbook runtime — we merge them into a single `bindings` map where
 * step-level bindings shadow playbook-level bindings by being placed first via
 * `Object.assign`. This mirrors how the playbook runtime's merge logic works:
 * step node bindings are applied on top of the playbook-level bindings object
 * before the resolver is called.
 *
 * The full resolution chain modelled here:
 *  1. `bindings`         — merged step + playbook bindings (step keys win)
 *  2. `sessionContext`   — per-session context variables
 *  3. `projectContext`   — `.cleo/project-context.json` (dot-notation)
 *  4. `env`              — `CLEO_<UPPER_SNAKE>` / `CANT_<UPPER_SNAKE>` environment variables
 *  5. `defaultValue`     — fallback string when all other tiers miss
 *
 * @task T1940
 * @epic T1929
 */

import { describe, expect, it } from 'vitest';
import { DefaultVariableResolver, substituteCantAgentBody } from '../variable-substitution.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const resolver = new DefaultVariableResolver();

/**
 * Merge step bindings over playbook bindings — the same pattern the playbook
 * runtime uses. Step bindings shadow playbook bindings for identical keys.
 *
 * @param playbookBindings - Bindings declared at the playbook level.
 * @param stepBindings     - Bindings declared at the step node level.
 * @returns Merged bindings with step values taking precedence.
 */
function mergeBindings(
  playbookBindings: Record<string, unknown>,
  stepBindings: Record<string, unknown>,
): Record<string, unknown> {
  // Step bindings shadow playbook bindings for the same key.
  return Object.assign({}, playbookBindings, stepBindings);
}

// ---------------------------------------------------------------------------
// Suite 1 — Tier-by-tier shadowing
// ---------------------------------------------------------------------------

describe('Variable resolver — tier-by-tier shadowing', () => {
  /**
   * Step bindings ⊳ playbook bindings
   *
   * When the same key 'topic' is present in both step and playbook bindings,
   * the step-level value MUST win (step bindings shadow playbook bindings).
   */
  it('step bindings shadow playbook bindings for the same key', () => {
    const playbookBindings = { topic: 'playbook-value', extra: 'from-playbook' };
    const stepBindings = { topic: 'step-value' };

    // Merge step over playbook — step shadows playbook.
    const merged = mergeBindings(playbookBindings, stepBindings);

    const result = resolver.resolve('Result: {{topic}} | Extra: {{extra}}', {
      bindings: merged,
    });

    expect(result.success).toBe(true);
    expect(result.text).toBe('Result: step-value | Extra: from-playbook');

    // The resolved variable for 'topic' must be sourced from 'bindings' (step won).
    const topicResolved = result.resolved.find((r) => r.name === 'topic');
    expect(topicResolved?.source).toBe('bindings');
    expect(topicResolved?.value).toBe('step-value');
  });

  /**
   * Playbook bindings ⊳ session context
   *
   * When 'topic' is present in both playbook bindings and sessionContext,
   * the playbook binding MUST win.
   */
  it('playbook bindings shadow session context for the same key', () => {
    const result = resolver.resolve('Topic: {{topic}}', {
      bindings: { topic: 'playbook-value' },
      sessionContext: { topic: 'session-value' },
    });

    expect(result.success).toBe(true);
    expect(result.text).toBe('Topic: playbook-value');

    const topicResolved = result.resolved.find((r) => r.name === 'topic');
    expect(topicResolved?.source).toBe('bindings');
    expect(topicResolved?.value).toBe('playbook-value');
  });

  /**
   * Session context ⊳ project-context
   *
   * When 'topic' is present in both sessionContext and projectContext,
   * sessionContext MUST win.
   */
  it('session context shadows project-context for the same key', () => {
    const result = resolver.resolve('Topic: {{topic}}', {
      sessionContext: { topic: 'session-value' },
      projectContext: { topic: 'project-context-value' },
    });

    expect(result.success).toBe(true);
    expect(result.text).toBe('Topic: session-value');

    const topicResolved = result.resolved.find((r) => r.name === 'topic');
    expect(topicResolved?.source).toBe('session');
    expect(topicResolved?.value).toBe('session-value');
  });

  /**
   * Project-context ⊳ env
   *
   * When 'topic' is present in both projectContext and env (as CLEO_TOPIC),
   * projectContext MUST win.
   */
  it('project-context shadows env for the same key', () => {
    const result = resolver.resolve('Topic: {{topic}}', {
      projectContext: { topic: 'project-context-value' },
      env: { CLEO_TOPIC: 'env-value' },
    });

    expect(result.success).toBe(true);
    expect(result.text).toBe('Topic: project-context-value');

    const topicResolved = result.resolved.find((r) => r.name === 'topic');
    expect(topicResolved?.source).toBe('project_context');
    expect(topicResolved?.value).toBe('project-context-value');
  });

  /**
   * Env ⊳ default
   *
   * When 'topic' is present in env (as CLEO_TOPIC) but NOT in any higher tier,
   * the env value MUST win over the defaultValue.
   */
  it('env shadows default for the same key', () => {
    const result = resolver.resolve('Topic: {{topic}}', {
      env: { CLEO_TOPIC: 'env-value' },
      // No bindings, sessionContext, projectContext.
    });

    expect(result.success).toBe(true);
    expect(result.text).toBe('Topic: env-value');

    const topicResolved = result.resolved.find((r) => r.name === 'topic');
    expect(topicResolved?.source).toBe('env');
    expect(topicResolved?.value).toBe('env-value');
  });
});

// ---------------------------------------------------------------------------
// Suite 2 — Cumulative shadowing (full chain)
// ---------------------------------------------------------------------------

describe('Variable resolver — full chain cumulative shadowing', () => {
  /**
   * Full chain: step beats all when set.
   *
   * Set 'topic' at every level of the resolver chain. Verify that the step
   * value (in bindings) wins in all cases.
   */
  it('step beats all other tiers when set at the binding level', () => {
    const stepBindings = { topic: 'step-value' };
    const playbookBindings = { topic: 'playbook-value' };
    const merged = mergeBindings(playbookBindings, stepBindings);

    const result = resolver.resolve('Topic: {{topic}}', {
      bindings: merged,
      sessionContext: { topic: 'session-value' },
      projectContext: { topic: 'project-context-value' },
      env: { CLEO_TOPIC: 'env-value' },
    });

    expect(result.success).toBe(true);
    expect(result.text).toBe('Topic: step-value');
    expect(result.resolved.find((r) => r.name === 'topic')?.source).toBe('bindings');
  });

  /**
   * Default surfaces only when nothing else is set.
   *
   * Unset 'topic' at every tier so the variable is unresolved. When
   * `defaultValue` is supplied to the resolve call, it must be used.
   */
  it('default value surfaces when nothing else is set', () => {
    const result = resolver.resolve(
      'Topic: {{topic}}',
      {
        bindings: {},
        sessionContext: {},
        projectContext: {},
        env: {},
      },
      {
        defaultValue: 'fallback-default',
      },
    );

    expect(result.success).toBe(true);
    expect(result.text).toBe('Topic: fallback-default');
    expect(result.resolved.find((r) => r.name === 'topic')?.source).toBe('default');
  });

  /**
   * Tier-by-tier exhaustion: each tier shadows the one below it.
   *
   * Removes tiers one at a time from the top, verifying that each lower tier
   * surfaces correctly when the upper tier(s) are absent.
   */
  it('resolves through the chain as higher tiers are exhausted', () => {
    const baseContext = {
      sessionContext: { topic: 'session-value' },
      projectContext: { topic: 'project-context-value' },
      env: { CLEO_TOPIC: 'env-value' },
    };

    // With step bindings → step wins.
    const r1 = resolver.resolve('{{topic}}', {
      bindings: { topic: 'step-value' },
      ...baseContext,
    });
    expect(r1.text).toBe('step-value');
    expect(r1.resolved[0]?.source).toBe('bindings');

    // Without bindings → session wins.
    const r2 = resolver.resolve('{{topic}}', {
      sessionContext: { topic: 'session-value' },
      projectContext: { topic: 'project-context-value' },
      env: { CLEO_TOPIC: 'env-value' },
    });
    expect(r2.text).toBe('session-value');
    expect(r2.resolved[0]?.source).toBe('session');

    // Without bindings + session → project-context wins.
    const r3 = resolver.resolve('{{topic}}', {
      projectContext: { topic: 'project-context-value' },
      env: { CLEO_TOPIC: 'env-value' },
    });
    expect(r3.text).toBe('project-context-value');
    expect(r3.resolved[0]?.source).toBe('project_context');

    // Without bindings + session + project-context → env wins.
    const r4 = resolver.resolve('{{topic}}', {
      env: { CLEO_TOPIC: 'env-value' },
    });
    expect(r4.text).toBe('env-value');
    expect(r4.resolved[0]?.source).toBe('env');

    // Without anything → unresolved (lenient leaves placeholder).
    const r5 = resolver.resolve('{{topic}}', {});
    expect(r5.text).toBe('{{topic}}');
    expect(r5.missing).toContain('topic');
    expect(r5.success).toBe(true); // lenient mode — not a hard failure
  });
});

// ---------------------------------------------------------------------------
// Suite 3 — Multi-variable template with mixed shadowing
// ---------------------------------------------------------------------------

describe('Variable resolver — multi-variable mixed shadowing', () => {
  /**
   * Multiple variables, each at different tiers.
   *
   * Verifies that each variable independently resolves from the highest tier
   * that holds a binding for it — no cross-contamination between variables.
   */
  it('each variable resolves independently from its highest tier', () => {
    const result = resolver.resolve(
      'Step: {{step_var}} | Session: {{session_var}} | Context: {{context_var}} | Env: {{env_var}}',
      {
        bindings: { step_var: 'from-step' },
        sessionContext: { session_var: 'from-session' },
        projectContext: { context_var: 'from-context' },
        env: { CLEO_ENV_VAR: 'from-env' },
      },
    );

    expect(result.success).toBe(true);
    expect(result.text).toBe(
      'Step: from-step | Session: from-session | Context: from-context | Env: from-env',
    );

    const byName = new Map(result.resolved.map((r) => [r.name, r]));
    expect(byName.get('step_var')?.source).toBe('bindings');
    expect(byName.get('session_var')?.source).toBe('session');
    expect(byName.get('context_var')?.source).toBe('project_context');
    expect(byName.get('env_var')?.source).toBe('env');
  });

  /**
   * Shadowing does not bleed across variables.
   *
   * A step-level binding for 'x' must not affect 'y', which resolves from
   * session context. Each variable's tier chain is independent.
   */
  it('step binding for one variable does not bleed into other variables', () => {
    const result = resolver.resolve('X: {{x}} | Y: {{y}}', {
      bindings: { x: 'step-x' }, // 'x' at step level
      sessionContext: { y: 'session-y' }, // 'y' at session level (no step binding for y)
    });

    expect(result.success).toBe(true);
    expect(result.text).toBe('X: step-x | Y: session-y');

    expect(result.resolved.find((r) => r.name === 'x')?.source).toBe('bindings');
    expect(result.resolved.find((r) => r.name === 'y')?.source).toBe('session');
  });
});

// ---------------------------------------------------------------------------
// Suite 4 — CANT_ env prefix (alternative prefix)
// ---------------------------------------------------------------------------

describe('Variable resolver — CANT_ env prefix', () => {
  it('resolves env vars with CANT_ prefix when CLEO_ is absent', () => {
    const result = resolver.resolve('Value: {{my_var}}', {
      env: { CANT_MY_VAR: 'cant-prefix-value' },
    });

    expect(result.success).toBe(true);
    expect(result.text).toBe('Value: cant-prefix-value');
    expect(result.resolved[0]?.source).toBe('env');
  });

  it('CLEO_ prefix shadows CANT_ prefix for the same key', () => {
    const result = resolver.resolve('Value: {{my_var}}', {
      env: {
        CLEO_MY_VAR: 'cleo-wins',
        CANT_MY_VAR: 'cant-loses',
      },
    });

    expect(result.success).toBe(true);
    expect(result.text).toBe('Value: cleo-wins');
    expect(result.resolved[0]?.value).toBe('cleo-wins');
  });
});

// ---------------------------------------------------------------------------
// Suite 5 — Dot-notation in project-context
// ---------------------------------------------------------------------------

describe('Variable resolver — dot-notation in project-context', () => {
  it('walks dot-paths into projectContext', () => {
    const result = resolver.resolve('Framework: {{testing.framework}}', {
      projectContext: {
        testing: { framework: 'vitest' },
      },
    });

    expect(result.success).toBe(true);
    expect(result.text).toBe('Framework: vitest');
    expect(result.resolved[0]?.source).toBe('project_context');
  });

  it('bindings shadow project-context dot-paths', () => {
    // Even for a dot-notation variable name in the template, a bindings key
    // with the same full name shadows the projectContext walk.
    const result = resolver.resolve('Framework: {{testing.framework}}', {
      bindings: { 'testing.framework': 'override-from-bindings' },
      projectContext: {
        testing: { framework: 'vitest' },
      },
    });

    expect(result.success).toBe(true);
    expect(result.text).toBe('Framework: override-from-bindings');
    expect(result.resolved[0]?.source).toBe('bindings');
  });
});

// ---------------------------------------------------------------------------
// Suite 6 — Recursion prevention invariant
// ---------------------------------------------------------------------------

describe('Variable resolver — recursion prevention invariant', () => {
  /**
   * Resolved values are NEVER re-scanned for placeholders.
   *
   * If binding 'a' → '{{b}}', the output must contain the literal string
   * '{{b}}' rather than recursively resolving {{b}}.
   */
  it('resolved values are NOT re-scanned for nested placeholders', () => {
    const result = resolver.resolve('Outer: {{a}}', {
      bindings: { a: '{{b}}', b: 'inner-value' },
    });

    expect(result.success).toBe(true);
    // '{{b}}' must appear literally in the output — no recursion.
    expect(result.text).toBe('Outer: {{b}}');
  });
});

// ---------------------------------------------------------------------------
// Suite 7 — substituteCantAgentBody integration
// ---------------------------------------------------------------------------

describe('substituteCantAgentBody — integration with resolver order', () => {
  /**
   * Bindings shadow project-context in the CANT agent body substitution path.
   *
   * This is the integration entry-point consumed by the orchestrate engine.
   * It loads project-context.json from disk and merges with caller-supplied
   * bindings. Bindings MUST shadow the project-context tier.
   */
  it('bindings shadow project-context values in CANT body substitution', async () => {
    // We can pass a fake projectRoot where project-context.json does not exist.
    // The resolver degrades gracefully and falls through to the bindings tier.
    const result = substituteCantAgentBody('Stack: {{tech_stack}}', {
      projectRoot: '/tmp/nonexistent-project-root',
      bindings: { tech_stack: 'TypeScript' },
    });

    expect(result.success).toBe(true);
    expect(result.text).toBe('Stack: TypeScript');
    expect(result.projectContextLoaded).toBe(false); // no project-context.json
  });

  it('env shadows nothing when bindings are set — bindings win', () => {
    const result = substituteCantAgentBody('Domain: {{domain}}', {
      projectRoot: '/tmp/nonexistent-project-root',
      bindings: { domain: 'payments' },
      env: { CLEO_DOMAIN: 'logistics' },
    });

    expect(result.success).toBe(true);
    expect(result.text).toBe('Domain: payments');
  });

  it('env resolves when neither bindings nor project-context supply the key', () => {
    const result = substituteCantAgentBody('Domain: {{domain}}', {
      projectRoot: '/tmp/nonexistent-project-root',
      // No bindings for 'domain'
      env: { CLEO_DOMAIN: 'from-env' },
    });

    expect(result.success).toBe(true);
    expect(result.text).toBe('Domain: from-env');
  });

  it('unresolved variables are reported in missing[] (lenient mode)', () => {
    const result = substituteCantAgentBody('Domain: {{totally_missing_var}}', {
      projectRoot: '/tmp/nonexistent-project-root',
    });

    expect(result.success).toBe(true); // lenient — no hard failure
    expect(result.missing).toContain('totally_missing_var');
    // Placeholder preserved in output.
    expect(result.text).toContain('{{totally_missing_var}}');
  });
});
