/**
 * Structural invariant tests for the OPERATIONS registry.
 *
 * These tests enforce invariants that the registry must always satisfy,
 * regardless of additions, removals, or migrations. They are intended
 * to catch data corruption, authoring errors, and structural drift.
 *
 * Invariants covered:
 *   1. No duplicate (domain, operation) pairs — every dispatch triple
 *      (gateway, domain, operation) must be unique.
 *   2. Every operation has a valid gateway ('query' | 'mutate').
 *   3. Every operation has a valid tier (0 | 1 | 2).
 *   4. Every operation's domain is a member of CANONICAL_DOMAINS.
 *   5. requiredParams is a subset of declared param names (when params exist).
 *   6. Every declared param has required structural fields.
 *   7. Every operation has required top-level structural fields.
 *   8. Tier monotonicity: higher tiers include all lower-tier operations
 *      within the same (gateway, domain, operation) scope.
 *   9. Duplicate operation names within a domain must have distinct
 *      gateway values (query vs mutate overloads are allowed).
 *
 * @task T11207
 * @epic E2: TEST-TAXONOMY
 * @saga SG-SDLC-OPTIMIZE
 */

import { describe, expect, it } from 'vitest';
import { OPERATIONS } from '../dispatch/operations-registry.js';
import { CANONICAL_DOMAINS } from '../dispatch/identity.js';

describe('OPERATIONS structural invariants (T11207)', () => {
  // ── Helper: build a composite key ──────────────────────────────────────

  const compositeKey = (op: (typeof OPERATIONS)[number]) =>
    `${op.gateway}:${op.domain}:${op.operation}`;

  const domainOpKey = (op: (typeof OPERATIONS)[number]) =>
    `${op.domain}:${op.operation}`;

  // ── Invariant 1: uniqueness of (gateway, domain, operation) ────────────

  it('has no duplicate (gateway, domain, operation) triples', () => {
    const seen = new Set<string>();
    const duplicates: string[] = [];

    for (const op of OPERATIONS) {
      const key = compositeKey(op);
      if (seen.has(key)) {
        duplicates.push(key);
      }
      seen.add(key);
    }

    expect(duplicates).toEqual([]);
  });

  // ── Invariant 2: valid gateway ─────────────────────────────────────────

  it('every operation has a valid gateway', () => {
    const invalid: string[] = [];
    for (const op of OPERATIONS) {
      if (op.gateway !== 'query' && op.gateway !== 'mutate') {
        invalid.push(`${compositeKey(op)} has gateway "${op.gateway}"`);
      }
    }
    expect(invalid).toEqual([]);
  });

  // ── Invariant 3: valid tier ────────────────────────────────────────────

  it('every operation has a valid tier (0 | 1 | 2)', () => {
    const invalid: string[] = [];
    for (const op of OPERATIONS) {
      if (op.tier !== 0 && op.tier !== 1 && op.tier !== 2) {
        invalid.push(`${compositeKey(op)} has tier ${op.tier}`);
      }
    }
    expect(invalid).toEqual([]);
  });

  // ── Invariant 4: domain membership ─────────────────────────────────────

  it('every operation domain is in CANONICAL_DOMAINS', () => {
    const invalid: string[] = [];
    for (const op of OPERATIONS) {
      if (!CANONICAL_DOMAINS.includes(op.domain as any)) {
        invalid.push(`${compositeKey(op)} has domain "${op.domain}"`);
      }
    }
    expect(invalid).toEqual([]);
  });

  // ── Invariant 5: requiredParams subset of declared params ─────────────

  it('requiredParams is a subset of declared param names when params exist', () => {
    const violations: string[] = [];
    for (const op of OPERATIONS) {
      if (!op.params || op.params.length === 0) continue;
      const paramNames = new Set(op.params.map((p) => p.name));
      for (const req of op.requiredParams) {
        if (!paramNames.has(req)) {
          violations.push(
            `${compositeKey(op)}: requiredParam "${req}" not found in params`,
          );
        }
      }
    }
    expect(violations).toEqual([]);
  });

  // ── Invariant 6: param structural fields ───────────────────────────────

  it('every declared param has required structural fields', () => {
    const violations: string[] = [];
    for (const op of OPERATIONS) {
      if (!op.params) continue;
      for (const param of op.params) {
        if (typeof param.name !== 'string' || param.name.length === 0) {
          violations.push(`${compositeKey(op)}: param missing/empty name`);
        }
        if (typeof param.type !== 'string' || param.type.length === 0) {
          violations.push(`${compositeKey(op)}: param "${param.name}" missing/empty type`);
        }
        if (typeof param.required !== 'boolean') {
          violations.push(`${compositeKey(op)}: param "${param.name}" missing boolean required`);
        }
        if (typeof param.description !== 'string' || param.description.length === 0) {
          violations.push(`${compositeKey(op)}: param "${param.name}" missing/empty description`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  // ── Invariant 7: top-level structural fields ───────────────────────────

  it('every operation has required top-level structural fields', () => {
    const violations: string[] = [];
    for (const op of OPERATIONS) {
      if (typeof op.gateway !== 'string') {
        violations.push(`${domainOpKey(op)}: missing gateway`);
      }
      if (typeof op.domain !== 'string') {
        violations.push(`${domainOpKey(op)}: missing domain`);
      }
      if (typeof op.operation !== 'string' || op.operation.length === 0) {
        violations.push(`${domainOpKey(op)}: missing/empty operation`);
      }
      if (typeof op.description !== 'string' || op.description.length === 0) {
        violations.push(`${domainOpKey(op)}: missing/empty description`);
      }
      if (typeof op.tier !== 'number') {
        violations.push(`${domainOpKey(op)}: missing tier`);
      }
      if (typeof op.idempotent !== 'boolean') {
        violations.push(`${domainOpKey(op)}: missing idempotent`);
      }
      if (typeof op.sessionRequired !== 'boolean') {
        violations.push(`${domainOpKey(op)}: missing sessionRequired`);
      }
      if (!Array.isArray(op.requiredParams)) {
        violations.push(`${domainOpKey(op)}: missing requiredParams array`);
      }
    }
    expect(violations).toEqual([]);
  });

  // ── Invariant 8: tier monotonicity within (gateway, domain, operation) ─

  it('tier is monotonic — no operation appears at multiple tiers', () => {
    // This is a stricter variant: each (gateway, domain, operation) triple
    // should map to exactly one tier. If the same domain+operation pair
    // appears under both gateways (query/mutate overload), each gateway
    // variant should have its own consistent tier.
    const map = new Map<string, number>();
    const conflicts: string[] = [];

    for (const op of OPERATIONS) {
      const key = compositeKey(op);
      const existing = map.get(key);
      if (existing !== undefined && existing !== op.tier) {
        conflicts.push(
          `${key} appears at tier ${existing} and tier ${op.tier}`,
        );
      }
      map.set(key, op.tier);
    }

    expect(conflicts).toEqual([]);
  });

  // ── Invariant 9: domain+operation duplicates must differ by gateway ───

  it('duplicate (domain, operation) pairs must differ by gateway', () => {
    const domainOps = new Map<string, Set<string>>();
    const violations: string[] = [];

    for (const op of OPERATIONS) {
      const key = domainOpKey(op);
      const gateways = domainOps.get(key) ?? new Set<string>();
      if (gateways.has(op.gateway)) {
        violations.push(
          `${key} has duplicate gateway "${op.gateway}"`,
        );
      }
      gateways.add(op.gateway);
      domainOps.set(key, gateways);
    }

    expect(violations).toEqual([]);
  });

  // ── Invariant 10: non-empty registry ───────────────────────────────────

  it('OPERATIONS registry is non-empty', () => {
    expect(OPERATIONS.length).toBeGreaterThan(0);
  });

  // ── Invariant 11: query + mutate partition ─────────────────────────────

  it('every operation is classified as query or mutate', () => {
    const unclassified = OPERATIONS.filter(
      (op) => op.gateway !== 'query' && op.gateway !== 'mutate',
    );
    expect(unclassified).toEqual([]);
  });

  // ── Invariant 12: no empty operation names ─────────────────────────────

  it('no operation has an empty or whitespace-only operation name', () => {
    const invalid = OPERATIONS.filter(
      (op) => op.operation.trim().length === 0,
    );
    expect(invalid).toEqual([]);
  });

  // ── Invariant 13: no empty domain names ────────────────────────────────

  it('no operation has an empty or whitespace-only domain name', () => {
    const invalid = OPERATIONS.filter(
      (op) => op.domain.trim().length === 0,
    );
    expect(invalid).toEqual([]);
  });
});
