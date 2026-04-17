/**
 * W4-9 HITL auto-policy tests. Pure-function — no DB, no mocks needed.
 *
 * @task T889 / T908 / W4-9
 */

import { describe, expect, it } from 'vitest';
import { DEFAULT_POLICY_RULES, evaluatePolicy, type PolicyRule } from '../policy.js';

describe('W4-9: evaluatePolicy — conservative defaults', () => {
  it('npm publish → require-human, reason=publish', () => {
    const r = evaluatePolicy('npm publish --access public');
    expect(r.action).toBe('require-human');
    expect(r.reason).toBe('publish');
  });

  it('pnpm test → auto-approve, reason=safe-qa-tool', () => {
    const r = evaluatePolicy('pnpm test');
    expect(r.action).toBe('auto-approve');
    expect(r.reason).toBe('safe-qa-tool');
  });

  it('rm -rf / → require-human, reason=destructive', () => {
    const r = evaluatePolicy('rm -rf /');
    expect(r.action).toBe('require-human');
    expect(r.reason).toBe('destructive');
  });

  it('cleo show T123 → auto-approve, reason=safe-cleo-read', () => {
    const r = evaluatePolicy('cleo show T123');
    expect(r.action).toBe('auto-approve');
    expect(r.reason).toBe('safe-cleo-read');
  });

  it('git push origin main → require-human, reason=push', () => {
    const r = evaluatePolicy('git push origin main');
    expect(r.action).toBe('require-human');
    expect(r.reason).toBe('push');
  });

  it('git tag v1.0.0 → require-human, reason=tag', () => {
    const r = evaluatePolicy('git tag v1.0.0');
    expect(r.action).toBe('require-human');
    expect(r.reason).toBe('tag');
  });

  it('gh release create → require-human, reason=release', () => {
    const r = evaluatePolicy('gh release create v2026.4.86 --notes "..."');
    expect(r.action).toBe('require-human');
    expect(r.reason).toBe('release');
  });

  it('unknown command → require-human, reason=default', () => {
    const r = evaluatePolicy('some-random-binary --weird-flag');
    expect(r.action).toBe('require-human');
    expect(r.reason).toBe('default');
    expect(r.matchedPattern).toBeUndefined();
  });

  it('curl https://api.example.com → require-human, reason=external-api', () => {
    const r = evaluatePolicy('curl -X POST https://api.example.com/v1/webhook');
    expect(r.action).toBe('require-human');
    expect(r.reason).toBe('external-api');
  });

  it('require-human rules cannot be bypassed by a later auto-approve override', () => {
    const custom: PolicyRule[] = [
      { pattern: /git/, action: 'auto-approve', reason: 'custom-git-allow' },
      ...DEFAULT_POLICY_RULES,
    ];
    const r = evaluatePolicy('git push origin main', custom);
    expect(r.action).toBe('require-human');
    expect(r.reason).toBe('push');
  });

  it('pnpm biome + pnpm tsc also auto-approve as safe-qa-tool', () => {
    expect(evaluatePolicy('pnpm biome ci .').action).toBe('auto-approve');
    expect(evaluatePolicy('pnpm tsc --noEmit').action).toBe('auto-approve');
  });

  it('exposes matchedPattern on hits', () => {
    const r = evaluatePolicy('pnpm publish');
    expect(r.action).toBe('require-human');
    expect(r.matchedPattern).toBeDefined();
    expect(typeof r.matchedPattern).toBe('string');
  });

  it('DEFAULT_POLICY_RULES is frozen so callers cannot mutate the defaults', () => {
    expect(Object.isFrozen(DEFAULT_POLICY_RULES)).toBe(true);
  });
});
